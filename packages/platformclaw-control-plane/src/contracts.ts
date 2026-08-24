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
export type ManagedScopeKind = "team" | "group" | "part";
export type ManagedScopeStatus = "active" | "archived";
export type ManagedScopeRole = "member" | "leader";
export type OrganizationMemoryScopeKind = "global" | ManagedScopeKind;
export type OrganizationMemoryPromotionSourceKind = "personal" | ManagedScopeKind;
export type OrganizationMemoryClaimStatus = "active" | "retired" | "purged";
export type OrganizationMemoryPromotionStatus = "pending" | "approved" | "rejected";

export type OrganizationMemorySearchHit = {
  id: string;
  path: string;
  scopeKind: OrganizationMemoryScopeKind;
  scopeId?: string;
  scopeName: string;
  title: string;
  snippet: string;
  score: number;
  updatedAt: number;
};

export type OrganizationMemoryDocument = OrganizationMemorySearchHit & {
  content: string;
  fromLine: number;
  lineCount: number;
};

export type OrganizationMemoryClaim = {
  id: string;
  scopeKind: OrganizationMemoryScopeKind;
  scopeName: string;
  scopeId?: string;
  title: string;
  text: string;
  revision: number;
  status: OrganizationMemoryClaimStatus;
  createdAt: number;
  updatedAt: number;
  sourceClaimId?: string;
  promotionTargets?: OrganizationMemoryPromotionTarget[];
  canRetire?: boolean;
  canPurge?: boolean;
};

export type OrganizationMemoryPromotionTarget = {
  kind: OrganizationMemoryScopeKind;
  scopeId?: string;
  scopeName: string;
  mode: "request" | "direct";
};

export type OrganizationMemoryLifecycleScope = {
  kind: OrganizationMemoryScopeKind;
  name: string;
  id?: string;
  parentScopeId?: string;
  canAdminister: boolean;
};

export type OrganizationMemoryPromotionRequest = {
  id: string;
  sourceKind: OrganizationMemoryPromotionSourceKind;
  sourceClaimId?: string;
  sourceRevision: number;
  targetKind: OrganizationMemoryScopeKind;
  targetScopeName: string;
  proposedText: string;
  evidence: string[];
  reason: string;
  status: OrganizationMemoryPromotionStatus;
  createdAt: number;
  decidedAt?: number;
  decisionReason?: string;
  targetClaimId?: string;
  canReview: boolean;
};

export type OrganizationMemoryLifecycleSnapshot = {
  scopes: OrganizationMemoryLifecycleScope[];
  personalTargets: OrganizationMemoryPromotionTarget[];
  claims: OrganizationMemoryClaim[];
  submitted: OrganizationMemoryPromotionRequest[];
  reviewable: OrganizationMemoryPromotionRequest[];
  canApproveGlobal: boolean;
  next?: {
    claims?: number;
    submitted?: number;
    reviewable?: number;
  };
};

/** Trusted resolution of a personal Wiki page before shared-memory promotion. */
export type PersonalOrganizationMemorySource = {
  claimId: string;
  revision: number;
};

export type PersonalOrganizationMemorySourceResolver = (params: {
  agentId: string;
  lookup: string;
}) => Promise<PersonalOrganizationMemorySource | null>;

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
  parentScopeId?: string;
  status: ManagedScopeStatus;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type EffectiveManagedScopeAccess = {
  scope: ManagedScope;
  source: "administrator" | "direct" | "ancestor";
  directRole?: ManagedScopeRole;
};

export type OrganizationAuthorization = {
  canRead: boolean;
  canManageMembers: boolean;
  canManageStructure: boolean;
  canManageLeaders: boolean;
  facts: {
    source: "none" | "administrator" | "membership" | "leadership";
    scopeIds: string[];
  };
};

export type ManagedScopeMembership = {
  scopeId: string;
  userId: string;
  role: ManagedScopeRole;
  createdAt: number;
  updatedAt: number;
};

export type OrganizationUserSummary = {
  id: string;
  accountId: string;
  status: PlatformUserStatus;
  displayName?: string;
};

export type ManagedScopeMember = {
  membership: ManagedScopeMembership;
  user: OrganizationUserSummary;
};

export type OrganizationAuditRecord = {
  id: string;
  eventType: string;
  targetType: string;
  targetId: string;
  createdAt: number;
  outcome?: "succeeded" | "denied";
  reason?: string;
  actor?: { id: string; displayName?: string };
};

export type OrganizationJoinRequestStatus = "pending" | "approved" | "rejected" | "cancelled";
export type OrganizationJoinRequest = {
  id: string;
  userId: string;
  scopeId: string;
  reason: string;
  status: OrganizationJoinRequestStatus;
  createdAt: number;
  decidedAt?: number;
  decisionReason?: string;
};

export type ReviewableOrganizationJoinRequest = {
  request: OrganizationJoinRequest;
  applicant: OrganizationUserSummary;
  scope: ManagedScope;
  /** Active scope lineage ordered from Team root to the request target. */
  lineage: ManagedScope[];
};

