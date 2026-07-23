import {
  ControlPlaneAuthorizationError,
  ControlPlaneStateError,
  type ControlAuditEvent,
  type ControlPlaneAuditWriter,
  type ControlPlaneManagementStore,
  type ControlPlaneStore,
  type ManagedScope,
  type ManagedScopeKind,
  type ManagedScopeMembership,
  type ManagedScopeRole,
  type PlatformUser,
  type PlatformUserGlobalRole,
  type PlatformUserStatus,
} from "./contracts.js";
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";
import { executeSync, runImmediateTransaction } from "./kysely-sync.js";
import { normalizeScopeName, required, rowToMembership, rowToScope } from "./sqlite-store-core.js";
import { SqliteControlPlaneExecutionStore } from "./sqlite-store-execution.js";
import type { ManagedScopeRow } from "./sqlite-store-types.js";

export class SqliteControlPlaneStore
  extends SqliteControlPlaneExecutionStore
  implements
    ControlPlaneStore,
    ControlPlaneManagementStore,
    ControlPlaneAuditWriter,
    ControlPlaneExecutionManagementStore
{
  async setUserGlobalRole(params: {
    actorUserId: string;
    targetUserId: string;
    role: PlatformUserGlobalRole;
    changedAt: number;
  }): Promise<PlatformUser> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const target = this.requireUserRow(params.targetUserId);
      if (params.actorUserId === params.targetUserId && target.global_role !== params.role) {
        throw new ControlPlaneStateError("admins cannot change their own global role");
      }
      if (target.global_role === params.role) {
        return this.rowToUser(target);
      }
      if (target.global_role === "admin" && params.role === "member") {
        const admins = executeSync(
          this.db,
          this.query.selectFrom("platform_users").select("id").where("global_role", "=", "admin"),
        ).rows.length;
        if (admins <= 1) {
          throw new ControlPlaneStateError("cannot demote the last admin");
        }
      }
      executeSync(
        this.db,
        this.query
          .updateTable("platform_users")
          .set({ global_role: params.role, updated_at: params.changedAt })
          .where("id", "=", target.id),
      );
      this.insertAudit(
        params.actorUserId,
        "user.role.changed",
        "user",
        target.id,
        params.changedAt,
        {
          from: target.global_role,
          to: params.role,
        },
      );
      return this.requireUser(target.id);
    });
  }

  async setManagedUserStatus(params: {
    actorUserId: string;
    targetUserId: string;
    status: PlatformUserStatus;
    changedAt: number;
  }): Promise<PlatformUser> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const target = this.requireUserRow(params.targetUserId);
      if (params.actorUserId === params.targetUserId && target.status !== params.status) {
        throw new ControlPlaneStateError("administrators cannot change their own status");
      }
      if (target.status === params.status) {
        return this.rowToUser(target);
      }
      if (target.global_role === "admin" && params.status === "disabled") {
        const activeAdmins = executeSync(
          this.db,
          this.query
            .selectFrom("platform_users")
            .select("id")
            .where("global_role", "=", "admin")
            .where("status", "=", "active"),
        ).rows.length;
        if (activeAdmins <= 1) {
          throw new ControlPlaneStateError("cannot disable the last active administrator");
        }
      }
      executeSync(
        this.db,
        this.query
          .updateTable("platform_users")
          .set({ status: params.status, updated_at: params.changedAt })
          .where("id", "=", target.id),
      );
      if (params.status === "disabled") {
        executeSync(
          this.db,
          this.query
            .updateTable("browser_sessions")
            .set({ revoked_at: params.changedAt })
            .where("user_id", "=", target.id)
            .where("revoked_at", "is", null),
        );
      }
      this.insertAudit(
        params.actorUserId,
        "user.status.changed",
        "user",
        target.id,
        params.changedAt,
        { from: target.status, to: params.status },
      );
      return this.requireUser(target.id);
    });
  }

  async createManagedScope(params: {
    actorUserId: string;
    kind: ManagedScopeKind;
    name: string;
    parentGroupId?: string;
    createdAt: number;
  }): Promise<ManagedScope> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const name = required(params.name, "scope.name");
      let parentGroupId: string | null = null;
      if (params.kind === "part") {
        parentGroupId = required(params.parentGroupId ?? "", "parentGroupId");
        const parent = this.requireScopeRow(parentGroupId);
        if (parent.kind !== "group" || parent.status !== "active") {
          throw new ControlPlaneStateError("part parent must be an active group");
        }
      } else if (params.parentGroupId) {
        throw new ControlPlaneStateError("groups cannot have a parent");
      }
      const row: ManagedScopeRow = {
        id: this.idFactory.nextManagedScopeId(),
        kind: params.kind,
        name,
        normalized_name: normalizeScopeName(name),
        parent_group_id: parentGroupId,
        status: "active",
        created_by_user_id: params.actorUserId,
        created_at: params.createdAt,
        updated_at: params.createdAt,
      };
      this.assertScopeNameAvailable(row);
      executeSync(this.db, this.query.insertInto("managed_scopes").values(row));
      this.insertAudit(
        params.actorUserId,
        "scope.created",
        "managed-scope",
        row.id,
        params.createdAt,
        {
          kind: row.kind,
          name: row.name,
          ...(parentGroupId ? { parentGroupId } : {}),
        },
      );
      return rowToScope(row);
    });
  }

  async archiveManagedScope(params: {
    actorUserId: string;
    scopeId: string;
    archivedAt: number;
  }): Promise<ManagedScope> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const scope = this.requireScopeRow(params.scopeId);
      if (scope.status !== "archived") {
        executeSync(
          this.db,
          this.query
            .updateTable("managed_scopes")
            .set({ status: "archived", updated_at: params.archivedAt })
            .where("id", "=", scope.id),
        );
        if (scope.kind === "group") {
          executeSync(
            this.db,
            this.query
              .updateTable("managed_scopes")
              .set({ status: "archived", updated_at: params.archivedAt })
              .where("parent_group_id", "=", scope.id),
          );
        }
        this.insertAudit(
          params.actorUserId,
          "scope.archived",
          "managed-scope",
          scope.id,
          params.archivedAt,
        );
      }
      return rowToScope(this.requireScopeRow(scope.id));
    });
  }

  async setManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    role: ManagedScopeRole;
    changedAt: number;
  }): Promise<ManagedScopeMembership> {
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      const scope = this.requireScopeRow(params.scopeId);
      const target = this.requireUserRow(params.userId);
      if (actor.status !== "active") {
        throw new ControlPlaneAuthorizationError("active group leader required");
      }
      if (target.status !== "active") {
        throw new ControlPlaneStateError("cannot add a disabled user to a managed scope");
      }
      if (scope.status !== "active") {
        throw new ControlPlaneStateError("cannot change memberships for an archived scope");
      }
      const actorIsAdmin = actor.global_role === "admin";
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
      this.insertAudit(
        actor.id,
        "scope.membership.set",
        "managed-scope",
        scope.id,
        params.changedAt,
        { userId: params.userId, role: params.role },
      );
      return rowToMembership(this.selectMembership(scope.id, params.userId)!);
    });
  }

  async removeManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    changedAt: number;
  }): Promise<boolean> {
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      const scope = this.requireScopeRow(params.scopeId);
      if (scope.status !== "active") {
        throw new ControlPlaneStateError("cannot change memberships for an archived scope");
      }
      if (actor.status !== "active") {
        throw new ControlPlaneAuthorizationError("active group leader required");
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
      if (!actorIsAdmin && this.selectMembership(scope.id, params.userId)?.role === "leader") {
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
        this.insertAudit(
          actor.id,
          "scope.membership.removed",
          "managed-scope",
          scope.id,
          params.changedAt,
          { userId: params.userId },
        );
      }
      return removed;
    });
  }

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

  async listAuditEvents(limit = 100): Promise<ControlAuditEvent[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 500))
      : 100;
    return executeSync(
      this.db,
      this.query
        .selectFrom("control_audit_events")
        .selectAll()
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(boundedLimit),
    ).rows.map((row) => {
      const event: ControlAuditEvent = {
        id: row.id,
        eventType: row.event_type,
        targetType: row.target_type,
        targetId: row.target_id,
        createdAt: row.created_at,
      };
      if (row.actor_user_id) {
        event.actorUserId = row.actor_user_id;
      }
      if (row.details_json) {
        event.details = JSON.parse(row.details_json) as Record<string, unknown>;
      }
      return event;
    });
  }
}
