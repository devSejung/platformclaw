import { randomUUID } from "node:crypto";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
  type ManagedScope,
  type ManagedScopeKind,
  type ManagedScopeMembership,
  type ManagedScopeRole,
  type OrganizationAuthorization,
} from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { normalizeScopeName, required, rowToMembership, rowToScope } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationAccessStore } from "./sqlite-store-organization-access.js";
import type { ManagedScopeRow } from "./sqlite-store-types.js";

export function boundedOrganizationReason(value: string, field: string): string {
  const reason = required(value, field);
  if (reason.length > 500) {
    throw new ControlPlaneStateError(`${field} must not exceed 500 characters`);
  }
  return reason;
}

function boundedScopeName(value: string): string {
  const name = required(value, "scope.name");
  if (name.length > 120) {
    throw new ControlPlaneStateError("scope.name must not exceed 120 characters");
  }
  return name;
}

type OrganizationAuditAuthorizationFacts =
  | OrganizationAuthorization["facts"]
  | { source: "self"; scopeIds: string[] };

export abstract class SqliteControlPlaneOrganizationStore extends SqliteControlPlaneOrganizationAccessStore {
  private organizationAuthorizationFacts(
    actorUserId: string,
    scopeId?: string,
    self = false,
  ): OrganizationAuditAuthorizationFacts {
    const actor = this.selectUserById(actorUserId);
    if (!actor || actor.status !== "active") {
      return { source: "none", scopeIds: [] };
    }
    if (self) {
      return { source: "self", scopeIds: scopeId ? [scopeId] : [] };
    }
    if (!scopeId) {
      return actor.global_role === "admin"
        ? { source: "administrator", scopeIds: [] }
        : { source: "none", scopeIds: [] };
    }
    return this.resolveOrganizationAuthorizationSnapshot(actorUserId, scopeId).facts;
  }

  protected insertOrganizationAudit(params: {
    actorUserId: string;
    action: string;
    targetType: string;
    targetId: string;
    createdAt: number;
    outcome: "succeeded" | "denied";
    scopeId?: string;
    self?: boolean;
    authorization?: OrganizationAuditAuthorizationFacts;
    reason: string;
    details?: Record<string, unknown>;
  }): void {
    this.insertAudit(
      this.selectUserById(params.actorUserId) ? params.actorUserId : null,
      params.action,
      params.targetType,
      params.targetId,
      params.createdAt,
      {
        action: params.action,
        target: { type: params.targetType, id: params.targetId },
        outcome: params.outcome,
        authorization:
          params.authorization ??
          this.organizationAuthorizationFacts(params.actorUserId, params.scopeId, params.self),
        ...(params.reason ? { reason: params.reason } : {}),
        ...params.details,
      },
    );
  }

  protected runOrganizationMutation<T>(
    audit: {
      actorUserId: string;
      action: string;
      targetType: string;
      targetId: string;
      createdAt: number;
      scopeId?: string;
    },
    operation: () => T,
  ): T {
    try {
      return runImmediateTransaction(this.db, operation);
    } catch (error) {
      if (
        error instanceof ControlPlaneAuthorizationError ||
        error instanceof ControlPlaneStateError ||
        error instanceof ControlPlaneConflictError
      ) {
        runImmediateTransaction(this.db, () =>
          this.insertOrganizationAudit({
            ...audit,
            outcome: "denied",
            details: { denialReason: error.message },
          }),
        );
      }
      throw error;
    }
  }

