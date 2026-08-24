import type { ManagedScope, ManagedScopeMembership } from "./contracts.js";
import { executeSync, runReadTransaction, takeFirstSync } from "./kysely-sync.js";
import { rowToMembership, rowToScope } from "./sqlite-store-core.js";
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
