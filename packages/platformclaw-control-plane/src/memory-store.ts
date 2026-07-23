import {
  BROWSER_SESSION_POLICY,
  ControlPlaneConflictError,
  ControlPlaneAuthorizationError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type AgentBinding,
  type AgentProvisioningState,
  type AgentReservationResult,
  type BrowserSession,
  type BrowserSessionPolicy,
  type BrowserSessionResolution,
  type ControlAuditEvent,
  type ControlPlaneAuditReader,
  type ControlPlaneIdFactory,
  type ControlPlaneAuditWriter,
  type ControlPlaneStore,
  type CreateBrowserSessionResult,
  type EnterpriseIdentity,
  type EnterprisePrincipal,
  type KnoxDmRouteResolution,
  type KnoxRoomAgentBinding,
  type MainSessionKeyBuilder,
  type PersonalAgentBinding,
  type PersonalExecutionProfile,
  type PlatformUser,
  type PlatformUserStatus,
  type UpsertPrincipalResult,
} from "./contracts.js";
import type {
  ControlPlaneExecutionManagementStore,
  SafeConnectEndpoint,
  VmAllocation,
  VmHost,
} from "./execution-contracts.js";
import { InMemoryExecutionManagementStore } from "./execution-memory-store.js";
import {
  defaultControlPlaneIdFactory,
  deriveKnoxRoomAgentId,
  derivePersonalAgentId,
} from "./ids.js";
import { InMemorySshCredentialStoreBase } from "./ssh-credential-memory-store.js";

type MemoryStoreOptions = {
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
  active: new Set(["failed", "disabled"]),
  failed: new Set(["provisioning", "disabled"]),
  disabled: new Set(),
};

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ControlPlaneStateError(`${field} must not be empty`);
  }
  return normalized;
}

function identityKey(provider: string, subject: string): string {
  return `${provider}\0${subject}`;
}

function roomKey(accountId: string, roomId: string): string {
  return `${accountId}\0${roomId}`;
}

function cloneUser(user: PlatformUser): PlatformUser {
  return { ...user, groups: [...user.groups] };
}

function cloneIdentity(identity: EnterpriseIdentity): EnterpriseIdentity {
  return { ...identity };
}

function cloneBinding<TBinding extends AgentBinding>(binding: TBinding): TBinding {
  return { ...binding };
}

function cloneSession(session: BrowserSession): BrowserSession {
  return { ...session };
}

function copyOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeGroups(groups: string[] | undefined): string[] {
  return [...new Set((groups ?? []).map((group) => group.trim()).filter(Boolean))].toSorted();
}

function normalizeEmployeeId(employeeId: string): string {
  return requireNonEmpty(employeeId, "principal.employeeId").toLowerCase();
}