  async createManagedScope(params: {
    actorUserId: string;
    kind: ManagedScopeKind;
    name: string;
    parentScopeId?: string;
    createdAt: number;
  }): Promise<ManagedScope> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "scope.create.denied",
        targetType: "managed-scope-kind",
        targetId: params.kind,
        createdAt: params.createdAt,
      },
      () => {
        this.requireAdmin(params.actorUserId);
        const name = boundedScopeName(params.name);
        let parentScopeId: string | null = null;
        if (params.kind !== "team") {
          parentScopeId = required(params.parentScopeId ?? "", "parentScopeId");
          const parent = this.requireScopeRow(parentScopeId);
          const expectedParentKind = params.kind === "group" ? "team" : "group";
          if (parent.kind !== expectedParentKind || parent.status !== "active") {
            throw new ControlPlaneStateError(
              `${params.kind} parent must be an active ${expectedParentKind}`,
            );
          }
          if (this.scopeLineageRows(parent).some((ancestor) => ancestor.status !== "active")) {
            throw new ControlPlaneStateError("managed scope parent lineage must be active");
          }
        } else if (params.parentScopeId) {
          throw new ControlPlaneStateError("teams cannot have a parent");
        }
        const row: ManagedScopeRow = {
          id: this.idFactory.nextManagedScopeId(),
          kind: params.kind,
          name,
          normalized_name: normalizeScopeName(name),
          parent_scope_id: parentScopeId,
          system_kind: null,
          system_provenance: null,
          status: "active",
          created_by_user_id: params.actorUserId,
          created_at: params.createdAt,
          updated_at: params.createdAt,
        };
        this.assertScopeNameAvailable(row);
        executeSync(this.db, this.query.insertInto("managed_scopes").values(row));
        this.insertOrganizationAudit({
          actorUserId: params.actorUserId,
          action: "scope.created",
          targetType: "managed-scope",
          targetId: row.id,
          createdAt: params.createdAt,
          outcome: "succeeded",
          scopeId: row.id,
          details: {
            kind: row.kind,
            name: row.name,
            ...(parentScopeId ? { parentScopeId } : {}),
          },
        });
        return rowToScope(row);
      },
    );
  }

  async renameManagedScope(params: {
    actorUserId: string;
    scopeId: string;
    name: string;
    reason: string;
    changedAt: number;
  }): Promise<ManagedScope> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "scope.rename.denied",
        targetType: "managed-scope",
        targetId: params.scopeId,
        createdAt: params.changedAt,
        scopeId: params.scopeId,
      },
      () => {
        this.requireAdmin(params.actorUserId);
        const scope = this.requireScopeRow(params.scopeId);
        if (scope.status !== "active") {
          throw new ControlPlaneStateError("archived scopes cannot be renamed");
        }
        const name = boundedScopeName(params.name);
        const reason = boundedOrganizationReason(params.reason, "reason");
        const updated = { ...scope, name, normalized_name: normalizeScopeName(name) };
        this.assertScopeNameAvailable(updated, scope.id);
        executeSync(
          this.db,
          this.query
            .updateTable("managed_scopes")
            .set({ name, normalized_name: updated.normalized_name, updated_at: params.changedAt })
            .where("id", "=", scope.id),
        );
        this.insertOrganizationAudit({
          actorUserId: params.actorUserId,
          action: "scope.renamed",
          targetType: "managed-scope",
          targetId: scope.id,
          createdAt: params.changedAt,
          outcome: "succeeded",
          scopeId: scope.id,
          reason,
          details: { beforeName: scope.name, resultName: name },
        });
        return rowToScope(this.requireScopeRow(scope.id));
      },
    );
  }

  async archiveManagedScope(params: {
    actorUserId: string;
    scopeId: string;
    reason: string;
    archivedAt: number;
  }): Promise<ManagedScope> {
    this.ensureOrganizationMemorySchema();
    this.ensureSkillHubStateSchema();
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "scope.archive.denied",
        targetType: "managed-scope",
        targetId: params.scopeId,
        createdAt: params.archivedAt,
        scopeId: params.scopeId,
      },
      () => {
        this.requireAdmin(params.actorUserId);
        const scope = this.requireScopeRow(params.scopeId);
        const auditReason = boundedOrganizationReason(params.reason, "reason");
        const archiveAuthorization = this.resolveOrganizationAuthorizationSnapshot(
          params.actorUserId,
          scope.id,
        ).facts;
        if (scope.status !== "archived") {
          const allScopes = executeSync(
            this.db,
            this.query.selectFrom("managed_scopes").selectAll(),
          ).rows;
          const archivedScopeIds = [scope.id];
          for (const candidate of allScopes) {
            if (
              candidate.id !== scope.id &&
              this.scopeLineageRows(candidate).some((ancestor) => ancestor.id === scope.id)
            ) {
              archivedScopeIds.push(candidate.id);
            }
          }
          const boundNamespace = takeFirstSync(
            this.db,
            this.query
              .selectFrom("skill_hub_namespace_bindings")
              .select("namespace")
              .where("scope_id", "in", archivedScopeIds)
              .limit(1),
          );
          if (boundNamespace) {
            throw new ControlPlaneStateError(
              `archive blocked: Skill Hub namespace ${boundNamespace.namespace} must be transferred or retired`,
            );
          }
          const retiredClaims = executeSync(
            this.db,
            this.query
              .selectFrom("organization_memory_claims")
              .selectAll()
              .where("scope_id", "in", archivedScopeIds)
              .where("status", "=", "active"),
          ).rows;
          const abandonedRequests = executeSync(
            this.db,
            this.query
              .selectFrom("organization_memory_promotion_requests")
              .leftJoin(
                "organization_memory_promotion_decisions",
                "organization_memory_promotion_decisions.request_id",
                "organization_memory_promotion_requests.id",
              )
              .select("organization_memory_promotion_requests.id")
              .where("target_scope_id", "in", archivedScopeIds)
              .where("organization_memory_promotion_decisions.request_id", "is", null),
          ).rows;
          for (const request of abandonedRequests) {
            executeSync(
              this.db,
              this.query.insertInto("organization_memory_promotion_decisions").values({
                id: `memory-decision-${randomUUID()}`,
                request_id: request.id,
                decision: "rejected",
                decided_by_user_id: params.actorUserId,
                reason: "Owning target scope archived",
                target_claim_id: null,
                decided_at: params.archivedAt,
              }),
            );
            this.insertAudit(
              params.actorUserId,
              "organization-memory.promotion.rejected",
              "memory-promotion",
              request.id,
              params.archivedAt,
              { reason: "Owning target scope archived" },
            );
          }
          for (const claim of retiredClaims) {
            executeSync(
              this.db,
              this.query
                .updateTable("organization_memory_claims")
                .set({
                  status: "retired",
                  revision: claim.revision + 1,
                  updated_at: params.archivedAt,
                  retired_by_user_id: params.actorUserId,
                  retired_at: params.archivedAt,
                  retirement_reason: "Owning scope archived",
                })
                .where("id", "=", claim.id),
            );
            this.compileClaimPage(claim.id);
            if (claim.source_kind !== "personal") {
              this.compileClaimPage(claim.source_claim_id);
            }
            this.insertAudit(
              params.actorUserId,
              "organization-memory.claim.retired",
              "memory-claim",
              claim.id,
              params.archivedAt,
              { reason: "Owning scope archived" },
            );
          }
          executeSync(
            this.db,
            this.query
              .updateTable("managed_scopes")
              .set({ status: "archived", updated_at: params.archivedAt })
              .where("id", "in", archivedScopeIds),
          );
          const pendingJoins = executeSync(
            this.db,
            this.query
              .selectFrom("organization_join_requests")
              .selectAll()
              .where("scope_id", "in", archivedScopeIds)
              .where("status", "=", "pending"),
          ).rows;
          for (const request of pendingJoins) {
            const reason = "Owning scope archived";
            executeSync(
              this.db,
              this.query.insertInto("organization_join_request_decisions").values({
                request_id: request.id,
                decision: "rejected",
                actor_user_id: params.actorUserId,
                reason,
                decided_at: params.archivedAt,
              }),
            );
            executeSync(
              this.db,
              this.query
                .updateTable("organization_join_requests")
                .set({ status: "rejected", decided_at: params.archivedAt })
                .where("id", "=", request.id),
            );
            this.insertOrganizationAudit({
              actorUserId: params.actorUserId,
              action: "organization.join.rejected",
              targetType: "managed-scope",
              targetId: request.scope_id,
              createdAt: params.archivedAt,
              outcome: "succeeded",
              scopeId: request.scope_id,
              reason,
              details: { requestId: request.id, userId: request.user_id },
            });
          }
          executeSync(
            this.db,
            this.query
              .deleteFrom("managed_scope_primary_memberships")
              .where("scope_id", "in", archivedScopeIds),
          );
          this.insertOrganizationAudit({
            actorUserId: params.actorUserId,
            action: "scope.archived",
            targetType: "managed-scope",
            targetId: scope.id,
            createdAt: params.archivedAt,
            outcome: "succeeded",
            scopeId: scope.id,
            authorization: archiveAuthorization,
            reason: auditReason,
            details: { archivedScopeIds: archivedScopeIds.toSorted() },
          });
        }
        return rowToScope(this.requireScopeRow(scope.id));
      },
    );
  }

  async setManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    role: ManagedScopeRole;
    reason: string;
    changedAt: number;
  }): Promise<ManagedScopeMembership> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "scope.membership.set.denied",
        targetType: "managed-scope",
        targetId: params.scopeId,
        createdAt: params.changedAt,
        scopeId: params.scopeId,
      },
      () => {
        const actor = this.requireUserRow(params.actorUserId);
        const scope = this.requireScopeRow(params.scopeId);
        const target = this.requireUserRow(params.userId);
        if (actor.status !== "active") {
          throw new ControlPlaneAuthorizationError("active organization manager required");
        }
        if (target.status !== "active") {
          throw new ControlPlaneStateError("cannot add a disabled user to a managed scope");
        }
        if (scope.status !== "active") {
          throw new ControlPlaneStateError("cannot change memberships for an archived scope");
        }
        const actorIsAdmin = actor.global_role === "admin";
        const reason = boundedOrganizationReason(params.reason, "reason");
        if (!actorIsAdmin && !this.isLeaderForScope(actor.id, scope)) {
          throw new ControlPlaneAuthorizationError(
            "not allowed to manage memberships for this scope",
          );
        }
        if (!actorIsAdmin && params.role === "leader") {
          throw new ControlPlaneAuthorizationError("leaders can only assign member role");
        }
        const existing = this.selectMembership(scope.id, params.userId);
        if (!actorIsAdmin && existing?.role === "leader") {
          throw new ControlPlaneAuthorizationError("only administrators can change leader roles");
        }
        if (existing) {
          executeSync(
            this.db,
            this.query
              .updateTable("managed_scope_memberships")
              .set({ role: params.role, updated_at: params.changedAt })
              .where("scope_id", "=", scope.id)
              .where("user_id", "=", params.userId),
          );
        } else {
          executeSync(
            this.db,
            this.query.insertInto("managed_scope_memberships").values({
              scope_id: scope.id,
              user_id: params.userId,
              role: params.role,
              created_at: params.changedAt,
              updated_at: params.changedAt,
            }),
          );
        }
        this.insertOrganizationAudit({
          actorUserId: actor.id,
          action: "scope.membership.set",
          targetType: "managed-scope",
          targetId: scope.id,
          createdAt: params.changedAt,
          outcome: "succeeded",
          scopeId: scope.id,
          reason,
          details: {
            userId: params.userId,
            beforeRole: existing?.role ?? null,
            resultRole: params.role,
          },
        });
        const pendingRequests = executeSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .selectAll()
            .where("user_id", "=", params.userId)
            .where("scope_id", "=", scope.id)
            .where("status", "=", "pending"),
        ).rows;
        for (const request of pendingRequests) {
          executeSync(
            this.db,
            this.query.insertInto("organization_join_request_decisions").values({
              request_id: request.id,
              decision: "approved",
              actor_user_id: actor.id,
              reason,
              decided_at: params.changedAt,
            }),
          );
          executeSync(
            this.db,
            this.query
              .updateTable("organization_join_requests")
              .set({ status: "approved", decided_at: params.changedAt })
              .where("id", "=", request.id),
          );
          this.insertOrganizationAudit({
            actorUserId: actor.id,
            action: "organization.join.approved",
            targetType: "managed-scope",
            targetId: scope.id,
            createdAt: params.changedAt,
            outcome: "succeeded",
            scopeId: scope.id,
            reason,
            details: { requestId: request.id, userId: params.userId, source: "direct-assignment" },
          });
        }
        return rowToMembership(this.selectMembership(scope.id, params.userId)!);
      },
    );
  }

  async removeManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    reason: string;
    changedAt: number;
  }): Promise<boolean> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "scope.membership.remove.denied",
        targetType: "managed-scope",
        targetId: params.scopeId,
        createdAt: params.changedAt,
        scopeId: params.scopeId,
      },
      () => {
        const actor = this.requireUserRow(params.actorUserId);
        const scope = this.requireScopeRow(params.scopeId);
        if (scope.status !== "active") {
          throw new ControlPlaneStateError("cannot change memberships for an archived scope");
        }
        if (actor.status !== "active") {
          throw new ControlPlaneAuthorizationError("active organization manager required");
        }
        const actorIsAdmin = actor.global_role === "admin";
        if (!actorIsAdmin && !this.isLeaderForScope(actor.id, scope)) {
          throw new ControlPlaneAuthorizationError(
            "not allowed to manage memberships for this scope",
          );
        }
        if (!actorIsAdmin && actor.id === params.userId) {
          throw new ControlPlaneAuthorizationError("leaders cannot remove themselves");
        }
        const reason = boundedOrganizationReason(params.reason, "reason");
        const existing = this.selectMembership(scope.id, params.userId);
        if (!actorIsAdmin && existing?.role === "leader") {
          throw new ControlPlaneAuthorizationError("only administrators can remove leaders");
        }
        const result = executeSync(
          this.db,
          this.query
            .deleteFrom("managed_scope_memberships")
            .where("scope_id", "=", scope.id)
            .where("user_id", "=", params.userId),
        );
        const removed = (result.numAffectedRows ?? 0n) > 0n;
        if (removed) {
          this.insertOrganizationAudit({
            actorUserId: actor.id,
            action: "scope.membership.removed",
            targetType: "managed-scope",
            targetId: scope.id,
            createdAt: params.changedAt,
            outcome: "succeeded",
            scopeId: scope.id,
            reason,
            details: { userId: params.userId, priorRole: existing?.role ?? null },
          });
        }
        return removed;
      },
    );
  }

  async setUserPrimaryScope(params: {
    actorUserId: string;
    userId: string;
    scopeId?: string;
    changedAt: number;
  }): Promise<ManagedScope | null> {
    return this.runOrganizationMutation(
      {
        actorUserId: params.actorUserId,
        action: "scope.primary.change.denied",
        targetType: "user",
        targetId: params.userId,
        createdAt: params.changedAt,
        ...(params.scopeId ? { scopeId: params.scopeId } : {}),
      },
      () => {
        const actor = this.requireUserRow(params.actorUserId);
        if (
          actor.status !== "active" ||
          (actor.id !== params.userId && actor.global_role !== "admin")
        ) {
          throw new ControlPlaneAuthorizationError(
            "primary scope can only be changed by its user or an administrator",
          );
        }
        const target = this.requireUserRow(params.userId);
        if (target.status !== "active") {
          throw new ControlPlaneStateError("primary scope requires an active user");
        }
        const priorPrimary = takeFirstSync(
          this.db,
          this.query
            .selectFrom("managed_scope_primary_memberships")
            .select("scope_id")
            .where("user_id", "=", params.userId),
        );
        if (!params.scopeId) {
          executeSync(
            this.db,
            this.query
              .deleteFrom("managed_scope_primary_memberships")
              .where("user_id", "=", params.userId),
          );
          this.insertOrganizationAudit({
            actorUserId: actor.id,
            action: "scope.primary.cleared",
            targetType: "user",
            targetId: params.userId,
            createdAt: params.changedAt,
            outcome: "succeeded",
            self: actor.id === params.userId,
            details: { priorScopeId: priorPrimary?.scope_id ?? null },
          });
          return null;
        }
        const scope = this.requireScopeRow(params.scopeId);
        if (
          scope.status !== "active" ||
          this.scopeLineageRows(scope).some((ancestor) => ancestor.status !== "active") ||
          !this.selectMembership(scope.id, params.userId)
        ) {
          throw new ControlPlaneStateError("primary scope must be an active direct membership");
        }
        executeSync(
          this.db,
          this.query
            .insertInto("managed_scope_primary_memberships")
            .values({ user_id: params.userId, scope_id: scope.id, updated_at: params.changedAt })
            .onConflict((conflict) =>
              conflict
                .column("user_id")
                .doUpdateSet({ scope_id: scope.id, updated_at: params.changedAt }),
            ),
        );
        this.insertOrganizationAudit({
          actorUserId: actor.id,
          action: "scope.primary.changed",
          targetType: "user",
          targetId: params.userId,
          createdAt: params.changedAt,
          outcome: "succeeded",
          scopeId: scope.id,
          self: actor.id === params.userId,
          details: { priorScopeId: priorPrimary?.scope_id ?? null, resultScopeId: scope.id },
        });
        return rowToScope(scope);
      },
    );
  }
}
