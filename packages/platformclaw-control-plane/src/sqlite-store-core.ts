import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Kysely } from "kysely";
import {
  BROWSER_SESSION_POLICY,
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type AgentBinding,
  type AgentProvisioningState,
  type BrowserSession,
  type BrowserSessionPolicy,
  type ControlPlaneIdFactory,
  type EnterpriseIdentity,
  type EnterprisePrincipal,
  type MainSessionKeyBuilder,
  type ManagedScope,
  type ManagedScopeMembership,
  type PlatformUser,
} from "./contracts.js";
import { defaultControlPlaneIdFactory } from "./ids.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import { initializeControlPlaneSchema } from "./sqlite-schema.js";
import type {
  AgentBindingRow,
  BrowserSessionRow,
  ControlPlaneDatabase,
  EnterpriseIdentityRow,
  ManagedScopeMembershipRow,
  ManagedScopeRow,
  PlatformUserRow,
} from "./sqlite-store-types.js";

export type SqliteControlPlaneStoreOptions = {
  databasePath: string;
  buildAgentMainSessionKey: MainSessionKeyBuilder;
  initialAdminAccountIds?: readonly string[];
  idFactory?: ControlPlaneIdFactory;
  sessionPolicy?: BrowserSessionPolicy;
};

export const ALLOWED_AGENT_TRANSITIONS: Record<
  AgentProvisioningState,
  ReadonlySet<AgentProvisioningState>
> = {
  provisioning: new Set(["active", "failed", "disabled"]),
  active: new Set(["disabled"]),
  failed: new Set(["provisioning", "disabled"]),
  disabled: new Set(),
};

export function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ControlPlaneStateError(`${field} must not be empty`);
  }
  return normalized;
}

export function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

export function normalizedGroups(groups: string[] | undefined): string[] {
  return [...new Set((groups ?? []).map((group) => group.trim()).filter(Boolean))].toSorted();
}

export function normalizeEmployeeId(employeeId: string): string {
  return required(employeeId, "principal.employeeId").toLowerCase();
}

export function normalizeAccountId(accountId: string): string {
  return required(accountId, "principal.accountId").toLowerCase();
}

export function normalizeScopeName(name: string): string {
  return required(name, "scope.name").toLocaleLowerCase("en-US");
}

export function rowToIdentity(row: EnterpriseIdentityRow): EnterpriseIdentity {
  return {
    provider: row.provider,
    subject: row.subject,
    userId: row.user_id,
    employeeId: row.employee_id,
    createdAt: row.created_at,
    lastAuthenticatedAt: row.last_authenticated_at,
  };
}

export function rowToBinding(row: AgentBindingRow): AgentBinding {
  const base = {
    id: row.id,
    agentId: row.agent_id,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
  };
  if (row.kind === "personal") {
    if (!row.user_id) {
      throw new ControlPlaneStateError(`personal binding has no user: ${row.id}`);
    }
    return { ...base, kind: "personal", userId: row.user_id };
  }
  if (!row.knox_account_id || !row.room_id) {
    throw new ControlPlaneStateError(`Knox room binding is incomplete: ${row.id}`);
  }
  return {
    ...base,
    kind: "knox-room",
    accountId: row.knox_account_id,
    roomId: row.room_id,
  };
}

