export const BOARD_FARM_LEASE_STATES = [
  "queued",
  "active",
  "releasing",
  "cancelling",
  "expiring",
  "released",
  "cancelled",
  "expired",
  "cleanup_failed",
] as const;

export const BOARD_FARM_RUN_STATES = [
  "build_failed",
  "queued",
  "leased",
  "deploying",
  "booting",
  "validating",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const BOARD_FARM_RESOURCE_STATES = [
  "available",
  "leased",
  "cleanup_pending",
  "quarantined",
] as const;

export const BOARD_FARM_EVIDENCE_PHASES = ["deploy", "boot", "validate", "cleanup"] as const;

export type BoardFarmLeaseState = (typeof BOARD_FARM_LEASE_STATES)[number];
export type BoardFarmRunState = (typeof BOARD_FARM_RUN_STATES)[number];
export type BoardFarmResourceState = (typeof BOARD_FARM_RESOURCE_STATES)[number];
export type BoardFarmEvidencePhase = (typeof BOARD_FARM_EVIDENCE_PHASES)[number];
export type BoardFarmCleanupTarget = "released" | "cancelled" | "expired";
export type BoardFarmCapability = string;
export type BoardFarmFailureCategory =
  | "build"
  | "deployment"
  | "boot"
  | "validation"
  | "lease"
  | "cleanup"
  | "adapter";

export type BoardFarmResourceRequirement = {
  profile: string;
  capabilities: BoardFarmCapability[];
};

export type BoardFarmBuildArtifact = {
  id: string;
  digest: string;
  locator: string;
};

export type BoardFarmBuildResult =
  | { status: "succeeded"; artifact: BoardFarmBuildArtifact; completedAt: number }
  | { status: "failed"; failureCode: string; completedAt: number };

export type BoardFarmSubmitRequest = {
  actorUserId: string;
  userAlias: string;
  jobId: string;
  correlationId: string;
  idempotencyKey: string;
  resourceRequirement: BoardFarmResourceRequirement;
  build: BoardFarmBuildResult;
};

export type BoardFarmResource = {
  id: string;
  profile: string;
  capabilities: BoardFarmCapability[];
  metadata: Record<string, string>;
  state: BoardFarmResourceState;
  currentLeaseId?: string;
  failureCode?: string;
  updatedAt: number;
};

export type BoardFarmRun = {
  id: string;
  userId: string;
  userAlias: string;
  jobId: string;
  correlationId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  resourceRequirement: BoardFarmResourceRequirement;
  build: BoardFarmBuildResult;
  status: BoardFarmRunState;
  leaseId?: string;
  failureCode?: string;
  failureCategory?: BoardFarmFailureCategory;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type BoardFarmLease = {
  id: string;
  runId: string;
  userId: string;
  jobId: string;
  correlationId: string;
  resourceRequirement: BoardFarmResourceRequirement;
  state: BoardFarmLeaseState;
  queueSequence: number;
  requestedAt: number;
  updatedAt: number;
  boardId?: string;
  accessTokenHash?: string;
  acquiredAt?: number;
  lastHeartbeatAt?: number;
  expiresAt?: number;
  cleanupTarget?: BoardFarmCleanupTarget;
  terminalAt?: number;
  failureCode?: string;
  cleanupResult?: {
    status: "passed" | "failed";
    failureCode?: string;
    completedAt: number;
  };
};

export type BoardFarmLeaseView = Omit<BoardFarmLease, "accessTokenHash">;

export type BoardFarmEvidenceInput = {
  kind: string;
  locator: string;
  sha256: string;
  mediaType?: string;
  summary?: string;
};

export type BoardFarmEvidence = BoardFarmEvidenceInput & {
  id: string;
  runId: string;
  jobId: string;
  correlationId: string;
  leaseId: string;
  boardId: string;
  phase: BoardFarmEvidencePhase;
  status: "passed" | "failed";
  operationId: string;
  recordedAt: number;
};

export type BoardFarmAuditEvent = {
  id: string;
  sequence: number;
  eventType: string;
  actorUserId?: string;
  runId?: string;
  jobId?: string;
  correlationId?: string;
  leaseId?: string;
  boardId?: string;
  details?: Record<string, unknown>;
  createdAt: number;
};

export type BoardFarmIdempotencyRecord = {
  userId: string;
  key: string;
  requestFingerprint: string;
  runId: string;
};

export type BoardFarmStateSnapshot = {
  schemaVersion: 1;
  nextSequence: number;
  resources: BoardFarmResource[];
  runs: BoardFarmRun[];
  leases: BoardFarmLease[];
  evidence: BoardFarmEvidence[];
  auditEvents: BoardFarmAuditEvent[];
  idempotencyRecords: BoardFarmIdempotencyRecord[];
};

export interface BoardFarmStateStore {
  snapshot(): BoardFarmStateSnapshot;
  transaction<Result>(operation: (state: BoardFarmStateSnapshot) => Result): Result;
}

export type BoardFarmPolicy = {
  leaseDurationMs: number;
  heartbeatTimeoutMs: number;
  maximumLeaseLifetimeMs: number;
  maximumLeasesPerUser: number;
};

export type BoardFarmIdFactory = {
  nextRunId(): string;
  nextLeaseId(): string;
  nextEvidenceId(): string;
  nextAuditEventId(): string;
  nextAccessToken(): string;
};

export type BoardFarmAdapterOperation = {
  operationId: string;
  runId: string;
  jobId: string;
  correlationId: string;
  leaseId: string;
  boardId: string;
};

export type BoardFarmDeployOperation = BoardFarmAdapterOperation & {
  artifact: BoardFarmBuildArtifact;
};

export type BoardFarmCleanupOperation = BoardFarmAdapterOperation & {
  reason: BoardFarmCleanupTarget;
};

export type BoardFarmAdapterResult =
  | { status: "passed"; evidence: BoardFarmEvidenceInput[] }
  | { status: "failed"; failureCode: string; evidence: BoardFarmEvidenceInput[] };

/** Hardware-specific commands stay behind this adapter; lease policy remains in Control Plane. */
export interface BoardFarmAdapter {
  deploy(operation: BoardFarmDeployOperation): Promise<BoardFarmAdapterResult>;
  boot(operation: BoardFarmAdapterOperation): Promise<BoardFarmAdapterResult>;
  validate(operation: BoardFarmAdapterOperation): Promise<BoardFarmAdapterResult>;
  cleanup(operation: BoardFarmCleanupOperation): Promise<BoardFarmAdapterResult>;
}

export type BoardFarmSubmission = {
  created: boolean;
  run: BoardFarmRun;
  lease?: BoardFarmLeaseView;
  accessToken?: string;
};

export type BoardFarmLeaseAccess = {
  actorUserId: string;
  leaseId: string;
  accessToken: string;
};

export type BoardFarmErrorCode =
  | "invalid_request"
  | "invalid_state"
  | "not_found"
  | "not_authorized"
  | "idempotency_conflict"
  | "lease_access_unavailable"
  | "user_lease_quota_exceeded"
  | "lease_expired";

export class BoardFarmError extends Error {
  constructor(
    readonly code: BoardFarmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BoardFarmError";
  }
}
