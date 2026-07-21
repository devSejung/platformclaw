export const BROWSER_SESSION_POLICY = {
  idleTimeoutMs: 12 * 60 * 60 * 1000,
  absoluteTimeoutMs: 7 * 24 * 60 * 60 * 1000,
  maxConcurrentSessions: 3,
} as const;

export type EnterpriseAuthProvider = "ldap" | "saml";

export type EnterprisePrincipal = {
  provider: EnterpriseAuthProvider;
  subject: string;
  accountId?: string;
  employeeId: string;
  displayName?: string;
  email?: string;
  department?: string;
  groups?: string[];
};

export type PlatformUserStatus = "active" | "disabled";
export type PlatformUserGlobalRole = "member" | "admin";
export type ManagedScopeKind = "group" | "part";
export type ManagedScopeStatus = "active" | "archived";
export type ManagedScopeRole = "member" | "leader";

export type PlatformUser = {
  id: string;
  accountId: string;
  employeeId: string;
  status: PlatformUserStatus;
  globalRole: PlatformUserGlobalRole;
  displayName?: string;
  email?: string;
  department?: string;
  timezone?: string;
  groups: string[];
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
};

export type EnterpriseIdentity = {
  provider: EnterpriseAuthProvider;
  subject: string;
  userId: string;
  employeeId: string;
  createdAt: number;
  lastAuthenticatedAt: number;
};

export type ManagedScope = {
  id: string;
  kind: ManagedScopeKind;
  name: string;
  parentGroupId?: string;
  status: ManagedScopeStatus;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type ManagedScopeMembership = {
  scopeId: string;
  userId: string;
  role: ManagedScopeRole;
  createdAt: number;
  updatedAt: number;
};

export type ControlAuditEvent = {
  id: string;
  actorUserId?: string;
  eventType: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown>;
  createdAt: number;
};

export type AgentProvisioningState = "provisioning" | "active" | "failed" | "disabled";

type AgentBindingBase = {
  id: string;
  agentId: string;
  state: AgentProvisioningState;
  createdAt: number;
  updatedAt: number;
  failureCode?: string;
};

export type PersonalAgentBinding = AgentBindingBase & {
  kind: "personal";
  userId: string;
};

export type KnoxRoomAgentBinding = AgentBindingBase & {
  kind: "knox-room";
  accountId: string;
  roomId: string;
};

export type AgentBinding = PersonalAgentBinding | KnoxRoomAgentBinding;

export type BrowserSession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
};

export type UpsertPrincipalResult = {
  user: PlatformUser;
  identity: EnterpriseIdentity;
  createdUser: boolean;
  createdIdentity: boolean;
};

export type AgentReservationResult<TBinding extends AgentBinding> = {
  binding: TBinding;
  created: boolean;
};

export type CreateBrowserSessionResult =
  | { status: "created"; session: BrowserSession }
  | { status: "limit-reached"; activeSessionCount: number };

export type BrowserSessionResolution =
  | { status: "active"; session: BrowserSession; user: PlatformUser }
  | { status: "not-found" }
  | { status: "revoked"; session: BrowserSession }
  | { status: "expired"; reason: "idle" | "absolute"; session: BrowserSession }
  | { status: "user-disabled"; session: BrowserSession; user: PlatformUser };

export type KnoxDmRouteResolution =
  | {
      status: "resolved";
      user: PlatformUser;
      binding: PersonalAgentBinding;
      sessionKey: string;
    }
  | { status: "user-not-found" }
  | { status: "agent-unavailable" }
  | { status: "route-mismatch" };

export type ControlPlaneIdFactory = {
  nextUserId(): string;
  nextBindingId(): string;
  nextSessionId(): string;
  nextManagedScopeId(): string;
  nextAuditEventId(): string;
};

export type MainSessionKeyBuilder = (params: { agentId: string }) => string;

export type BrowserSessionPolicy = {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxConcurrentSessions: number;
};

