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
  type AgentReservationResult,
  type BrowserSession,
  type BrowserSessionPolicy,
  type BrowserSessionResolution,
  type ControlAuditEvent,
  type ControlPlaneIdFactory,
  type ControlPlaneManagementStore,
  type ControlPlaneStore,
  type CreateBrowserSessionResult,
  type EnterpriseIdentity,
  type EnterprisePrincipal,
  type KnoxDmRouteResolution,
  type KnoxRoomAgentBinding,
  type MainSessionKeyBuilder,
  type ManagedScope,
  type ManagedScopeKind,
  type ManagedScopeMembership,
  type ManagedScopeRole,
  type PersonalAgentBinding,
  type PlatformUser,
  type PlatformUserGlobalRole,
  type PlatformUserStatus,
  type UpsertPrincipalResult,
} from "./contracts.js";
import {
  defaultControlPlaneIdFactory,
  deriveKnoxRoomAgentId,
  derivePersonalAgentId,
} from "./ids.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import { initializeControlPlaneSchema } from "./sqlite-schema.js";

type PlatformUserRow = {
  id: string;
  account_id: string;
  employee_id: string;
  display_name: string | null;
  email: string | null;
  department: string | null;
  timezone: string | null;
  status: PlatformUserStatus;
  global_role: PlatformUserGlobalRole;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
};

type EnterpriseIdentityRow = {
  provider: "ldap" | "saml";
  subject: string;
  user_id: string;
  employee_id: string;
  created_at: number;
  last_authenticated_at: number;
};

type DirectoryGroupRow = { user_id: string; group_name: string };
type AgentBindingRow = {
  id: string;
  kind: "personal" | "knox-room";
  user_id: string | null;
  knox_account_id: string | null;
  room_id: string | null;
  agent_id: string;
  state: AgentProvisioningState;
  failure_code: string | null;
  created_at: number;
  updated_at: number;
};
type BrowserSessionRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  idle_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
};
type ManagedScopeRow = {
  id: string;
  kind: ManagedScopeKind;
  name: string;
  normalized_name: string;
  parent_group_id: string | null;
  status: "active" | "archived";
  created_by_user_id: string;
  created_at: number;
  updated_at: number;
};
type ManagedScopeMembershipRow = {
  scope_id: string;
  user_id: string;
  role: ManagedScopeRole;
  created_at: number;
  updated_at: number;
};
type AuditEventRow = {
  id: string;
  actor_user_id: string | null;
  event_type: string;
  target_type: string;
  target_id: string;
  details_json: string | null;
  created_at: number;
};

type ControlPlaneDatabase = {
  platform_users: PlatformUserRow;
  enterprise_identities: EnterpriseIdentityRow;
  user_directory_groups: DirectoryGroupRow;
  agent_bindings: AgentBindingRow;
  browser_sessions: BrowserSessionRow;
  managed_scopes: ManagedScopeRow;
  managed_scope_memberships: ManagedScopeMembershipRow;
  control_audit_events: AuditEventRow;
};

type SqliteControlPlaneStoreOptions = {
  databasePath: string;
  buildAgentMainSessionKey: MainSessionKeyBuilder;
  initialAdminAccountIds?: readonly string[];
  idFactory?: ControlPlaneIdFactory;
  sessionPolicy?: BrowserSessionPolicy;
};

const ALLOWED_AGENT_TRANSITIONS: Record<
  AgentProvisioningState,
  ReadonlySet<AgentProvisioningState>
> = {
  provisioning: new Set(["active", "failed", "disabled"]),
  active: new Set(["disabled"]),
  failed: new Set(["provisioning", "disabled"]),
  disabled: new Set(),
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ControlPlaneStateError(`${field} must not be empty`);
  }
  return normalized;
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizedGroups(groups: string[] | undefined): string[] {
  return [...new Set((groups ?? []).map((group) => group.trim()).filter(Boolean))].toSorted();
}

function normalizeEmployeeId(employeeId: string): string {
  return required(employeeId, "principal.employeeId").toLowerCase();
}

function normalizeScopeName(name: string): string {
  return required(name, "scope.name").toLocaleLowerCase("en-US");
}

