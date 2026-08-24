import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneStateError,
  type ManagedScope,
  type ManagedScopeMember,
  type ManagedScopeMembership,
  type OrganizationAuditRecord,
} from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
import { prepareOrganizationAuthorizationContext } from "./organization-policy.js";
import { normalizeScopeName, rowToMembership, rowToScope } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationMemoryLifecycleStore } from "./sqlite-store-organization-memory-lifecycle-actions.js";

export abstract class SqliteControlPlaneOrganizationAccessStore extends SqliteControlPlaneOrganizationMemoryLifecycleStore {
  async listManagedScopes(): Promise<ManagedScope[]> {
    return executeSync(
      this.db,
      this.query
        .selectFrom("managed_scopes")
        .selectAll()
        .orderBy("kind")
        .orderBy("normalized_name"),
    ).rows.map(rowToScope);
  }

  async searchOrganizationScopesForUser(params: { userId: string; query: string; limit: number }) {
    return runReadTransaction(this.db, () => {
      const user = this.requireUserRow(params.userId);
      if (user.status !== "active") {
        throw new ControlPlaneAuthorizationError("active user required");
      }
      const limit = Math.max(1, Math.min(Math.trunc(params.limit), 101));
      let query = this.query
        .selectFrom("managed_scopes as scope")
        .leftJoin("managed_scopes as parent", "parent.id", "scope.parent_scope_id")
        .leftJoin("managed_scopes as grandparent", "grandparent.id", "parent.parent_scope_id")
        .selectAll("scope")
        .select([
          "parent.id as parent_id",
          "parent.kind as parent_kind",
          "parent.name as parent_name",
          "parent.parent_scope_id as parent_parent_scope_id",
          "parent.status as parent_status",
          "parent.created_by_user_id as parent_created_by_user_id",
          "parent.created_at as parent_created_at",
          "parent.updated_at as parent_updated_at",
          "grandparent.id as grandparent_id",
          "grandparent.kind as grandparent_kind",
          "grandparent.name as grandparent_name",
          "grandparent.parent_scope_id as grandparent_parent_scope_id",
          "grandparent.status as grandparent_status",
          "grandparent.created_by_user_id as grandparent_created_by_user_id",
          "grandparent.created_at as grandparent_created_at",
          "grandparent.updated_at as grandparent_updated_at",
        ])
        .where("scope.status", "=", "active")
        .where((expression) =>
          expression.or([
            expression.and([
              expression("scope.kind", "=", "team"),
              expression("scope.parent_scope_id", "is", null),
            ]),
            expression.and([
              expression("scope.kind", "=", "group"),
              expression("parent.kind", "=", "team"),
              expression("parent.status", "=", "active"),
              expression("parent.parent_scope_id", "is", null),
            ]),
            expression.and([
              expression("scope.kind", "=", "part"),
              expression("parent.kind", "=", "group"),
              expression("parent.status", "=", "active"),
              expression("grandparent.kind", "=", "team"),
              expression("grandparent.status", "=", "active"),
              expression("grandparent.parent_scope_id", "is", null),
            ]),
          ]),
        );
      const rawNeedle = params.query.trim();
      const needle = rawNeedle ? normalizeScopeName(rawNeedle) : "";
      if (needle) {
        const pattern = `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        query = query.where(sql<boolean>`scope.normalized_name LIKE ${pattern} ESCAPE '\\'`);
      }
      const scopes = executeSync(
        this.db,
        query.orderBy("scope.normalized_name").orderBy("scope.id").limit(limit),
      ).rows;
      if (scopes.length === 0) {
        return [];
      }
      const lineageScopes = new Map<string, ManagedScope>();
      for (const row of scopes) {
        const selected = rowToScope(row);
        lineageScopes.set(selected.id, selected);
        if (
          row.parent_id &&
          row.parent_kind &&
          row.parent_name &&
          row.parent_status &&
          row.parent_created_by_user_id &&
          row.parent_created_at !== null &&
          row.parent_updated_at !== null
        ) {
          lineageScopes.set(row.parent_id, {
            id: row.parent_id,
            kind: row.parent_kind,
            name: row.parent_name,
            ...(row.parent_parent_scope_id ? { parentScopeId: row.parent_parent_scope_id } : {}),
            status: row.parent_status,
            createdByUserId: row.parent_created_by_user_id,
            createdAt: row.parent_created_at,
            updatedAt: row.parent_updated_at,
          });
        }
        if (
          row.grandparent_id &&
          row.grandparent_kind &&
          row.grandparent_name &&
          row.grandparent_status &&
          row.grandparent_created_by_user_id &&
          row.grandparent_created_at !== null &&
          row.grandparent_updated_at !== null
        ) {
          lineageScopes.set(row.grandparent_id, {
            id: row.grandparent_id,
            kind: row.grandparent_kind,
            name: row.grandparent_name,
            ...(row.grandparent_parent_scope_id
              ? { parentScopeId: row.grandparent_parent_scope_id }
              : {}),
            status: row.grandparent_status,
            createdByUserId: row.grandparent_created_by_user_id,
            createdAt: row.grandparent_created_at,
            updatedAt: row.grandparent_updated_at,
          });
        }
      }
      const lineageScopeIds = [...lineageScopes.keys()];
      const actorMemberships = executeSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships")
          .selectAll()
          .where("user_id", "=", user.id)
          .where("scope_id", "in", lineageScopeIds),
      ).rows.map(rowToMembership);
      const directScopeIds = new Set(actorMemberships.map((membership) => membership.scopeId));
      const authorization = prepareOrganizationAuthorizationContext({
        actor: this.rowToUser(user),
        scopes: [...lineageScopes.values()],
        memberships: actorMemberships,
      });
      const pendingScopeIds = new Set(
        executeSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .select("scope_id")
            .where("user_id", "=", user.id)
            .where("status", "=", "pending")
            .where(
              "scope_id",
              "in",
              scopes.map((scope) => scope.id),
            ),
        ).rows.map((row) => row.scope_id),
      );
      return scopes.map((scope) => {
        const managedScope = rowToScope(scope);
        const scopeAuthorization = authorization.authorize(managedScope);
        return {
          scope: managedScope,
          lineage: authorization.lineage(managedScope).toReversed(),
          capabilities: {
            canManageMembers: scopeAuthorization.canManageMembers,
            canManageStructure: scopeAuthorization.canManageStructure,
            canManageLeaders: scopeAuthorization.canManageLeaders,
          },
          requestEligible: !directScopeIds.has(scope.id) && !pendingScopeIds.has(scope.id),
        };
      });
    });
  }

  async listManagedScopeMemberships(scopeId: string): Promise<ManagedScopeMembership[]> {
    this.requireScopeRow(scopeId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .selectAll()
        .where("scope_id", "=", scopeId)
        .orderBy("role")
        .orderBy("user_id"),
    ).rows.map(rowToMembership);
  }

  async listAuthorizedManagedScopeMembers(params: {
    actorUserId: string;
    scopeId: string;
    limit?: number;
    offset?: number;
  }): Promise<ManagedScopeMember[]> {
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 200))
      : 100;
    const offset = Number.isFinite(params.offset)
      ? Math.max(0, Math.min(Math.trunc(params.offset!), 10_000))
      : 0;
    return runReadTransaction(this.db, () => {
      const authorization = this.resolveOrganizationAuthorizationSnapshot(
        params.actorUserId,
        params.scopeId,
      );
      if (!authorization.canManageMembers) {
        throw new ControlPlaneAuthorizationError("not allowed to view memberships for this scope");
      }
      const memberships = executeSync(
        this.db,
        this.query
          .selectFrom("managed_scope_memberships")
          .innerJoin("platform_users", "platform_users.id", "managed_scope_memberships.user_id")
          .selectAll("managed_scope_memberships")
          .select([
            "platform_users.account_id as user_account_id",
            "platform_users.display_name as user_display_name",
            "platform_users.status as user_status",
          ])
          .where("managed_scope_memberships.scope_id", "=", params.scopeId)
          .orderBy("managed_scope_memberships.role")
          .orderBy("managed_scope_memberships.user_id")
          .limit(limit)
          .offset(offset),
      ).rows;
      return memberships.map((membership) => ({
        membership: rowToMembership(membership),
        user: {
          id: membership.user_id,
          accountId: membership.user_account_id,
          status: membership.user_status,
          ...(membership.user_display_name ? { displayName: membership.user_display_name } : {}),
        },
      }));
    });
  }

  async searchAuthorizedOrganizationUsers(params: {
    actorUserId: string;
    scopeId: string;
    query: string;
    limit: number;
  }) {
    const limit = Math.max(1, Math.min(Math.trunc(params.limit), 101));
    return runReadTransaction(this.db, () => {
      const authorization = this.resolveOrganizationAuthorizationSnapshot(
        params.actorUserId,
        params.scopeId,
      );
      if (!authorization.canManageMembers) {
        throw new ControlPlaneAuthorizationError("not allowed to search organization users");
      }
      const needle = params.query.trim();
      if (needle.length < 2 || needle.length > 128) {
        throw new ControlPlaneStateError("user search query must contain 2-128 characters");
      }
      let query = this.query
        .selectFrom("platform_users")
        .leftJoin("managed_scope_memberships as existing_membership", (join) =>
          join
            .onRef("existing_membership.user_id", "=", "platform_users.id")
            .on("existing_membership.scope_id", "=", params.scopeId),
        )
        .select([
          "platform_users.id",
          "platform_users.account_id",
          "platform_users.display_name",
          "platform_users.status",
          "existing_membership.role as current_role",
        ])
        .where("status", "=", "active");
      const pattern = `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      query = query.where(
        sql<boolean>`(account_id LIKE ${pattern} ESCAPE '\\' OR display_name LIKE ${pattern} ESCAPE '\\')`,
      );
      return executeSync(this.db, query.orderBy("account_id").orderBy("id").limit(limit)).rows.map(
        (user) => {
          const result = {
            id: user.id,
            accountId: user.account_id,
            status: user.status,
            displayName: user.display_name ?? undefined,
            currentRole: user.current_role ?? undefined,
          };
          return result;
        },
      );
    });
  }

  async listAuthorizedOrganizationAuditEvents(params: {
    actorUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationAuditRecord[]> {
    const limit = Number.isFinite(params.limit)
      ? Math.max(1, Math.min(Math.trunc(params.limit!), 200))
      : 100;
    const offset = Number.isFinite(params.offset)
      ? Math.max(0, Math.min(Math.trunc(params.offset!), 10_000))
      : 0;
    return runReadTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      return executeSync(
        this.db,
        this.query
          .selectFrom("control_audit_events")
          .leftJoin("platform_users", "platform_users.id", "control_audit_events.actor_user_id")
          .selectAll("control_audit_events")
          .select([
            "platform_users.id as actor_id",
            "platform_users.display_name as actor_display_name",
          ])
          .where((expression) =>
            expression.or([
              expression("event_type", "like", "organization.%"),
              expression("event_type", "like", "scope.%"),
            ]),
          )
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(limit)
          .offset(offset),
      ).rows.map((row) => {
        const details = row.details_json
          ? (JSON.parse(row.details_json) as Record<string, unknown>)
          : undefined;
        const rawOutcome = details?.outcome;
        const outcome: OrganizationAuditRecord["outcome"] =
          rawOutcome === "succeeded" || rawOutcome === "denied" ? rawOutcome : undefined;
        const reason = details?.reason;
        const result = {
          id: row.id,
          eventType: row.event_type,
          targetType: row.target_type,
          targetId: row.target_id,
          createdAt: row.created_at,
          outcome,
          reason: typeof reason === "string" ? reason : undefined,
          actor: row.actor_id
            ? { id: row.actor_id, displayName: row.actor_display_name ?? undefined }
            : undefined,
        };
        return result;
      });
    });
  }

  async getManagedScope(scopeId: string): Promise<ManagedScope | null> {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("managed_scopes").selectAll().where("id", "=", scopeId),
    );
    return row ? rowToScope(row) : null;
  }

  async getManagedScopeLineage(scopeId: string): Promise<ManagedScope[]> {
    return this.scopeLineageRows(this.requireScopeRow(scopeId)).map(rowToScope);
  }

  async resolveManagedScopeAuthorization(actorUserId: string, scopeId: string) {
    return runReadTransaction(this.db, () =>
      this.resolveOrganizationAuthorizationSnapshot(actorUserId, scopeId),
    );
  }

  async listEffectiveManagedScopeAccess(userId: string) {
    return runReadTransaction(this.db, () =>
      this.resolveEffectiveOrganizationAccessSnapshot(userId),
    );
  }

  async listUserManagedScopeMemberships(userId: string): Promise<ManagedScopeMembership[]> {
    this.requireUserRow(userId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("scope_id"),
    ).rows.map(rowToMembership);
  }

  async getUserPrimaryScope(userId: string): Promise<ManagedScope | null> {
    this.requireUserRow(userId);
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scope_primary_memberships")
        .innerJoin(
          "managed_scopes",
          "managed_scopes.id",
          "managed_scope_primary_memberships.scope_id",
        )
        .selectAll("managed_scopes")
        .where("managed_scope_primary_memberships.user_id", "=", userId),
    );
    return row ? rowToScope(row) : null;
  }
}