export function rowToSession(row: BrowserSessionRow): BrowserSession {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    idleExpiresAt: row.idle_expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

export function rowToScope(row: ManagedScopeRow): ManagedScope {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    ...(row.parent_group_id ? { parentGroupId: row.parent_group_id } : {}),
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToMembership(row: ManagedScopeMembershipRow): ManagedScopeMembership {
  return {
    scopeId: row.scope_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export abstract class SqliteControlPlaneStoreCore {
  protected readonly db: DatabaseSync;
  protected readonly query: Kysely<ControlPlaneDatabase>;
  protected readonly buildAgentMainSessionKey: MainSessionKeyBuilder;
  protected readonly idFactory: ControlPlaneIdFactory;
  protected readonly sessionPolicy: BrowserSessionPolicy;
  protected readonly initialAdminAccountIds: ReadonlySet<string>;

  constructor(options: SqliteControlPlaneStoreOptions) {
    const databaseDirectory = dirname(options.databasePath);
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(databaseDirectory, 0o700);
      if (existsSync(options.databasePath)) {
        chmodSync(options.databasePath, 0o600);
      }
    }
    this.db = new DatabaseSync(options.databasePath);
    initializeControlPlaneSchema(this.db);
    if (process.platform !== "win32") {
      for (const path of [
        options.databasePath,
        `${options.databasePath}-wal`,
        `${options.databasePath}-shm`,
      ]) {
        if (existsSync(path)) {
          chmodSync(path, 0o600);
        }
      }
    }
    this.query = createSyncKysely<ControlPlaneDatabase>();
    this.buildAgentMainSessionKey = options.buildAgentMainSessionKey;
    this.idFactory = options.idFactory ?? defaultControlPlaneIdFactory;
    this.sessionPolicy = options.sessionPolicy ?? BROWSER_SESSION_POLICY;
    this.initialAdminAccountIds = new Set(
      (options.initialAdminAccountIds ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    const activeAdmin = takeFirstSync(
      this.db,
      this.query
        .selectFrom("platform_users")
        .select("id")
        .where("global_role", "=", "admin")
        .where("status", "=", "active")
        .limit(1),
    );
    if (!activeAdmin && this.initialAdminAccountIds.size === 0) {
      this.db.close();
      throw new ControlPlaneStateError(
        "a control-plane database without an active administrator requires an initial administrator account id",
      );
    }
  }

  close(): void {
    this.db.close();
  }

  protected rowToUser(row: PlatformUserRow): PlatformUser {
    const groups = executeSync(
      this.db,
      this.query
        .selectFrom("user_directory_groups")
        .select("group_name")
        .where("user_id", "=", row.id)
        .orderBy("group_name"),
    ).rows.map((entry) => entry.group_name);
    return {
      id: row.id,
      accountId: row.account_id,
      employeeId: row.employee_id,
      status: row.status,
      globalRole: row.global_role,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.department ? { department: row.department } : {}),
      ...(row.timezone ? { timezone: row.timezone } : {}),
      groups,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_login_at === null ? {} : { lastLoginAt: row.last_login_at }),
    };
  }

  protected selectUserById(userId: string): PlatformUserRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").selectAll().where("id", "=", userId),
    );
  }

  protected selectUserByEmployeeId(employeeId: string): PlatformUserRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").selectAll().where("employee_id", "=", employeeId),
    );
  }

  protected selectUserByAccountId(accountId: string): PlatformUserRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").selectAll().where("account_id", "=", accountId),
    );
  }

  protected requireUserRow(userId: string): PlatformUserRow {
    const row = this.selectUserById(userId);
    if (!row) {
      throw new ControlPlaneNotFoundError("user", userId);
    }
    return row;
  }

  protected requireUser(userId: string): PlatformUser {
    return this.rowToUser(this.requireUserRow(userId));
  }

  protected requireAdmin(userId: string): PlatformUserRow {
    const user = this.requireUserRow(userId);
    if (user.global_role !== "admin" || user.status !== "active") {
      throw new ControlPlaneAuthorizationError("active administrator required");
    }
    return user;
  }

  protected selectIdentity(
    provider: "ldap" | "saml",
    subject: string,
  ): EnterpriseIdentityRow | undefined {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("enterprise_identities")
        .selectAll()
        .where("provider", "=", provider)
        .where("subject", "=", subject),
    );
  }

  protected updateUserFromPrincipal(
    userId: string,
    employeeId: string,
    principal: EnterprisePrincipal,
    updatedAt: number,
  ): void {
    executeSync(
      this.db,
      this.query
        .updateTable("platform_users")
        .set({
          employee_id: employeeId,
          display_name: optional(principal.displayName),
          email: optional(principal.email),
          department: optional(principal.department),
          updated_at: updatedAt,
          last_login_at: updatedAt,
        })
        .where("id", "=", userId),
    );
  }

  protected bootstrapExistingAdminIfNeeded(userId: string, changedAt: number): void {
    const user = this.requireUserRow(userId);
    if (
      user.status !== "active" ||
      user.global_role === "admin" ||
      !this.initialAdminAccountIds.has(user.account_id)
    ) {
      return;
    }
    const activeAdmin = takeFirstSync(
      this.db,
      this.query
        .selectFrom("platform_users")
        .select("id")
        .where("global_role", "=", "admin")
        .where("status", "=", "active")
        .limit(1),
    );
    if (activeAdmin) {
      return;
    }
    executeSync(
      this.db,
      this.query
        .updateTable("platform_users")
        .set({ global_role: "admin", updated_at: changedAt })
        .where("id", "=", user.id),
    );
    this.insertAudit(null, "user.admin.bootstrapped", "user", user.id, changedAt, {
      accountId: user.account_id,
    });
  }

  protected replaceDirectoryGroups(userId: string, groups: string[] | undefined): void {
    executeSync(
      this.db,
      this.query.deleteFrom("user_directory_groups").where("user_id", "=", userId),
    );
    const rows = normalizedGroups(groups).map((groupName) => ({
      user_id: userId,
      group_name: groupName,
    }));
    if (rows.length > 0) {
      executeSync(this.db, this.query.insertInto("user_directory_groups").values(rows));
    }
  }

  protected requireBindingRow(bindingId: string): AgentBindingRow {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("agent_bindings").selectAll().where("id", "=", bindingId),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("agent-binding", bindingId);
    }
    return row;
  }

  protected assertAgentIdAvailable(agentId: string): void {
    const existing = takeFirstSync(
      this.db,
      this.query.selectFrom("agent_bindings").select("id").where("agent_id", "=", agentId),
    );
    if (existing) {
      throw new ControlPlaneConflictError(
        "agent_id_conflict",
        `agent id already belongs to another binding: ${agentId}`,
      );
    }
  }

  protected requireScopeRow(scopeId: string): ManagedScopeRow {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("managed_scopes").selectAll().where("id", "=", scopeId),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("managed-scope", scopeId);
    }
    return row;
  }

  protected assertScopeNameAvailable(scope: ManagedScopeRow): void {
    let query = this.query
      .selectFrom("managed_scopes")
      .select("id")
      .where("kind", "=", scope.kind)
      .where("normalized_name", "=", scope.normalized_name);
    query =
      scope.kind === "group"
        ? query.where("parent_group_id", "is", null)
        : query.where("parent_group_id", "=", scope.parent_group_id);
    if (takeFirstSync(this.db, query)) {
      throw new ControlPlaneConflictError(
        "managed_scope_name_conflict",
        `${scope.kind} name already exists in its parent scope: ${scope.name}`,
      );
    }
  }

  protected selectMembership(
    scopeId: string,
    userId: string,
  ): ManagedScopeMembershipRow | undefined {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .selectAll()
        .where("scope_id", "=", scopeId)
        .where("user_id", "=", userId),
    );
  }

  protected isLeaderForScope(userId: string, scope: ManagedScopeRow): boolean {
    if (this.selectMembership(scope.id, userId)?.role === "leader") {
      return true;
    }
    return Boolean(
      scope.parent_group_id &&
      this.selectMembership(scope.parent_group_id, userId)?.role === "leader",
    );
  }

  protected insertAudit(
    actorUserId: string | null,
    eventType: string,
    targetType: string,
    targetId: string,
    createdAt: number,
    details?: Record<string, unknown>,
  ): void {
    executeSync(
      this.db,
      this.query.insertInto("control_audit_events").values({
        id: this.idFactory.nextAuditEventId(),
        actor_user_id: actorUserId,
        event_type: eventType,
        target_type: targetType,
        target_id: targetId,
        details_json: details ? JSON.stringify(details) : null,
        created_at: createdAt,
      }),
    );
  }
}