function rowToIdentity(row: EnterpriseIdentityRow): EnterpriseIdentity {
  return {
    provider: row.provider,
    subject: row.subject,
    userId: row.user_id,
    employeeId: row.employee_id,
    createdAt: row.created_at,
    lastAuthenticatedAt: row.last_authenticated_at,
  };
}

function rowToBinding(row: AgentBindingRow): AgentBinding {
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

function rowToSession(row: BrowserSessionRow): BrowserSession {
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

function rowToScope(row: ManagedScopeRow): ManagedScope {
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

function rowToMembership(row: ManagedScopeMembershipRow): ManagedScopeMembership {
  return {
    scopeId: row.scope_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteControlPlaneStore implements ControlPlaneStore, ControlPlaneManagementStore {
  private readonly db: DatabaseSync;
  private readonly query: Kysely<ControlPlaneDatabase>;
  private readonly buildAgentMainSessionKey: MainSessionKeyBuilder;
  private readonly idFactory: ControlPlaneIdFactory;
  private readonly sessionPolicy: BrowserSessionPolicy;
  private readonly initialAdminAccountIds: ReadonlySet<string>;

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

  async upsertPrincipal(
    principal: EnterprisePrincipal,
    authenticatedAt: number,
  ): Promise<UpsertPrincipalResult> {
    return runImmediateTransaction(this.db, () => {
      const subject = required(principal.subject, "principal.subject");
      const employeeId = normalizeEmployeeId(principal.employeeId);
      const identity = this.selectIdentity(principal.provider, subject);
      if (identity) {
        if (
          authenticatedAt < identity.last_authenticated_at ||
          (authenticatedAt === identity.last_authenticated_at &&
            employeeId !== identity.employee_id)
        ) {
          throw new ControlPlaneConflictError(
            "stale_authentication",
            `authentication result is older than the current identity version: ${principal.provider}:${subject}`,
          );
        }
        const user = this.requireUserRow(identity.user_id);
        if (employeeId !== user.employee_id) {
          if (identity.employee_id !== user.employee_id) {
            throw new ControlPlaneConflictError(
              "employee_id_mismatch",
              `identity employee id disagrees with the canonical user: ${principal.provider}:${subject}`,
            );
          }
          const owner = this.selectUserByEmployeeId(employeeId);
          if (owner && owner.id !== user.id) {
            throw new ControlPlaneConflictError(
              "employee_id_conflict",
              `employee id already belongs to another user: ${employeeId}`,
            );
          }
        }
        this.updateUserFromPrincipal(user.id, employeeId, principal, authenticatedAt);
        this.bootstrapExistingAdminIfNeeded(user.id, authenticatedAt);
        executeSync(
          this.db,
          this.query
            .updateTable("enterprise_identities")
            .set({ employee_id: employeeId, last_authenticated_at: authenticatedAt })
            .where("provider", "=", principal.provider)
            .where("subject", "=", subject),
        );
        this.replaceDirectoryGroups(user.id, principal.groups);
        return {
          user: this.requireUser(user.id),
          identity: rowToIdentity(this.selectIdentity(principal.provider, subject)!),
          createdUser: false,
          createdIdentity: false,
        };
      }

      let user = this.selectUserByEmployeeId(employeeId);
      const createdUser = !user;
      if (!user) {
        const id = this.idFactory.nextUserId();
        const accountId = employeeId.toLowerCase();
        executeSync(
          this.db,
          this.query.insertInto("platform_users").values({
            id,
            account_id: accountId,
            employee_id: employeeId,
            display_name: optional(principal.displayName),
            email: optional(principal.email),
            department: optional(principal.department),
            timezone: null,
            status: "active",
            global_role: this.initialAdminAccountIds.has(accountId) ? "admin" : "member",
            created_at: authenticatedAt,
            updated_at: authenticatedAt,
            last_login_at: authenticatedAt,
          }),
        );
        user = this.requireUserRow(id);
      } else {
        this.updateUserFromPrincipal(user.id, employeeId, principal, authenticatedAt);
        this.bootstrapExistingAdminIfNeeded(user.id, authenticatedAt);
      }
      this.replaceDirectoryGroups(user.id, principal.groups);
      executeSync(
        this.db,
        this.query.insertInto("enterprise_identities").values({
          provider: principal.provider,
          subject,
          user_id: user.id,
          employee_id: employeeId,
          created_at: authenticatedAt,
          last_authenticated_at: authenticatedAt,
        }),
      );
      return {
        user: this.requireUser(user.id),
        identity: rowToIdentity(this.selectIdentity(principal.provider, subject)!),
        createdUser,
        createdIdentity: true,
      };
    });
  }

  async getUserById(userId: string): Promise<PlatformUser | null> {
    const row = this.selectUserById(userId);
    return row ? this.rowToUser(row) : null;
  }

  async getUserByEmployeeId(employeeId: string): Promise<PlatformUser | null> {
    const row = this.selectUserByEmployeeId(employeeId.trim().toLowerCase());
    return row ? this.rowToUser(row) : null;
  }

  async reservePersonalAgent(
    userId: string,
    reservedAt: number,
  ): Promise<AgentReservationResult<PersonalAgentBinding>> {
    return runImmediateTransaction(this.db, () => {
      const user = this.requireUserRow(userId);
      if (user.status !== "active") {
        throw new ControlPlaneStateError(`cannot provision agent for disabled user: ${userId}`);
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .selectAll()
          .where("kind", "=", "personal")
          .where("user_id", "=", userId),
      );
      if (existing) {
        return { binding: rowToBinding(existing) as PersonalAgentBinding, created: false };
      }
      const agentId = derivePersonalAgentId(user.account_id);
      this.assertAgentIdAvailable(agentId);
      const row: AgentBindingRow = {
        id: this.idFactory.nextBindingId(),
        kind: "personal",
        user_id: userId,
        knox_account_id: null,
        room_id: null,
        agent_id: agentId,
        state: "provisioning",
        failure_code: null,
        created_at: reservedAt,
        updated_at: reservedAt,
      };
      executeSync(this.db, this.query.insertInto("agent_bindings").values(row));
      this.insertAudit(null, "agent.binding.created", "agent-binding", row.id, reservedAt, {
        kind: row.kind,
        agentId: row.agent_id,
        userId,
      });
      return { binding: rowToBinding(row) as PersonalAgentBinding, created: true };
    });
  }

  async reserveKnoxRoomAgent(params: {
    accountId: string;
    roomId: string;
    reservedAt: number;
  }): Promise<AgentReservationResult<KnoxRoomAgentBinding>> {
    return runImmediateTransaction(this.db, () => {
      const accountId = required(params.accountId, "accountId");
      const roomId = required(params.roomId, "roomId");
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .selectAll()
          .where("kind", "=", "knox-room")
          .where("knox_account_id", "=", accountId)
          .where("room_id", "=", roomId),
      );
      if (existing) {
        return { binding: rowToBinding(existing) as KnoxRoomAgentBinding, created: false };
      }
      const agentId = deriveKnoxRoomAgentId(roomId);
      this.assertAgentIdAvailable(agentId);
      const row: AgentBindingRow = {
        id: this.idFactory.nextBindingId(),
        kind: "knox-room",
        user_id: null,
        knox_account_id: accountId,
        room_id: roomId,
        agent_id: agentId,
        state: "provisioning",
        failure_code: null,
        created_at: params.reservedAt,
        updated_at: params.reservedAt,
      };
      executeSync(this.db, this.query.insertInto("agent_bindings").values(row));
      this.insertAudit(null, "agent.binding.created", "agent-binding", row.id, params.reservedAt, {
        kind: row.kind,
        agentId: row.agent_id,
        accountId,
        roomId,
      });
      return { binding: rowToBinding(row) as KnoxRoomAgentBinding, created: true };
    });
  }

  async transitionAgent(params: {
    bindingId: string;
    state: AgentProvisioningState;
    changedAt: number;
    failureCode?: string;
  }): Promise<AgentBinding> {
    return runImmediateTransaction(this.db, () => {
      const current = this.requireBindingRow(params.bindingId);
      if (
        current.state !== params.state &&
        !ALLOWED_AGENT_TRANSITIONS[current.state].has(params.state)
      ) {
        throw new ControlPlaneStateError(
          `invalid agent transition: ${current.state} -> ${params.state}`,
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("agent_bindings")
          .set({
            state: params.state,
            failure_code:
              params.state === "failed"
                ? required(params.failureCode ?? "unknown", "failureCode")
                : null,
            updated_at: params.changedAt,
          })
          .where("id", "=", params.bindingId),
      );
      this.insertAudit(
        null,
        "agent.binding.transitioned",
        "agent-binding",
        current.id,
        params.changedAt,
        {
          from: current.state,
          to: params.state,
          ...(params.state === "failed" ? { failureCode: params.failureCode ?? "unknown" } : {}),
        },
      );
      return rowToBinding(this.requireBindingRow(params.bindingId));
    });
  }

  async createBrowserSession(params: {
    userId: string;
    tokenHash: string;
    createdAt: number;
  }): Promise<CreateBrowserSessionResult> {
    return runImmediateTransaction(this.db, () => {
      const user = this.requireUserRow(params.userId);
      if (user.status !== "active") {
        throw new ControlPlaneStateError(`cannot create session for disabled user: ${user.id}`);
      }
      const tokenHash = required(params.tokenHash, "tokenHash");
      if (
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("browser_sessions")
            .select("id")
            .where("token_hash", "=", tokenHash),
        )
      ) {
        throw new ControlPlaneConflictError(
          "session_token_conflict",
          "session token hash already exists",
        );
      }
      const activeSessionCount = executeSync(
        this.db,
        this.query
          .selectFrom("browser_sessions")
          .select("id")
          .where("user_id", "=", user.id)
          .where("revoked_at", "is", null)
          .where("idle_expires_at", ">", params.createdAt)
          .where("absolute_expires_at", ">", params.createdAt),
      ).rows.length;
      if (activeSessionCount >= this.sessionPolicy.maxConcurrentSessions) {
        return { status: "limit-reached", activeSessionCount };
      }
      const absoluteExpiresAt = params.createdAt + this.sessionPolicy.absoluteTimeoutMs;
      const row: BrowserSessionRow = {
        id: this.idFactory.nextSessionId(),
        user_id: user.id,
        token_hash: tokenHash,
        created_at: params.createdAt,
        last_seen_at: params.createdAt,
        idle_expires_at: Math.min(
          params.createdAt + this.sessionPolicy.idleTimeoutMs,
          absoluteExpiresAt,
        ),
        absolute_expires_at: absoluteExpiresAt,
        revoked_at: null,
      };
      executeSync(this.db, this.query.insertInto("browser_sessions").values(row));
      return { status: "created", session: rowToSession(row) };
    });
  }

  async resolveBrowserSession(params: {
    tokenHash: string;
    resolvedAt: number;
    touch?: boolean;
  }): Promise<BrowserSessionResolution> {
    return runImmediateTransaction(this.db, () => {
      const row = takeFirstSync(
        this.db,
        this.query
          .selectFrom("browser_sessions")
          .selectAll()
          .where("token_hash", "=", params.tokenHash),
      );
      if (!row) {
        return { status: "not-found" };
      }
      if (row.revoked_at !== null) {
        return { status: "revoked", session: rowToSession(row) };
      }
      if (params.resolvedAt >= row.absolute_expires_at) {
        return { status: "expired", reason: "absolute", session: rowToSession(row) };
      }
      if (params.resolvedAt >= row.idle_expires_at) {
        return { status: "expired", reason: "idle", session: rowToSession(row) };
      }
      const user = this.requireUser(row.user_id);
      if (user.status !== "active") {
        return { status: "user-disabled", session: rowToSession(row), user };
      }
      if (params.touch !== false) {
        const idleExpiresAt = Math.min(
          params.resolvedAt + this.sessionPolicy.idleTimeoutMs,
          row.absolute_expires_at,
        );
        executeSync(
          this.db,
          this.query
            .updateTable("browser_sessions")
            .set({ last_seen_at: params.resolvedAt, idle_expires_at: idleExpiresAt })
            .where("id", "=", row.id),
        );
        row.last_seen_at = params.resolvedAt;
        row.idle_expires_at = idleExpiresAt;
      }
      return { status: "active", session: rowToSession(row), user };
    });
  }

  async revokeBrowserSession(sessionId: string, revokedAt: number): Promise<BrowserSession | null> {
    return runImmediateTransaction(this.db, () => {
      const row = takeFirstSync(
        this.db,
        this.query.selectFrom("browser_sessions").selectAll().where("id", "=", sessionId),
      );
      if (!row) {
        return null;
      }
      if (row.revoked_at === null) {
        executeSync(
          this.db,
          this.query
            .updateTable("browser_sessions")
            .set({ revoked_at: revokedAt })
            .where("id", "=", sessionId),
        );
        row.revoked_at = revokedAt;
      }
      return rowToSession(row);
    });
  }

  async resolveAuthenticatedKnoxDmRoute(params: {
    employeeId: string;
    agentId: string;
    sessionKey: string;
  }): Promise<KnoxDmRouteResolution> {
    const userRow = this.selectUserByEmployeeId(params.employeeId.trim().toLowerCase());
    if (!userRow) {
      return { status: "user-not-found" };
    }
    if (userRow.status !== "active") {
      return { status: "agent-unavailable" };
    }
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .selectAll()
        .where("kind", "=", "personal")
        .where("user_id", "=", userRow.id),
    );
    if (!row || row.state !== "active") {
      return { status: "agent-unavailable" };
    }
    const binding = rowToBinding(row) as PersonalAgentBinding;
    const sessionKey = this.buildAgentMainSessionKey({ agentId: binding.agentId });
    if (params.agentId !== binding.agentId || params.sessionKey !== sessionKey) {
      return { status: "route-mismatch" };
    }
    return { status: "resolved", user: this.rowToUser(userRow), binding, sessionKey };
  }

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
    ).rows.map((row) => ({
      id: row.id,
      ...(row.actor_user_id ? { actorUserId: row.actor_user_id } : {}),
      eventType: row.event_type,
      targetType: row.target_type,
      targetId: row.target_id,
      ...(row.details_json
        ? { details: JSON.parse(row.details_json) as Record<string, unknown> }
        : {}),
      createdAt: row.created_at,
    }));
  }

  private rowToUser(row: PlatformUserRow): PlatformUser {
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

  private selectUserById(userId: string): PlatformUserRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").selectAll().where("id", "=", userId),
    );
  }

  private selectUserByEmployeeId(employeeId: string): PlatformUserRow | undefined {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").selectAll().where("employee_id", "=", employeeId),
    );
  }

  private requireUserRow(userId: string): PlatformUserRow {
    const row = this.selectUserById(userId);
    if (!row) {
      throw new ControlPlaneNotFoundError("user", userId);
    }
    return row;
  }

  private requireUser(userId: string): PlatformUser {
    return this.rowToUser(this.requireUserRow(userId));
  }

  private requireAdmin(userId: string): PlatformUserRow {
    const user = this.requireUserRow(userId);
    if (user.global_role !== "admin" || user.status !== "active") {
      throw new ControlPlaneAuthorizationError("active administrator required");
    }
    return user;
  }

  private selectIdentity(
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

  private updateUserFromPrincipal(
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

  private bootstrapExistingAdminIfNeeded(userId: string, changedAt: number): void {
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

  private replaceDirectoryGroups(userId: string, groups: string[] | undefined): void {
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

  private requireBindingRow(bindingId: string): AgentBindingRow {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("agent_bindings").selectAll().where("id", "=", bindingId),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("agent-binding", bindingId);
    }
    return row;
  }

  private assertAgentIdAvailable(agentId: string): void {
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

  private requireScopeRow(scopeId: string): ManagedScopeRow {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("managed_scopes").selectAll().where("id", "=", scopeId),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("managed-scope", scopeId);
    }
    return row;
  }

  private assertScopeNameAvailable(scope: ManagedScopeRow): void {
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

  private selectMembership(scopeId: string, userId: string): ManagedScopeMembershipRow | undefined {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .selectAll()
        .where("scope_id", "=", scopeId)
        .where("user_id", "=", userId),
    );
  }

  private isLeaderForScope(userId: string, scope: ManagedScopeRow): boolean {
    if (this.selectMembership(scope.id, userId)?.role === "leader") {
      return true;
    }
    return Boolean(
      scope.parent_group_id &&
      this.selectMembership(scope.parent_group_id, userId)?.role === "leader",
    );
  }

  private insertAudit(
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