export class InMemoryControlPlaneStore
  extends InMemorySshCredentialStoreBase
  implements
    ControlPlaneStore,
    ControlPlaneAuditWriter,
    ControlPlaneAuditReader,
    ControlPlaneExecutionManagementStore
{
  private readonly buildAgentMainSessionKey: MainSessionKeyBuilder;
  private readonly idFactory: ControlPlaneIdFactory;
  private readonly sessionPolicy: BrowserSessionPolicy;
  private readonly initialAdminAccountIds: ReadonlySet<string>;
  private readonly users = new Map<string, PlatformUser>();
  private readonly userIdByAccountId = new Map<string, string>();
  private readonly userIdByEmployeeId = new Map<string, string>();
  private readonly identities = new Map<string, EnterpriseIdentity>();
  private readonly bindings = new Map<string, AgentBinding>();
  private readonly personalBindingIdByUserId = new Map<string, string>();
  private readonly roomBindingIdByKey = new Map<string, string>();
  private readonly bindingIdByAgentId = new Map<string, string>();
  private readonly executionProfiles = new Map<string, PersonalExecutionProfile>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly sessionIdByTokenHash = new Map<string, string>();
  private readonly sessionIdsByUserId = new Map<string, Set<string>>();
  private readonly auditEvents: ControlAuditEvent[] = [];
  private readonly executionManagement: InMemoryExecutionManagementStore;

  constructor(options: MemoryStoreOptions) {
    super(options.idFactory ?? defaultControlPlaneIdFactory);
    this.buildAgentMainSessionKey = options.buildAgentMainSessionKey;
    this.idFactory = options.idFactory ?? defaultControlPlaneIdFactory;
    this.sessionPolicy = options.sessionPolicy ?? BROWSER_SESSION_POLICY;
    this.initialAdminAccountIds = new Set(
      (options.initialAdminAccountIds ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    this.executionManagement = new InMemoryExecutionManagementStore({
      idFactory: this.idFactory,
      requireAdmin: (actorUserId) => {
        const actor = this.requireUser(actorUserId);
        if (actor.status !== "active" || actor.globalRole !== "admin") {
          throw new ControlPlaneAuthorizationError("active administrator required");
        }
      },
      getPersonalBinding: (agentId) => {
        const bindingId = this.bindingIdByAgentId.get(agentId);
        if (!bindingId) {
          return null;
        }
        const binding = this.bindings.get(bindingId);
        return binding?.kind === "personal" ? cloneBinding(binding) : null;
      },
      recordAudit: (params) => {
        this.appendAuditEvent(params);
      },
    });
  }

  createSafeConnectEndpoint(
    params: Parameters<ControlPlaneExecutionManagementStore["createSafeConnectEndpoint"]>[0],
  ): Promise<SafeConnectEndpoint> {
    return this.executionManagement.createSafeConnectEndpoint(params);
  }

  approveSafeConnectHostKey(
    params: Parameters<ControlPlaneExecutionManagementStore["approveSafeConnectHostKey"]>[0],
  ): Promise<SafeConnectEndpoint> {
    return this.executionManagement.approveSafeConnectHostKey(params);
  }

  createVmHost(
    params: Parameters<ControlPlaneExecutionManagementStore["createVmHost"]>[0],
  ): Promise<VmHost> {
    return this.executionManagement.createVmHost(params);
  }

  assignVmToPersonalAgent(
    params: Parameters<ControlPlaneExecutionManagementStore["assignVmToPersonalAgent"]>[0],
  ): Promise<VmAllocation> {
    return this.executionManagement.assignVmToPersonalAgent(params);
  }

  getVmAllocationForAgent(agentId: string): Promise<VmAllocation | null> {
    return this.executionManagement.getVmAllocationForAgent(agentId);
  }

  async upsertPrincipal(
    principal: EnterprisePrincipal,
    authenticatedAt: number,
  ): Promise<UpsertPrincipalResult> {
    const subject = requireNonEmpty(principal.subject, "principal.subject");
    const employeeId = normalizeEmployeeId(principal.employeeId);
    const requestedAccountId = principal.accountId
      ? normalizeEmployeeId(principal.accountId)
      : undefined;
    const key = identityKey(principal.provider, subject);
    const existingIdentity = this.identities.get(key);

    if (existingIdentity) {
      const user = this.requireUser(existingIdentity.userId);
      if (requestedAccountId && requestedAccountId !== user.accountId) {
        throw new ControlPlaneConflictError(
          "account_id_mismatch",
          `identity account id disagrees with the canonical user: ${principal.provider}:${subject}`,
        );
      }
      if (
        authenticatedAt < existingIdentity.lastAuthenticatedAt ||
        (authenticatedAt === existingIdentity.lastAuthenticatedAt &&
          employeeId !== existingIdentity.employeeId)
      ) {
        throw new ControlPlaneConflictError(
          "stale_authentication",
          `authentication result is older than the current identity version: ${principal.provider}:${subject}`,
        );
      }
      this.reconcileIdentityEmployeeId(existingIdentity, user, employeeId);
      this.updateUserFromPrincipal(user, principal, authenticatedAt);
      existingIdentity.lastAuthenticatedAt = authenticatedAt;
      return {
        user: cloneUser(user),
        identity: cloneIdentity(existingIdentity),
        createdUser: false,
        createdIdentity: false,
      };
    }

    const accountOwnerId = requestedAccountId
      ? this.userIdByAccountId.get(requestedAccountId)
      : undefined;
    const employeeOwnerId = this.userIdByEmployeeId.get(employeeId);
    if (accountOwnerId && employeeOwnerId && accountOwnerId !== employeeOwnerId) {
      throw new ControlPlaneConflictError(
        "account_id_conflict",
        `account id and employee id belong to different users: ${requestedAccountId}`,
      );
    }
    const existingUserId = accountOwnerId ?? employeeOwnerId;
    const existingUser = existingUserId ? this.requireUser(existingUserId) : undefined;
    const accountId = requestedAccountId ?? existingUser?.accountId ?? employeeId;
    const user = existingUserId
      ? existingUser!
      : this.createUser(accountId, employeeId, principal, authenticatedAt);
    if (existingUser) {
      if (requestedAccountId && user.accountId !== requestedAccountId) {
        throw new ControlPlaneConflictError(
          "account_id_mismatch",
          `account id disagrees with the canonical user: ${requestedAccountId}`,
        );
      }
      this.updateUserFromPrincipal(user, principal, authenticatedAt);
    }

    const identity: EnterpriseIdentity = {
      provider: principal.provider,
      subject,
      userId: user.id,
      employeeId,
      createdAt: authenticatedAt,
      lastAuthenticatedAt: authenticatedAt,
    };
    this.identities.set(key, identity);
    return {
      user: cloneUser(user),
      identity: cloneIdentity(identity),
      createdUser: !existingUserId,
      createdIdentity: true,
    };
  }

  async getUserById(userId: string): Promise<PlatformUser | null> {
    const user = this.users.get(userId);
    return user ? cloneUser(user) : null;
  }

  async getUserByEmployeeId(employeeId: string): Promise<PlatformUser | null> {
    const userId = this.userIdByEmployeeId.get(employeeId.trim().toLowerCase());
    const user = userId ? this.users.get(userId) : undefined;
    return user ? cloneUser(user) : null;
  }

  async getPersonalAgentBinding(userId: string): Promise<PersonalAgentBinding | null> {
    const bindingId = this.personalBindingIdByUserId.get(userId);
    return bindingId ? cloneBinding(this.requirePersonalBinding(bindingId)) : null;
  }

  async getPersonalExecutionProfile(agentId: string): Promise<PersonalExecutionProfile | null> {
    const bindingId = this.bindingIdByAgentId.get(agentId);
    const profile = bindingId ? this.executionProfiles.get(bindingId) : undefined;
    return profile ? { ...profile } : null;
  }

  async recordAuditEvent(params: {
    actorUserId?: string;
    eventType: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
    createdAt: number;
  }): Promise<ControlAuditEvent> {
    return this.appendAuditEvent(params);
  }

  async listAuditEvents(limit = 100): Promise<ControlAuditEvent[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), 500))
      : 100;
    return this.auditEvents
      .toReversed()
      .slice(0, boundedLimit)
      .map((event) => structuredClone(event));
  }

  protected isActiveCredentialUser(userId: string): boolean {
    return this.users.get(userId)?.status === "active";
  }

  protected recordCredentialAudit(params: {
    actorUserId?: string;
    eventType: string;
    targetType: string;
    targetId: string;
    createdAt: number;
    details?: Record<string, unknown>;
  }): void {
    this.appendAuditEvent(params);
  }

  private appendAuditEvent(params: {
    actorUserId?: string;
    eventType: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
    createdAt: number;
  }): ControlAuditEvent {
    const event: ControlAuditEvent = {
      id: this.idFactory.nextAuditEventId(),
      ...(params.actorUserId ? { actorUserId: params.actorUserId } : {}),
      eventType: requireNonEmpty(params.eventType, "eventType"),
      targetType: requireNonEmpty(params.targetType, "targetType"),
      targetId: requireNonEmpty(params.targetId, "targetId"),
      ...(params.details ? { details: structuredClone(params.details) } : {}),
      createdAt: params.createdAt,
    };
    this.auditEvents.push(event);
    return structuredClone(event);
  }

  async setManagedUserStatus(params: {
    actorUserId: string;
    targetUserId: string;
    status: PlatformUserStatus;
    changedAt: number;
  }): Promise<PlatformUser> {
    const actor = this.requireUser(params.actorUserId);
    const user = this.requireUser(params.targetUserId);
    if (actor.status !== "active" || actor.globalRole !== "admin") {
      throw new ControlPlaneAuthorizationError("active administrator required");
    }
    if (actor.id === user.id && actor.status !== params.status) {
      throw new ControlPlaneStateError("administrators cannot change their own status");
    }
    user.status = params.status;
    user.updatedAt = params.changedAt;
    if (params.status === "disabled") {
      for (const sessionId of this.sessionIdsByUserId.get(user.id) ?? []) {
        const session = this.sessions.get(sessionId);
        if (session && session.revokedAt === undefined) {
          session.revokedAt = params.changedAt;
        }
      }
    }
    return cloneUser(user);
  }

  async reservePersonalAgent(
    userId: string,
    reservedAt: number,
  ): Promise<AgentReservationResult<PersonalAgentBinding>> {
    const user = this.requireUser(userId);
    if (user.status !== "active") {
      throw new ControlPlaneStateError(`cannot provision agent for disabled user: ${userId}`);
    }
    const existingId = this.personalBindingIdByUserId.get(userId);
    if (existingId) {
      return {
        binding: cloneBinding(this.requirePersonalBinding(existingId)),
        created: false,
      };
    }

    const binding: PersonalAgentBinding = {
      id: this.idFactory.nextBindingId(),
      kind: "personal",
      userId,
      agentId: derivePersonalAgentId(user.accountId),
      state: "provisioning",
      createdAt: reservedAt,
      updatedAt: reservedAt,
    };
    this.insertBinding(binding);
    this.personalBindingIdByUserId.set(userId, binding.id);
    this.executionProfiles.set(binding.id, {
      agentBindingId: binding.id,
      activeTarget: "platform_server",
      targetRevision: 0,
      updatedAt: reservedAt,
    });
    return { binding: cloneBinding(binding), created: true };
  }

  async listAgentBindingsByState(state: AgentProvisioningState): Promise<AgentBinding[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.state === state)
      .toSorted(
        (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
      )
      .map((binding) => cloneBinding(binding));
  }

  async reserveKnoxRoomAgent(params: {
    accountId: string;
    roomId: string;
    reservedAt: number;
  }): Promise<AgentReservationResult<KnoxRoomAgentBinding>> {
    const accountId = requireNonEmpty(params.accountId, "accountId");
    const roomId = requireNonEmpty(params.roomId, "roomId");
    const key = roomKey(accountId, roomId);
    const existingId = this.roomBindingIdByKey.get(key);
    if (existingId) {
      return {
        binding: cloneBinding(this.requireRoomBinding(existingId)),
        created: false,
      };
    }

    const binding: KnoxRoomAgentBinding = {
      id: this.idFactory.nextBindingId(),
      kind: "knox-room",
      accountId,
      roomId,
      agentId: deriveKnoxRoomAgentId(roomId),
      state: "provisioning",
      createdAt: params.reservedAt,
      updatedAt: params.reservedAt,
    };
    this.insertBinding(binding);
    this.roomBindingIdByKey.set(key, binding.id);
    return { binding: cloneBinding(binding), created: true };
  }

  async transitionAgent(params: {
    bindingId: string;
    state: AgentProvisioningState;
    changedAt: number;
    failureCode?: string;
  }): Promise<AgentBinding> {
    const binding = this.requireBinding(params.bindingId);
    if (
      binding.state !== params.state &&
      !ALLOWED_AGENT_TRANSITIONS[binding.state].has(params.state)
    ) {
      throw new ControlPlaneStateError(
        `invalid agent transition: ${binding.state} -> ${params.state}`,
      );
    }
    binding.state = params.state;
    binding.updatedAt = params.changedAt;
    if (params.state === "failed") {
      binding.failureCode = requireNonEmpty(params.failureCode ?? "unknown", "failureCode");
    } else {
      delete binding.failureCode;
    }
    return cloneBinding(binding);
  }

  async createBrowserSession(params: {
    userId: string;
    tokenHash: string;
    createdAt: number;
  }): Promise<CreateBrowserSessionResult> {
    const user = this.requireUser(params.userId);
    if (user.status !== "active") {
      throw new ControlPlaneStateError(`cannot create session for disabled user: ${user.id}`);
    }
    const tokenHash = requireNonEmpty(params.tokenHash, "tokenHash");
    if (this.sessionIdByTokenHash.has(tokenHash)) {
      throw new ControlPlaneConflictError(
        "session_token_conflict",
        "session token hash already exists",
      );
    }
    const activeSessionCount = this.countActiveSessions(user.id, params.createdAt);
    if (activeSessionCount >= this.sessionPolicy.maxConcurrentSessions) {
      return { status: "limit-reached", activeSessionCount };
    }

    const absoluteExpiresAt = params.createdAt + this.sessionPolicy.absoluteTimeoutMs;
    const session: BrowserSession = {
      id: this.idFactory.nextSessionId(),
      userId: user.id,
      tokenHash,
      createdAt: params.createdAt,
      lastSeenAt: params.createdAt,
      idleExpiresAt: Math.min(
        params.createdAt + this.sessionPolicy.idleTimeoutMs,
        absoluteExpiresAt,
      ),
      absoluteExpiresAt,
    };
    this.sessions.set(session.id, session);
    this.sessionIdByTokenHash.set(tokenHash, session.id);
    const userSessions = this.sessionIdsByUserId.get(user.id) ?? new Set<string>();
    userSessions.add(session.id);
    this.sessionIdsByUserId.set(user.id, userSessions);
    return { status: "created", session: cloneSession(session) };
  }

  async resolveBrowserSession(params: {
    tokenHash: string;
    resolvedAt: number;
    touch?: boolean;
  }): Promise<BrowserSessionResolution> {
    const sessionId = this.sessionIdByTokenHash.get(params.tokenHash);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      return { status: "not-found" };
    }
    if (session.revokedAt !== undefined) {
      return { status: "revoked", session: cloneSession(session) };
    }
    const expiryReason = this.resolveExpiryReason(session, params.resolvedAt);
    if (expiryReason) {
      return { status: "expired", reason: expiryReason, session: cloneSession(session) };
    }
    const user = this.requireUser(session.userId);
    if (user.status !== "active") {
      return { status: "user-disabled", session: cloneSession(session), user: cloneUser(user) };
    }
    if (params.touch !== false) {
      session.lastSeenAt = params.resolvedAt;
      session.idleExpiresAt = Math.min(
        params.resolvedAt + this.sessionPolicy.idleTimeoutMs,
        session.absoluteExpiresAt,
      );
    }
    return { status: "active", session: cloneSession(session), user: cloneUser(user) };
  }

  async revokeBrowserSession(sessionId: string, revokedAt: number): Promise<BrowserSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    session.revokedAt ??= revokedAt;
    return cloneSession(session);
  }

  async resolveAuthenticatedKnoxDmRoute(params: {
    employeeId: string;
    agentId: string;
    sessionKey: string;
  }): Promise<KnoxDmRouteResolution> {
    const userId = this.userIdByEmployeeId.get(params.employeeId.trim().toLowerCase());
    const user = userId ? this.users.get(userId) : undefined;
    if (!user) {
      return { status: "user-not-found" };
    }
    if (user.status !== "active") {
      return { status: "agent-unavailable" };
    }
    const bindingId = this.personalBindingIdByUserId.get(user.id);
    const binding = bindingId ? this.bindings.get(bindingId) : undefined;
    if (!binding || binding.kind !== "personal" || binding.state !== "active") {
      return { status: "agent-unavailable" };
    }
    const expectedSessionKey = this.buildAgentMainSessionKey({ agentId: binding.agentId });
    if (params.agentId !== binding.agentId || params.sessionKey !== expectedSessionKey) {
      return { status: "route-mismatch" };
    }
    return {
      status: "resolved",
      user: cloneUser(user),
      binding: cloneBinding(binding),
      sessionKey: expectedSessionKey,
    };
  }

  private createUser(
    accountId: string,
    employeeId: string,
    principal: EnterprisePrincipal,
    createdAt: number,
  ): PlatformUser {
    const user: PlatformUser = {
      id: this.idFactory.nextUserId(),
      accountId,
      employeeId,
      status: "active",
      globalRole: this.initialAdminAccountIds.has(accountId) ? "admin" : "member",
      groups: normalizeGroups(principal.groups),
      createdAt,
      updatedAt: createdAt,
      ...this.profileFields(principal),
    };
    this.users.set(user.id, user);
    this.userIdByAccountId.set(accountId, user.id);
    this.userIdByEmployeeId.set(employeeId, user.id);
    return user;
  }

  private updateUserFromPrincipal(
    user: PlatformUser,
    principal: EnterprisePrincipal,
    updatedAt: number,
  ) {
    user.groups = normalizeGroups(principal.groups);
    user.updatedAt = updatedAt;
    const profile = this.profileFields(principal);
    for (const field of ["displayName", "email", "department"] as const) {
      if (profile[field] === undefined) {
        delete user[field];
      } else {
        user[field] = profile[field];
      }
    }
  }

  private profileFields(principal: EnterprisePrincipal) {
    return {
      displayName: copyOptional(principal.displayName),
      email: copyOptional(principal.email),
      department: copyOptional(principal.department),
    };
  }

  private moveEmployeeId(user: PlatformUser, employeeId: string) {
    if (user.employeeId === employeeId) {
      return;
    }
    const owner = this.userIdByEmployeeId.get(employeeId);
    if (owner && owner !== user.id) {
      throw new ControlPlaneConflictError(
        "employee_id_conflict",
        `employee id already belongs to another user: ${employeeId}`,
      );
    }
    this.userIdByEmployeeId.delete(user.employeeId);
    this.userIdByEmployeeId.set(employeeId, user.id);
    user.employeeId = employeeId;
  }

  private reconcileIdentityEmployeeId(
    identity: EnterpriseIdentity,
    user: PlatformUser,
    employeeId: string,
  ) {
    if (employeeId === user.employeeId) {
      identity.employeeId = employeeId;
      return;
    }
    if (identity.employeeId !== user.employeeId) {
      throw new ControlPlaneConflictError(
        "employee_id_mismatch",
        `identity employee id disagrees with the canonical user: ${identity.provider}:${identity.subject}`,
      );
    }
    this.moveEmployeeId(user, employeeId);
    identity.employeeId = employeeId;
  }

  private insertBinding(binding: AgentBinding) {
    const existingBindingId = this.bindingIdByAgentId.get(binding.agentId);
    if (existingBindingId) {
      throw new ControlPlaneConflictError(
        "agent_id_conflict",
        `agent id already belongs to another binding: ${binding.agentId}`,
      );
    }
    this.bindings.set(binding.id, binding);
    this.bindingIdByAgentId.set(binding.agentId, binding.id);
  }

  private countActiveSessions(userId: string, at: number): number {
    let count = 0;
    for (const sessionId of this.sessionIdsByUserId.get(userId) ?? []) {
      const session = this.sessions.get(sessionId);
      if (session && session.revokedAt === undefined && !this.resolveExpiryReason(session, at)) {
        count += 1;
      }
    }
    return count;
  }

  private resolveExpiryReason(session: BrowserSession, at: number): "idle" | "absolute" | null {
    if (at >= session.absoluteExpiresAt) {
      return "absolute";
    }
    if (at >= session.idleExpiresAt) {
      return "idle";
    }
    return null;
  }

  private requireUser(userId: string): PlatformUser {
    const user = this.users.get(userId);
    if (!user) {
      throw new ControlPlaneNotFoundError("user", userId);
    }
    return user;
  }

  private requireBinding(bindingId: string): AgentBinding {
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      throw new ControlPlaneNotFoundError("agent-binding", bindingId);
    }
    return binding;
  }

  private requirePersonalBinding(bindingId: string): PersonalAgentBinding {
    const binding = this.requireBinding(bindingId);
    if (binding.kind !== "personal") {
      throw new ControlPlaneStateError(`binding is not personal: ${bindingId}`);
    }
    return binding;
  }

  private requireRoomBinding(bindingId: string): KnoxRoomAgentBinding {
    const binding = this.requireBinding(bindingId);
    if (binding.kind !== "knox-room") {
      throw new ControlPlaneStateError(`binding is not a Knox room: ${bindingId}`);
    }
    return binding;
  }
}
