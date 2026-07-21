import {
  ControlPlaneConflictError,
  ControlPlaneStateError,
  type AgentBinding,
  type AgentProvisioningState,
  type AgentReservationResult,
  type BrowserSession,
  type BrowserSessionResolution,
  type ControlAuditEvent,
  type CreateBrowserSessionResult,
  type EnterprisePrincipal,
  type KnoxDmRouteResolution,
  type KnoxRoomAgentBinding,
  type PersonalAgentBinding,
  type PlatformUser,
  type UpsertPrincipalResult,
} from "./contracts.js";
import { deriveKnoxRoomAgentId, derivePersonalAgentId } from "./ids.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import {
  ALLOWED_AGENT_TRANSITIONS,
  normalizeAccountId,
  normalizeEmployeeId,
  optional,
  required,
  rowToBinding,
  rowToIdentity,
  rowToSession,
  SqliteControlPlaneStoreCore,
} from "./sqlite-store-core.js";
import type { AgentBindingRow, BrowserSessionRow } from "./sqlite-store-types.js";

export abstract class SqliteControlPlaneAuthStore extends SqliteControlPlaneStoreCore {
  async upsertPrincipal(
    principal: EnterprisePrincipal,
    authenticatedAt: number,
  ): Promise<UpsertPrincipalResult> {
    return runImmediateTransaction(this.db, () => {
      const subject = required(principal.subject, "principal.subject");
      const employeeId = normalizeEmployeeId(principal.employeeId);
      const requestedAccountId = principal.accountId
        ? normalizeAccountId(principal.accountId)
        : undefined;
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
        if (requestedAccountId && requestedAccountId !== user.account_id) {
          throw new ControlPlaneConflictError(
            "account_id_mismatch",
            `identity account id disagrees with the canonical user: ${principal.provider}:${subject}`,
          );
        }
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

      const accountOwner = requestedAccountId
        ? this.selectUserByAccountId(requestedAccountId)
        : undefined;
      const employeeOwner = this.selectUserByEmployeeId(employeeId);
      if (accountOwner && employeeOwner && accountOwner.id !== employeeOwner.id) {
        throw new ControlPlaneConflictError(
          "account_id_conflict",
          `account id and employee id belong to different users: ${requestedAccountId}`,
        );
      }
      let user = accountOwner ?? employeeOwner;
      const accountId = requestedAccountId ?? user?.account_id ?? employeeId;
      const createdUser = !user;
      if (!user) {
        const id = this.idFactory.nextUserId();
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
        if (requestedAccountId && user.account_id !== requestedAccountId) {
          throw new ControlPlaneConflictError(
            "account_id_mismatch",
            `account id disagrees with the canonical user: ${requestedAccountId}`,
          );
        }
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

  async getPersonalAgentBinding(userId: string): Promise<PersonalAgentBinding | null> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .selectAll()
        .where("kind", "=", "personal")
        .where("user_id", "=", userId),
    );
    return row ? (rowToBinding(row) as PersonalAgentBinding) : null;
  }

  async recordAuditEvent(params: {
    actorUserId?: string;
    eventType: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
    createdAt: number;
  }): Promise<ControlAuditEvent> {
    const event: ControlAuditEvent = {
      id: this.idFactory.nextAuditEventId(),
      ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
      eventType: required(params.eventType, "eventType"),
      targetType: required(params.targetType, "targetType"),
      targetId: required(params.targetId, "targetId"),
      ...(params.details ? { details: params.details } : {}),
      createdAt: params.createdAt,
    };
    executeSync(
      this.db,
      this.query.insertInto("control_audit_events").values({
        id: event.id,
        actor_user_id: event.actorUserId ?? null,
        event_type: event.eventType,
        target_type: event.targetType,
        target_id: event.targetId,
        details_json: event.details ? JSON.stringify(event.details) : null,
        created_at: event.createdAt,
      }),
    );
    return event;
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

  async listAgentBindingsByState(state: AgentProvisioningState): Promise<AgentBinding[]> {
    return executeSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .selectAll()
        .where("state", "=", state)
        .orderBy("created_at", "asc")
        .orderBy("id", "asc"),
    ).rows.map((row) => rowToBinding(row));
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
}
