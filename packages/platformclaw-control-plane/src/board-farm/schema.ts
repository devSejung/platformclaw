import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  BOARD_FARM_EVIDENCE_PHASES,
  BOARD_FARM_LEASE_STATES,
  BOARD_FARM_RESOURCE_STATES,
  BOARD_FARM_RUN_STATES,
  BoardFarmError,
  type BoardFarmBuildResult,
  type BoardFarmCleanupTarget,
  type BoardFarmResourceRequirement,
  type BoardFarmStateSnapshot,
} from "./contracts.js";

export const BOARD_FARM_STATE_SCHEMA_VERSION = 1 as const;
export const BOARD_FARM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const BOARD_FARM_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const LEASE_STATES = new Set<string>(BOARD_FARM_LEASE_STATES);
const RUN_STATES = new Set<string>(BOARD_FARM_RUN_STATES);
const RESOURCE_STATES = new Set<string>(BOARD_FARM_RESOURCE_STATES);
const EVIDENCE_PHASES = new Set<string>(BOARD_FARM_EVIDENCE_PHASES);
const CLEANUP_TARGETS = new Set<string>(["released", "cancelled", "expired"]);
const TERMINAL_LEASE_STATES = new Set<string>(["released", "cancelled", "expired"]);
const TERMINAL_RUN_STATES = new Set<string>(["build_failed", "succeeded", "failed", "cancelled"]);
const FAILURE_CATEGORIES = new Set<string>([
  "build",
  "deployment",
  "boot",
  "validation",
  "lease",
  "cleanup",
  "adapter",
]);

export function requireBoardFarmId(value: string, field: string): string {
  const normalized = value.trim();
  if (!BOARD_FARM_ID_PATTERN.test(normalized)) {
    throw new BoardFarmError("invalid_request", `${field} is invalid`);
  }
  return normalized;
}

export function requireBoardFarmText(value: string, field: string, maximumLength = 2048): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new BoardFarmError("invalid_request", `${field} is invalid`);
  }
  return normalized;
}

export function requireBoardFarmTimestamp(value: number, field: string): number {
  if (!isCanonicalTimestamp(value)) {
    throw new BoardFarmError("invalid_request", `${field} is invalid`);
  }
  return value;
}

function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new BoardFarmError("invalid_state", message);
  }
}

function isCanonicalTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCanonicalSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && BOARD_FARM_ID_PATTERN.test(value);
}

function isCanonicalText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  const record = asNullableRecord(value);
  if (!record) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? record : null;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (depth >= 8) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isJsonValue(entry, depth + 1));
  }
  const record = asPlainRecord(value);
  return record !== null && Object.values(record).every((entry) => isJsonValue(entry, depth + 1));
}

function assertUniqueIds(records: unknown[], name: string): void {
  const ids = new Set<string>();
  for (const value of records) {
    const record = asPlainRecord(value);
    requireState(record !== null && isCanonicalId(record.id), `${name} contains an invalid id`);
    requireState(!ids.has(record.id), `${name} contains a duplicate id`);
    ids.add(record.id);
  }
}

function assertSortedUniqueIds(values: unknown, name: string): asserts values is string[] {
  requireState(
    Array.isArray(values) && values.every((value) => isCanonicalId(value)),
    `${name} is invalid`,
  );
  requireState(new Set(values).size === values.length, `${name} is duplicated`);
  requireState(
    values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0),
    `${name} is not sorted`,
  );
}

function assertResourceRequirement(
  value: unknown,
  name: string,
): asserts value is BoardFarmResourceRequirement {
  const requirement = asPlainRecord(value);
  requireState(
    requirement !== null && isCanonicalId(requirement.profile),
    `${name} profile is invalid`,
  );
  assertSortedUniqueIds(requirement.capabilities, `${name} capabilities`);
}

function assertBuildResult(
  value: unknown,
  runCreatedAt: number,
): asserts value is BoardFarmBuildResult {
  const build = asPlainRecord(value);
  requireState(
    build !== null && isCanonicalTimestamp(build.completedAt),
    "build timestamp is invalid",
  );
  requireState(build.completedAt <= runCreatedAt, "build timestamp follows run creation");
  if (build.status === "failed") {
    requireState(isCanonicalId(build.failureCode), "build failure code is invalid");
    requireState(build.artifact === undefined, "failed build contains an artifact");
    return;
  }
  requireState(build.status === "succeeded", "build status is invalid");
  requireState(build.failureCode === undefined, "successful build contains a failure code");
  const artifact = asPlainRecord(build.artifact);
  requireState(artifact !== null && isCanonicalId(artifact.id), "build artifact id is invalid");
  requireState(
    typeof artifact.digest === "string" && BOARD_FARM_SHA256_PATTERN.test(artifact.digest),
    "build artifact digest is invalid",
  );
  requireState(isCanonicalText(artifact.locator, 2048), "build artifact locator is invalid");
}