export type OwnOrganizationJoinRequest = {
  request: OrganizationJoinRequest;
  scope: ManagedScope;
  /** Active or historical lineage ordered from Team root to the request target. */
  lineage: ManagedScope[];
};

export type OrganizationContextSnapshot = {
  effectiveAccess: EffectiveManagedScopeAccess[];
  effectiveAccessHasMore: boolean;
  directMemberships: ManagedScopeMembership[];
  directMembershipsHasMore: boolean;
  directScopeLineages: Array<{ scopeId: string; lineage: ManagedScope[] }>;
  primaryScope: ManagedScope | null;
  primaryScopeLineage: ManagedScope[];
  joinRequestDetails: OwnOrganizationJoinRequest[];
  isUnaffiliated: boolean;
  hasPendingJoinRequest: boolean;
  canReviewJoinRequests: boolean;
};

export type OrganizationScopeSearchResult = {
  scope: ManagedScope;
  /** Active scope lineage ordered from Team root to the returned scope. */
  lineage: ManagedScope[];
  capabilities: Pick<
    OrganizationAuthorization,
    "canManageMembers" | "canManageStructure" | "canManageLeaders"
  >;
  /** Current actor's exact direct join state for this scope. */
  requestState: "eligible" | "member" | "pending";
  requestEligible: boolean;
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

export type PersonalExecutionProfile = {
  agentBindingId: string;
  activeTarget: "platform_server" | "assigned_vm";
  activeAllocationId?: string;
  targetRevision: number;
  updatedAt: number;
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
      executionTarget: "platform_server" | "assigned_vm";
    }
  | { status: "user-not-found" }
  | { status: "agent-unavailable" };

export type ControlPlaneIdFactory = {
  nextUserId(): string;
  nextBindingId(): string;
  nextSessionId(): string;
  nextManagedScopeId(): string;
  nextAuditEventId(): string;
  nextExecutionResourceId?(kind: import("./execution-contracts.js").ExecutionResourceKind): string;
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
  getUserByAccountId(accountId: string): Promise<PlatformUser | null>;
  getUserByEmployeeId(employeeId: string): Promise<PlatformUser | null>;
  getPersonalAgentBinding(userId: string): Promise<PersonalAgentBinding | null>;
  getPersonalExecutionProfile(agentId: string): Promise<PersonalExecutionProfile | null>;
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
  resolveAuthenticatedKnoxDmRoute(params: { accountId: string }): Promise<KnoxDmRouteResolution>;
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

export interface ControlPlaneAuditReader {
  listAuditEvents(limit?: number): Promise<ControlAuditEvent[]>;
}

/** Read-only shared-memory boundary. PR4 is the sole owner of approved writes. */
export interface OrganizationMemoryReader {
  searchOrganizationMemory(params: {
    agentId: string;
    query: string;
    maxResults?: number;
  }): Promise<OrganizationMemorySearchHit[]>;
  getOrganizationMemory(params: {
    agentId: string;
    path: string;
    fromLine?: number;
    lineCount?: number;
  }): Promise<OrganizationMemoryDocument | null>;
}

/** Authenticated claim-level promotion owner. Browser callers are always Agent-pinned. */
export interface OrganizationMemoryLifecycle {
  getOrganizationMemoryLifecycle(
    agentId: string,
    page?: { claims?: number; submitted?: number; reviewable?: number },
  ): Promise<OrganizationMemoryLifecycleSnapshot>;
  submitOrganizationMemoryPromotion(params: {
    agentId: string;
    sourceKind: OrganizationMemoryPromotionSourceKind;
    sourceClaimId: string;
    expectedSourceRevision?: number;
    targetKind: OrganizationMemoryScopeKind;
    targetScopeId?: string;
    proposedText: string;
    evidence: string[];
    reason: string;
    submittedAt: number;
  }): Promise<OrganizationMemoryPromotionRequest>;
  publishOrganizationMemoryDirect(params: {
    agentId: string;
    sourceKind: OrganizationMemoryPromotionSourceKind;
    sourceClaimId: string;
    expectedSourceRevision?: number;
    targetKind: OrganizationMemoryScopeKind;
    targetScopeId?: string;
    proposedText: string;
    evidence: string[];
    reason: string;
    publishedAt: number;
  }): Promise<OrganizationMemoryPromotionRequest>;
  decideOrganizationMemoryPromotion(params: {
    agentId: string;
    requestId: string;
    decision: "approve" | "reject";
    reason: string;
    decidedAt: number;
  }): Promise<OrganizationMemoryPromotionRequest>;
  retireOrganizationMemoryClaim(params: {
    agentId: string;
    claimId: string;
    reason: string;
    retiredAt: number;
  }): Promise<OrganizationMemoryClaim>;
  purgeOrganizationMemoryClaim(params: {
    agentId: string;
    claimId: string;
    reason: string;
    purgedAt: number;
  }): Promise<OrganizationMemoryClaim>;
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
    parentScopeId?: string;
    createdAt: number;
  }): Promise<ManagedScope>;
  renameManagedScope(params: {
    actorUserId: string;
    scopeId: string;
    expectedRevision?: number;
    name: string;
    reason: string;
    changedAt: number;
  }): Promise<ManagedScope>;
  archiveManagedScope(params: {
    actorUserId: string;
    scopeId: string;
    expectedRevision?: number;
    reason: string;
    archivedAt: number;
  }): Promise<ManagedScope>;
  setManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    role: ManagedScopeRole;
    expectedRole?: ManagedScopeRole | null;
    reason: string;
    changedAt: number;
  }): Promise<ManagedScopeMembership>;
  removeManagedScopeMembership(params: {
    actorUserId: string;
    scopeId: string;
    userId: string;
    expectedRole?: ManagedScopeRole | null;
    reason: string;
    changedAt: number;
  }): Promise<boolean>;
  listManagedScopes(): Promise<ManagedScope[]>;
  searchOrganizationScopesForUser(params: {
    userId: string;
    query: string;
    limit: number;
  }): Promise<OrganizationScopeSearchResult[]>;
  listManagedScopeMemberships(scopeId: string): Promise<ManagedScopeMembership[]>;
  listAuthorizedManagedScopeMembers(params: {
    actorUserId: string;
    scopeId: string;
    limit?: number;
    offset?: number;
  }): Promise<ManagedScopeMember[]>;
  searchAuthorizedOrganizationUsers(params: {
    actorUserId: string;
    scopeId: string;
    query: string;
    limit: number;
  }): Promise<OrganizationUserSummary[]>;
  getManagedScope(scopeId: string): Promise<ManagedScope | null>;
  getManagedScopeLineage(scopeId: string): Promise<ManagedScope[]>;
  resolveManagedScopeAuthorization(
    actorUserId: string,
    scopeId: string,
  ): Promise<OrganizationAuthorization>;
  listEffectiveManagedScopeAccess(userId: string): Promise<EffectiveManagedScopeAccess[]>;
  listUserManagedScopeMemberships(userId: string): Promise<ManagedScopeMembership[]>;
  getUserPrimaryScope(userId: string): Promise<ManagedScope | null>;
  setUserPrimaryScope(params: {
    actorUserId: string;
    userId: string;
    scopeId?: string;
    changedAt: number;
  }): Promise<ManagedScope | null>;
  submitOrganizationJoinRequest(params: {
    requestId: string;
    userId: string;
    scopeId: string;
    reason: string;
    submittedAt: number;
  }): Promise<OrganizationJoinRequest>;
  decideOrganizationJoinRequest(params: {
    actorUserId: string;
    requestId: string;
    decision: "approved" | "rejected";
    reason: string;
    decidedAt: number;
  }): Promise<OrganizationJoinRequest>;
  cancelOrganizationJoinRequest(params: {
    actorUserId: string;
    requestId: string;
    reason: string;
    cancelledAt: number;
  }): Promise<OrganizationJoinRequest>;
  listOwnOrganizationJoinRequests(params: {
    userId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationJoinRequest[]>;
  listOwnOrganizationJoinRequestDetails(params: {
    userId: string;
    limit?: number;
    offset?: number;
  }): Promise<OwnOrganizationJoinRequest[]>;
  getOrganizationContextSnapshot(params: {
    userId: string;
    requestLimit?: number;
  }): Promise<OrganizationContextSnapshot>;
  listReviewableOrganizationJoinRequests(params: {
    actorUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationJoinRequest[]>;
  listReviewableOrganizationJoinRequestDetails(params: {
    actorUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<ReviewableOrganizationJoinRequest[]>;
  listAuditEvents(limit?: number): Promise<ControlAuditEvent[]>;
  listAuthorizedOrganizationAuditEvents(params: {
    actorUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<OrganizationAuditRecord[]>;
}

export type ControlPlaneConflictCode =
  | "account_id_conflict"
  | "account_id_mismatch"
  | "employee_id_conflict"
  | "employee_id_mismatch"
  | "stale_authentication"
  | "agent_id_conflict"
  | "safeconnect_endpoint_conflict"
  | "vm_host_conflict"
  | "vm_allocation_conflict"
  | "execution_target_conflict"
  | "managed_scope_name_conflict"
  | "organization_scope_changed"
  | "organization_membership_changed"
  | "organization_join_request_conflict"
  | "skill_hub_owner_changed"
  | "skill_hub_namespace_binding_changed"
  | "skill_hub_namespace_populated"
  | "organization_join_request_terminal_conflict"
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
    readonly resource:
      | "user"
      | "agent-binding"
      | "managed-scope"
      | "organization-join-request"
      | "memory-promotion"
      | "organization-memory-claim",
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
