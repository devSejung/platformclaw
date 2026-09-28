import { randomUUID } from "node:crypto";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  activeWikiOrganizations,
  effectiveWikiRoles,
  reconcileWikiAccess,
  recordWikiAudit,
  requireWikiRole,
} from "./knowledge-vault-access.js";
import type {
  KnowledgeVaultAccessRequest,
  KnowledgeVaultGrantTarget,
  KnowledgeVaultRole,
  KnowledgeVaultSnapshot,
} from "./knowledge-vault-contracts.js";
import {
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import { SqliteKnowledgeVaultCore } from "./sqlite-knowledge-vault-core.js";

export abstract class SqliteKnowledgeVaultSharingStore extends SqliteKnowledgeVaultCore {
  override snapshot(params: { userId: string; vaultId?: string }): KnowledgeVaultSnapshot {
    this.activeUser(params.userId);
    return runReadTransaction(this.db, () => this.sharingSnapshot(params));
  }
  private sharingSnapshot(params: { userId: string; vaultId?: string }): KnowledgeVaultSnapshot {
    const snapshot = super.snapshot(params);
    const roles = effectiveWikiRoles(this.db);
    const base = this.query
      .selectFrom("knowledge_vault_access_requests as request")
      .innerJoin("knowledge_vaults as vault", "vault.id", "request.vault_id")
      .innerJoin("platform_users as user", "user.id", "request.user_id")
      .selectAll("request")
      .select(["vault.name as vault_name", "user.account_id", "user.display_name"])
      .orderBy("request.created_at", "desc")
      .orderBy("request.id")
      .limit(50);
    const requests = executeSync(this.db, base.where("request.user_id", "=", params.userId)).rows;
    const owned = [...roles]
      .filter(([, members]) => members.get(params.userId) === "owner")
      .map(([id]) => id);
    const pending = owned.length
      ? executeSync(
          this.db,
          base.where("request.status", "=", "pending").where("request.vault_id", "in", owned),
        ).rows
      : [];
    const project = (row: (typeof requests)[number]): KnowledgeVaultAccessRequest => ({
      id: row.id,
      vaultId: row.vault_id,
      vaultName: row.vault_name,
      userId: row.user_id,
      accountId: row.account_id,
      displayName: row.display_name ?? row.account_id,
      role: row.role,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    });
    snapshot.ownRequests = requests.map(project);
    snapshot.pendingRequests = pending.map(project);
    if (snapshot.selected?.vault.canManageMembers) {
      snapshot.selected.grants = executeSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_organization_grants as grant")
          .innerJoin("managed_scopes as scope", "scope.id", "grant.scope_id")
          .select(["scope.id", "scope.name", "scope.kind", "grant.role"])
          .where("grant.vault_id", "=", snapshot.selected.vault.id)
          .orderBy("scope.name"),
      ).rows.map((row) => ({
        scopeId: row.id,
        scopeName: row.name,
        scopeKind: row.kind,
        role: row.role,
      }));
    }
    return snapshot;
  }

  private requireManagementOrRecovery(userId: string, vaultId: string): void {
    const vault = this.listVaults(userId).find((item) => item.id === vaultId);
    if (!vault || (!vault.canManageMembers && !vault.canRecoverOwner)) {
      throw new ControlPlaneAuthorizationError("Wiki management is unavailable");
    }
  }
  recoverOwner(params: { userId: string; vaultId: string; accountId: string }): void {
    this.activeUser(params.userId);
    runImmediateTransaction(this.db, () => {
      const vault = this.listVaults(params.userId).find((item) => item.id === params.vaultId);
      if (!vault?.canRecoverOwner) {
        throw new ControlPlaneAuthorizationError(
          "Only an administrator may explicitly recover an ownerless Wiki",
        );
      }
      const target = takeFirstSync(
        this.db,
        this.query
          .selectFrom("platform_users")
          .select("id")
          .where("account_id", "=", params.accountId.trim().toLowerCase())
          .where("status", "=", "active"),
      );
      if (!target) {
        throw new ControlPlaneStateError("Choose an active employee");
      }
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_members")
          .values({ vault_id: params.vaultId, user_id: target.id, role: "owner", can_export: 1 })
          .onConflict((oc) =>
            oc.columns(["vault_id", "user_id"]).doUpdateSet({ role: "owner", can_export: 1 }),
          ),
      );
      reconcileWikiAccess(this.db, params.vaultId);
      recordWikiAudit(this.db, params.userId, "wiki.owner.recovered", params.vaultId, {
        userId: target.id,
      });
    });
  }

  searchGrantTargets(params: {
    userId: string;
    vaultId: string;
    kind: "user" | "organization";
    query: string;
  }): { items: KnowledgeVaultGrantTarget[]; hasMore: boolean } {
    this.requireManagementOrRecovery(params.userId, params.vaultId);
    if (params.query.length > 160) {
      throw new ControlPlaneStateError("Target search exceeds 160 characters");
    }
    const needle = params.query.trim().toLowerCase();
    const scopes = activeWikiOrganizations(this.db);
    const scopeNames = new Map(scopes.map((scope) => [scope.id, scope.name]));
    const matches: KnowledgeVaultGrantTarget[] =
      params.kind === "organization"
        ? scopes.map((scope) => ({
            id: scope.id,
            label: scope.name,
            detail: `${scope.parent_scope_id ? scopeNames.get(scope.parent_scope_id) + " / " : ""}${scope.name} (${scope.kind}; direct members only)`,
          }))
        : executeSync(
            this.db,
            this.query
              .selectFrom("platform_users")
              .select(["id", "account_id", "display_name"])
              .where("status", "=", "active")
              .orderBy("account_id"),
          ).rows.map((user) => ({
            id: user.id,
            label: user.display_name ?? user.account_id,
            detail: user.account_id,
            accountId: user.account_id,
          }));
    const filtered = matches
      .filter((item) => `${item.label} ${item.detail}`.toLowerCase().includes(needle))
      .toSorted(
        (left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id),
      );
    return { items: filtered.slice(0, 20), hasMore: filtered.length > 20 };
  }

  setOrganizationGrant(params: {
    userId: string;
    vaultId: string;
    scopeId: string;
    role: KnowledgeVaultRole;
  }): void {
    this.ensure();
    const role = requireWikiRole(params.role);
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      if (!activeWikiOrganizations(this.db).some((scope) => scope.id === params.scopeId)) {
        throw new ControlPlaneStateError("Choose an active organization");
      }
      executeSync(
        this.db,
        this.query
          .insertInto("knowledge_vault_organization_grants")
          .values({ vault_id: params.vaultId, scope_id: params.scopeId, role })
          .onConflict((oc) => oc.columns(["vault_id", "scope_id"]).doUpdateSet({ role })),
      );
      reconcileWikiAccess(this.db, params.vaultId);
      recordWikiAudit(this.db, params.userId, "wiki.organization.granted", params.vaultId, {
        scopeId: params.scopeId,
        role,
      });
    });
  }

  removeOrganizationGrant(params: { userId: string; vaultId: string; scopeId: string }): void {
    this.ensure();
    runImmediateTransaction(this.db, () => {
      this.access(params.userId, params.vaultId, "owner");
      executeSync(
        this.db,
        this.query
          .deleteFrom("knowledge_vault_organization_grants")
          .where("vault_id", "=", params.vaultId)
          .where("scope_id", "=", params.scopeId),
      );
      reconcileWikiAccess(this.db, params.vaultId);
      recordWikiAudit(this.db, params.userId, "wiki.organization.removed", params.vaultId, {
        scopeId: params.scopeId,
      });
    });
  }

  requestAccess(params: {
    userId: string;
    vaultId: string;
    role: "reader" | "editor";
    reason?: string;
  }): void {
    this.activeUser(params.userId);
    if (params.role !== "reader" && params.role !== "editor") {
      throw new ControlPlaneStateError("Request Reader or Editor access");
    }
    const reason = (params.reason ?? "").trim();
    if (reason.length > 1000) {
      throw new ControlPlaneStateError("Request reason exceeds 1000 characters");
    }
    runImmediateTransaction(this.db, () => {
      if (
        !takeFirstSync(
          this.db,
          this.query.selectFrom("knowledge_vaults").select("id").where("id", "=", params.vaultId),
        )
      ) {
        throw new ControlPlaneStateError("Wiki is unavailable");
      }
      const role = effectiveWikiRoles(this.db).get(params.vaultId)?.get(params.userId);
      if (role && (role !== "reader" || params.role === "reader")) {
        throw new ControlPlaneStateError("You already have the requested access");
      }
      if (
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_access_requests")
            .select("id")
            .where("vault_id", "=", params.vaultId)
            .where("user_id", "=", params.userId)
            .where("status", "=", "pending"),
        )
      ) {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "An access request is already pending",
        );
      }
      const id = randomUUID();
      executeSync(
        this.db,
        this.query.insertInto("knowledge_vault_access_requests").values({
          id,
          vault_id: params.vaultId,
          user_id: params.userId,
          role: params.role,
          reason,
          status: "pending",
          created_at: Date.now(),
          decided_at: null,
          decided_by_user_id: null,
        }),
      );
      recordWikiAudit(this.db, params.userId, "wiki.access.requested", params.vaultId, {
        requestId: id,
        role: params.role,
      });
    });
  }

  decideAccess(params: {
    userId: string;
    requestId: string;
    decision: "approve" | "reject" | "cancel";
  }): void {
    this.activeUser(params.userId);
    runImmediateTransaction(this.db, () => {
      const request = takeFirstSync(
        this.db,
        this.query
          .selectFrom("knowledge_vault_access_requests")
          .selectAll()
          .where("id", "=", params.requestId),
      );
      if (!request) {
        throw new ControlPlaneStateError("Access request unavailable");
      }
      if (params.decision === "cancel") {
        if (request.user_id !== params.userId) {
          throw new ControlPlaneAuthorizationError("Only the requester can cancel this request");
        }
      } else {
        this.access(params.userId, request.vault_id, "owner");
      }
      if (request.status !== "pending") {
        throw new ControlPlaneConflictError(
          "knowledge_vault_changed",
          "Access request already decided",
        );
      }
      if (params.decision === "approve") {
        this.activeUser(request.user_id);
        const prior = takeFirstSync(
          this.db,
          this.query
            .selectFrom("knowledge_vault_members")
            .select("role")
            .where("vault_id", "=", request.vault_id)
            .where("user_id", "=", request.user_id),
        );
        const role =
          prior?.role === "owner" || prior?.role === "editor" ? prior.role : request.role;
        executeSync(
          this.db,
          this.query
            .insertInto("knowledge_vault_members")
            .values({
              vault_id: request.vault_id,
              user_id: request.user_id,
              role,
              can_export: Number(role !== "reader"),
            })
            .onConflict((oc) =>
              oc
                .columns(["vault_id", "user_id"])
                .doUpdateSet({ role, can_export: Number(role !== "reader") }),
            ),
        );
        reconcileWikiAccess(this.db);
      }
      const status =
        params.decision === "approve"
          ? "approved"
          : params.decision === "reject"
            ? "rejected"
            : "cancelled";
      executeSync(
        this.db,
        this.query
          .updateTable("knowledge_vault_access_requests")
          .set({ status, decided_at: Date.now(), decided_by_user_id: params.userId })
          .where("id", "=", request.id),
      );
      recordWikiAudit(this.db, params.userId, `wiki.access.${status}`, request.vault_id, {
        requestId: request.id,
        userId: request.user_id,
        role: request.role,
      });
    });
  }
}