export interface ControlPlaneStore {
  upsertPrincipal(
    principal: EnterprisePrincipal,
    authenticatedAt: number,
  ): Promise<UpsertPrincipalResult>;
  getUserById(userId: string): Promise<PlatformUser | null>;
  getUserByEmployeeId(employeeId: string): Promise<PlatformUser | null>;
  getPersonalAgentBinding(userId: string): Promise<PersonalAgentBinding | null>;
  listAgentBindingsByState(state: AgentProvisioningState): Promise<AgentBinding[]>;
  reservePersonalAgent(
    userId: string,
    reservedAt: number,
  ): Promise<AgentReservationResult<PersonalAgentBinding>>;
  reserveKnoxRoomAgent(params: {
    accountId: string;
    roomId: string;
    reservedAt: number;
  }): Promise<AgentReservationResult<KnoxRoomAgentBinding>>;
  transitionAgent(params: {
    bindingId: string;
    state: AgentProvisioningState;
    changedAt: number;
    failureCode?: string;
  }): Promise<AgentBinding>;
  createBrowserSession(params: {
    userId: string;
    tokenHash: string;
    createdAt: number;
  }): Promise<CreateBrowserSessionResult>;
  resolveBrowserSession(params: {
    tokenHash: string;
    resolvedAt: number;
    touch?: boolean;
  }): Promise<BrowserSessionResolution>;
  revokeBrowserSession(sessionId: string, revokedAt: number): Promise<BrowserSession | null>;
  resolveAuthenticatedKnoxDmRoute(params: {
    employeeId: string;
    agentId: string;
    sessionKey: string;
  }): Promise<KnoxDmRouteResolution>;
}

export interface ControlPlaneAuditWriter {
  recordAuditEvent(params: {
    actorUserId?: string;
    eventType: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
    createdAt: number;
  }): Promise<ControlAuditEvent>;
}

export interface ControlPlaneManagementStore {
  setManagedUserStatus(params: {
    actorUserId: string;
    targetUserId: string;
    status: PlatformUserStatus;
    changedAt: number;
  }): Promise<PlatformUser>;
  setUserGlobalRole(params: {
    actorUserId: string;
    targetUserId: string;
    role: PlatformUserGlobalRole;
    changedAt: number;
  }): Promise<PlatformUser>;
  createManagedScope(params: {
    actorUserId: string;
    kind: ManagedScopeKind;
    name: string;
    parentGroupId?: string;
    createdAt: number;
  }): Promise<ManagedScope>;
  archiveManagedScope(params: {
    actorUserId: string;
    scopeId: string;
    archivedAt: number;
  }): Promise<ManagedScope>;
  setManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    role: ManagedScopeRole;
    changedAt: number;
  }): Promise<ManagedScopeMembership>;
  removeManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    changedAt: number;
  }): Promise<boolean>;
  listManagedScopes(): Promise<ManagedScope[]>;
  listManagedScopeMemberships(scopeId: string): Promise<ManagedScopeMembership[]>;
  listAuditEvents(limit?: number): Promise<ControlAuditEvent[]>;
}

export type ControlPlaneConflictCode =
  | "account_id_conflict"
  | "account_id_mismatch"
  | "employee_id_conflict"
  | "employee_id_mismatch"
  | "stale_authentication"
  | "agent_id_conflict"
  | "managed_scope_name_conflict"
  | "session_token_conflict";

export class ControlPlaneConflictError extends Error {
  constructor(
    readonly code: ControlPlaneConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "ControlPlaneConflictError";
  }
}

export class ControlPlaneNotFoundError extends Error {
  constructor(
    readonly resource: "user" | "agent-binding" | "managed-scope",
    id: string,
  ) {
    super(`${resource} not found: ${id}`);
    this.name = "ControlPlaneNotFoundError";
  }
}

export class ControlPlaneAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneAuthorizationError";
  }
}

export class ControlPlaneStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneStateError";
  }
}
