import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneStateError,
  type ManagedScope,
  type ManagedScopeMember,
  type ManagedScopeMembership,
} from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
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
      const directScopeIds = new Set(
        executeSync(
          this.db,
          this.query
            .selectFrom("managed_scope_memberships")
            .select("scope_id")
            .where("user_id", "=", user.id),
        ).rows.map((row) => row.scope_id),
      );
      const pendingScopeIds = new Set(
        executeSync(
          this.db,
          this.query
            .selectFrom("organization_join_requests")
            .select("scope_id")
            .where("user_id", "=", user.id)
            .where("status", "=", "pending"),
        ).rows.map((row) => row.scope_id),
      );
      return scopes.map((scope) => {
        return {
          scope: rowToScope(scope),
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
        .select(["id", "account_id", "display_name", "status"])
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
  }) {
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
        const outcome = details?.outcome;
        const reason = details?.reason;
        const result = {
          id: row.id,
          eventType: row.event_type,
          targetType: row.target_type,
          targetId: row.target_id,
          createdAt: row.created_at,
          outcome: outcome === "succeeded" || outcome === "denied" ? outcome : undefined,
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