function expectedCleanupTarget(state: string): BoardFarmCleanupTarget | undefined {
  if (state === "releasing" || state === "released") {
    return "released";
  }
  if (state === "cancelling" || state === "cancelled") {
    return "cancelled";
  }
  if (state === "expiring" || state === "expired") {
    return "expired";
  }
  return undefined;
}

/** Validate every durable fact before a snapshot becomes canonical process state. */
export function assertBoardFarmStateSnapshot(
  value: unknown,
): asserts value is BoardFarmStateSnapshot {
  const state = asPlainRecord(value);
  requireState(
    state?.schemaVersion === BOARD_FARM_STATE_SCHEMA_VERSION,
    "schemaVersion is invalid",
  );
  requireState(isCanonicalSequence(state.nextSequence), "nextSequence is invalid");
  for (const field of [
    "resources",
    "runs",
    "leases",
    "evidence",
    "auditEvents",
    "idempotencyRecords",
  ] as const) {
    requireState(Array.isArray(state[field]), `${field} must be an array`);
  }

  const snapshot = state as unknown as BoardFarmStateSnapshot;
  assertUniqueIds(snapshot.resources, "resources");
  assertUniqueIds(snapshot.runs, "runs");
  assertUniqueIds(snapshot.leases, "leases");
  assertUniqueIds(snapshot.evidence, "evidence");
  assertUniqueIds(snapshot.auditEvents, "auditEvents");

  const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
  const leases = new Map(snapshot.leases.map((lease) => [lease.id, lease]));
  const resources = new Map(snapshot.resources.map((resource) => [resource.id, resource]));
  const liveBoards = new Set<string>();
  const queueSequences = new Set<number>();
  let maximumSequence = 0;

  for (const resource of snapshot.resources) {
    requireState(isCanonicalId(resource.profile), "resource profile is invalid");
    assertSortedUniqueIds(resource.capabilities, "resource capabilities");
    const metadata = asPlainRecord(resource.metadata);
    requireState(
      metadata !== null &&
        Object.entries(metadata).every(
          ([key, metadataValue]) => isCanonicalId(key) && isCanonicalText(metadataValue, 1024),
        ),
      "resource metadata is invalid",
    );
    requireState(RESOURCE_STATES.has(resource.state), "resource state is invalid");
    requireState(isCanonicalTimestamp(resource.updatedAt), "resource timestamp is invalid");
    if (resource.state === "available") {
      requireState(resource.currentLeaseId === undefined, "available resource has a lease");
      requireState(resource.failureCode === undefined, "available resource has a failure code");
    } else {
      requireState(isCanonicalId(resource.currentLeaseId), "unavailable resource has no lease");
      requireState(leases.has(resource.currentLeaseId), "resource lease reference is invalid");
      if (resource.state === "quarantined") {
        requireState(
          isCanonicalId(resource.failureCode),
          "quarantined resource has no failure code",
        );
      } else {
        requireState(resource.failureCode === undefined, "resource has an unexpected failure code");
      }
    }
  }

  for (const run of snapshot.runs) {
    requireState(RUN_STATES.has(run.status), "run state is invalid");
    requireState(isCanonicalId(run.userId), "run user id is invalid");
    requireState(isCanonicalId(run.userAlias), "run user alias is invalid");
    requireState(isCanonicalId(run.jobId), "run job id is invalid");
    requireState(isCanonicalId(run.correlationId), "run correlation id is invalid");
    requireState(isCanonicalText(run.idempotencyKey, 256), "run idempotency key is invalid");
    requireState(
      BOARD_FARM_SHA256_PATTERN.test(run.requestFingerprint),
      "run request fingerprint is invalid",
    );
    assertResourceRequirement(run.resourceRequirement, "run resource requirement");
    requireState(isCanonicalTimestamp(run.createdAt), "run creation timestamp is invalid");
    requireState(isCanonicalTimestamp(run.updatedAt), "run update timestamp is invalid");
    requireState(run.updatedAt >= run.createdAt, "run update precedes creation");
    assertBuildResult(run.build, run.createdAt);
    const terminal = TERMINAL_RUN_STATES.has(run.status);
    requireState(
      terminal === isCanonicalTimestamp(run.completedAt),
      "run completion timestamp is inconsistent",
    );
    if (terminal) {
      requireState(run.completedAt! >= run.createdAt, "run completion precedes creation");
      requireState(run.updatedAt >= run.completedAt!, "run update precedes completion");
    }
    if (run.failureCategory !== undefined) {
      requireState(FAILURE_CATEGORIES.has(run.failureCategory), "run failure category is invalid");
    }
    if (run.status === "build_failed") {
      requireState(run.build.status === "failed", "build-failed run has a successful build");
      requireState(run.failureCode === run.build.failureCode, "build failure code is inconsistent");
      requireState(run.failureCategory === "build", "build failure category is inconsistent");
      requireState(run.leaseId === undefined, "mock build-failed run has a lease");
    } else {
      requireState(run.build.status === "succeeded", "mock leased run has no build artifact");
      requireState(isCanonicalId(run.leaseId), "mock runnable workflow has no lease");
      requireState(leases.get(run.leaseId)?.runId === run.id, "run lease reference is invalid");
    }
    if (run.status === "failed") {
      requireState(
        isCanonicalId(run.failureCode) && run.failureCategory !== undefined,
        "failed run has no failure fact",
      );
    } else if (run.status !== "build_failed") {
      requireState(
        run.failureCode === undefined && run.failureCategory === undefined,
        "non-failed run has a failure fact",
      );
    }
  }

  for (const lease of snapshot.leases) {
    requireState(LEASE_STATES.has(lease.state), "lease state is invalid");
    const run = runs.get(lease.runId);
    requireState(run?.userId === lease.userId, "lease run owner is invalid");
    requireState(run?.jobId === lease.jobId, "lease job owner is invalid");
    requireState(run?.correlationId === lease.correlationId, "lease correlation is invalid");
    assertResourceRequirement(lease.resourceRequirement, "lease resource requirement");
    requireState(
      JSON.stringify(run?.resourceRequirement) === JSON.stringify(lease.resourceRequirement),
      "lease resource requirement is inconsistent",
    );
    requireState(isCanonicalSequence(lease.queueSequence), "lease queue sequence is invalid");
    requireState(!queueSequences.has(lease.queueSequence), "lease queue sequence is duplicated");
    queueSequences.add(lease.queueSequence);
    maximumSequence = Math.max(maximumSequence, lease.queueSequence);
    requireState(isCanonicalTimestamp(lease.requestedAt), "lease request timestamp is invalid");
    requireState(isCanonicalTimestamp(lease.updatedAt), "lease update timestamp is invalid");
    requireState(lease.requestedAt >= run.createdAt, "lease request precedes run creation");
    requireState(lease.updatedAt >= lease.requestedAt, "lease update precedes request");
    if (lease.accessTokenHash !== undefined) {
      requireState(
        BOARD_FARM_SHA256_PATTERN.test(lease.accessTokenHash),
        "lease access token hash is invalid",
      );
    }

    const queuedCancellation = lease.state === "cancelled" && lease.boardId === undefined;
    if (lease.state === "queued" || queuedCancellation) {
      requireState(lease.boardId === undefined, "unassigned lease has a board");
      requireState(lease.accessTokenHash === undefined, "unassigned lease has an access token");
      requireState(
        lease.acquiredAt === undefined &&
          lease.lastHeartbeatAt === undefined &&
          lease.expiresAt === undefined,
        "unassigned lease has active timestamps",
      );
      requireState(
        lease.cleanupTarget === undefined && lease.cleanupResult === undefined,
        "unassigned lease has cleanup facts",
      );
      requireState(lease.failureCode === undefined, "unassigned lease has a failure code");
      if (lease.state === "queued") {
        requireState(lease.terminalAt === undefined, "queued lease has a terminal timestamp");
        requireState(run.status === "queued", "queued lease run is not queued");
      } else {
        requireState(
          isCanonicalTimestamp(lease.terminalAt) && lease.terminalAt >= lease.requestedAt,
          "cancelled queue lease terminal timestamp is invalid",
        );
        requireState(lease.updatedAt >= lease.terminalAt, "lease update precedes termination");
        requireState(run.status === "cancelled", "cancelled queue lease run is not cancelled");
      }
      continue;
    }

    requireState(isCanonicalId(lease.boardId), "assigned lease has no board");
    const resource = resources.get(lease.boardId);
    requireState(resource !== undefined, "lease board reference is invalid");
    requireState(
      resource.profile === lease.resourceRequirement.profile &&
        lease.resourceRequirement.capabilities.every((capability) =>
          resource.capabilities.includes(capability),
        ),
      "lease board does not satisfy its requirement",
    );
    requireState(isCanonicalTimestamp(lease.acquiredAt), "lease acquisition timestamp is invalid");
    requireState(lease.acquiredAt >= lease.requestedAt, "lease acquisition precedes request");
    requireState(
      isCanonicalTimestamp(lease.lastHeartbeatAt) && lease.lastHeartbeatAt >= lease.acquiredAt,
      "lease heartbeat timestamp is invalid",
    );
    requireState(lease.updatedAt >= lease.lastHeartbeatAt, "lease update precedes heartbeat");
    requireState(
      isCanonicalTimestamp(lease.expiresAt) && lease.expiresAt > lease.acquiredAt,
      "lease expiration timestamp is invalid",
    );
    const expectedTarget = expectedCleanupTarget(lease.state);
    if (lease.state === "active") {
      requireState(lease.cleanupTarget === undefined, "active lease has a cleanup target");
      requireState(lease.cleanupResult === undefined, "active lease has a cleanup result");
      requireState(lease.failureCode === undefined, "active lease has a failure code");
      requireState(lease.terminalAt === undefined, "active lease has a terminal timestamp");
    } else if (lease.state === "cleanup_failed") {
      requireState(
        typeof lease.cleanupTarget === "string" && CLEANUP_TARGETS.has(lease.cleanupTarget),
        "failed cleanup has no target",
      );
      const cleanup = asPlainRecord(lease.cleanupResult);
      requireState(
        cleanup?.status === "failed" &&
          isCanonicalId(cleanup.failureCode) &&
          cleanup.failureCode === lease.failureCode &&
          isCanonicalTimestamp(cleanup.completedAt) &&
          cleanup.completedAt === lease.updatedAt,
        "failed cleanup result is inconsistent",
      );
      requireState(lease.terminalAt === undefined, "failed cleanup has a terminal timestamp");
    } else if (TERMINAL_LEASE_STATES.has(lease.state)) {
      requireState(
        lease.cleanupTarget === expectedTarget,
        "terminal cleanup target is inconsistent",
      );
      const cleanup = asPlainRecord(lease.cleanupResult);
      requireState(
        cleanup?.status === "passed" &&
          cleanup.failureCode === undefined &&
          isCanonicalTimestamp(cleanup.completedAt) &&
          cleanup.completedAt === lease.terminalAt,
        "terminal cleanup result is inconsistent",
      );
      requireState(lease.failureCode === undefined, "terminal lease has a failure code");
      requireState(
        isCanonicalTimestamp(lease.terminalAt) && lease.terminalAt >= lease.acquiredAt,
        "terminal lease timestamp is invalid",
      );
    } else {
      requireState(lease.cleanupTarget === expectedTarget, "cleanup target is inconsistent");
      requireState(lease.terminalAt === undefined, "pending cleanup has a terminal timestamp");
      requireState(lease.failureCode === undefined, "pending cleanup has a failure code");
      if (lease.cleanupResult !== undefined) {
        const cleanup = asPlainRecord(lease.cleanupResult);
        requireState(
          cleanup?.status === "failed" &&
            isCanonicalId(cleanup.failureCode) &&
            isCanonicalTimestamp(cleanup.completedAt) &&
            cleanup.completedAt <= lease.updatedAt,
          "pending cleanup result is inconsistent",
        );
      }
    }
    if (!TERMINAL_LEASE_STATES.has(lease.state)) {
      requireState(!liveBoards.has(lease.boardId), "board has multiple live leases");
      liveBoards.add(lease.boardId);
      requireState(resource.currentLeaseId === lease.id, "lease resource reference is invalid");
      const expectedResourceState =
        lease.state === "active"
          ? "leased"
          : lease.state === "cleanup_failed"
            ? "quarantined"
            : "cleanup_pending";
      requireState(
        resource.state === expectedResourceState,
        "lease resource state is inconsistent",
      );
      if (lease.state === "cleanup_failed") {
        requireState(
          resource.failureCode === lease.failureCode,
          "cleanup failure code is inconsistent",
        );
      }
    }
  }

  for (const artifact of snapshot.evidence) {
    const run = runs.get(artifact.runId);
    const lease = leases.get(artifact.leaseId);
    requireState(run !== undefined, "evidence run reference is invalid");
    requireState(lease?.runId === run.id, "evidence lease reference is invalid");
    requireState(artifact.jobId === run.jobId, "evidence job is invalid");
    requireState(artifact.correlationId === run.correlationId, "evidence correlation is invalid");
    requireState(artifact.boardId === lease.boardId, "evidence board is invalid");
    requireState(EVIDENCE_PHASES.has(artifact.phase), "evidence phase is invalid");
    requireState(
      artifact.status === "passed" || artifact.status === "failed",
      "evidence status is invalid",
    );
    requireState(isCanonicalId(artifact.kind), "evidence kind is invalid");
    requireState(isCanonicalText(artifact.locator, 2048), "evidence locator is invalid");
    requireState(BOARD_FARM_SHA256_PATTERN.test(artifact.sha256), "evidence digest is invalid");
    requireState(
      artifact.operationId === `${run.id}:${artifact.phase}:v1`,
      "evidence operation id is invalid",
    );
    requireState(isCanonicalTimestamp(artifact.recordedAt), "evidence timestamp is invalid");
    requireState(artifact.recordedAt >= run.createdAt, "evidence precedes run creation");
    requireState(
      lease.acquiredAt !== undefined && artifact.recordedAt >= lease.acquiredAt,
      "evidence precedes lease acquisition",
    );
    if (artifact.mediaType !== undefined) {
      requireState(isCanonicalText(artifact.mediaType, 256), "evidence media type is invalid");
    }
    if (artifact.summary !== undefined) {
      requireState(isCanonicalText(artifact.summary, 1024), "evidence summary is invalid");
    }
  }

  const auditSequences = new Set<number>();
  let previousAuditSequence = 0;
  for (const event of snapshot.auditEvents) {
    requireState(isCanonicalSequence(event.sequence), "audit sequence is invalid");
    requireState(!auditSequences.has(event.sequence), "audit sequence is duplicated");
    requireState(event.sequence > previousAuditSequence, "audit events are not ordered");
    auditSequences.add(event.sequence);
    previousAuditSequence = event.sequence;
    maximumSequence = Math.max(maximumSequence, event.sequence);
    requireState(isCanonicalId(event.eventType), "audit event type is invalid");
    requireState(isCanonicalTimestamp(event.createdAt), "audit timestamp is invalid");
    if (event.actorUserId !== undefined) {
      requireState(isCanonicalId(event.actorUserId), "audit actor is invalid");
    }
    if (event.runId !== undefined) {
      const run = runs.get(event.runId);
      requireState(run !== undefined, "audit run reference is invalid");
      requireState(event.jobId === run.jobId, "audit job is invalid");
      requireState(event.correlationId === run.correlationId, "audit correlation is invalid");
    } else {
      requireState(
        event.jobId === undefined && event.correlationId === undefined,
        "audit trace has no run",
      );
    }
    if (event.leaseId !== undefined) {
      const lease = leases.get(event.leaseId);
      requireState(lease !== undefined, "audit lease reference is invalid");
      if (event.runId !== undefined) {
        requireState(lease.runId === event.runId, "audit lease run is inconsistent");
      }
    }
    if (event.boardId !== undefined) {
      requireState(resources.has(event.boardId), "audit board reference is invalid");
    }
    if (event.details !== undefined) {
      requireState(
        asPlainRecord(event.details) !== null && isJsonValue(event.details),
        "audit details are invalid",
      );
    }
  }

  const idempotencyKeys = new Set<string>();
  const idempotencyRuns = new Set<string>();
  for (const record of snapshot.idempotencyRecords) {
    const raw = asPlainRecord(record);
    requireState(raw !== null && isCanonicalId(record.userId), "idempotency user is invalid");
    requireState(isCanonicalText(record.key, 256), "idempotency key is invalid");
    requireState(
      BOARD_FARM_SHA256_PATTERN.test(record.requestFingerprint),
      "idempotency fingerprint is invalid",
    );
    requireState(isCanonicalId(record.runId), "idempotency run id is invalid");
    const composite = `${record.userId}\0${record.key}`;
    requireState(!idempotencyKeys.has(composite), "idempotency record is duplicated");
    requireState(!idempotencyRuns.has(record.runId), "run has multiple idempotency records");
    idempotencyKeys.add(composite);
    idempotencyRuns.add(record.runId);
    const run = runs.get(record.runId);
    requireState(run !== undefined, "idempotency run reference is invalid");
    requireState(
      run.userId === record.userId &&
        run.idempotencyKey === record.key &&
        run.requestFingerprint === record.requestFingerprint,
      "idempotency record is inconsistent",
    );
  }
  requireState(idempotencyRuns.size === runs.size, "run has no idempotency record");
  requireState(
    snapshot.nextSequence > maximumSequence,
    "nextSequence does not follow stored facts",
  );
}

export function parseBoardFarmStateSnapshot(value: unknown): BoardFarmStateSnapshot {
  assertBoardFarmStateSnapshot(value);
  return structuredClone(value);
}
