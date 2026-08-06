import { createHash, timingSafeEqual } from "node:crypto";
import type {
  BoardFarmAdapterOperation,
  BoardFarmAdapterResult,
  BoardFarmAuditEvent,
  BoardFarmCleanupTarget,
  BoardFarmEvidenceInput,
  BoardFarmEvidencePhase,
  BoardFarmIdFactory,
  BoardFarmLease,
  BoardFarmLeaseAccess,
  BoardFarmLeaseView,
  BoardFarmPolicy,
  BoardFarmRun,
  BoardFarmStateSnapshot,
} from "./contracts.js";
import { BoardFarmError } from "./contracts.js";
import { BOARD_FARM_SHA256_PATTERN, requireBoardFarmId, requireBoardFarmText } from "./schema.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function boardFarmLeaseView(lease: BoardFarmLease): BoardFarmLeaseView {
  const { accessTokenHash: _accessTokenHash, ...view } = lease;
  return structuredClone(view);
}

export function hashBoardFarmAccessToken(token: string): string {
  return hashToken(token);
}

export function requiredBoardFarmRun(state: BoardFarmStateSnapshot, runId: string): BoardFarmRun {
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (!run) {
    throw new BoardFarmError("not_found", "board farm run was not found");
  }
  return run;
}

export function requiredBoardFarmLease(
  state: BoardFarmStateSnapshot,
  leaseId: string,
): BoardFarmLease {
  const lease = state.leases.find((candidate) => candidate.id === leaseId);
  if (!lease) {
    throw new BoardFarmError("not_found", "board farm lease was not found");
  }
  return lease;
}

export function requiredBoardFarmResource(state: BoardFarmStateSnapshot, boardId: string) {
  const resource = state.resources.find((candidate) => candidate.id === boardId);
  if (!resource) {
    throw new BoardFarmError("invalid_state", "board farm resource was not found");
  }
  return resource;
}

export function requireOwnedBoardFarmLease(
  state: BoardFarmStateSnapshot,
  actorUserId: string,
  leaseId: string,
): BoardFarmLease {
  const lease = state.leases.find((candidate) => candidate.id === leaseId);
  if (!lease || lease.userId !== actorUserId) {
    throw new BoardFarmError("not_authorized", "lease is not available to this user");
  }
  return lease;
}

export function authorizeBoardFarmLeaseAccess(
  state: BoardFarmStateSnapshot,
  access: BoardFarmLeaseAccess,
  requireActive: boolean,
): BoardFarmLease {
  const lease = requireOwnedBoardFarmLease(state, access.actorUserId, access.leaseId);
  if (!lease.accessTokenHash || !tokenMatches(access.accessToken, lease.accessTokenHash)) {
    throw new BoardFarmError("not_authorized", "lease access is not authorized");
  }
  if (requireActive && lease.state !== "active") {
    throw new BoardFarmError("lease_access_unavailable", "lease is not active");
  }
  return lease;
}

export function appendBoardFarmAudit(
  state: BoardFarmStateSnapshot,
  ids: BoardFarmIdFactory,
  event: Omit<BoardFarmAuditEvent, "id" | "sequence">,
): void {
  const run = event.runId
    ? state.runs.find((candidate) => candidate.id === event.runId)
    : undefined;
  state.auditEvents.push({
    id: requireBoardFarmId(ids.nextAuditEventId(), "audit.id"),
    sequence: state.nextSequence++,
    ...(run ? { jobId: run.jobId, correlationId: run.correlationId } : {}),
    ...event,
  });
}

export function appendBoardFarmEvidence(
  state: BoardFarmStateSnapshot,
  ids: BoardFarmIdFactory,
  run: BoardFarmRun,
  lease: BoardFarmLease,
  phase: BoardFarmEvidencePhase,
  operationId: string,
  result: BoardFarmAdapterResult,
  recordedAt: number,
): void {
  if (!lease.boardId) {
    throw new BoardFarmError("invalid_state", "evidence has no board context");
  }
  for (const input of normalizeEvidence(result.evidence)) {
    state.evidence.push({
      id: requireBoardFarmId(ids.nextEvidenceId(), "evidence.id"),
      runId: run.id,
      jobId: run.jobId,
      correlationId: run.correlationId,
      leaseId: lease.id,
      boardId: lease.boardId,
      phase,
      status: result.status,
      operationId,
      recordedAt,
      ...input,
    });
  }
}

function normalizeEvidence(evidence: BoardFarmEvidenceInput[]): BoardFarmEvidenceInput[] {
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 100) {
    throw new BoardFarmError("invalid_state", "adapter evidence is invalid");
  }
  return evidence.map((artifact) => {
    const sha256 = artifact.sha256.toLowerCase();
    if (!BOARD_FARM_SHA256_PATTERN.test(sha256)) {
      throw new BoardFarmError("invalid_state", "adapter evidence digest is invalid");
    }
    return {
      kind: requireBoardFarmId(artifact.kind, "evidence.kind"),
      locator: requireBoardFarmText(artifact.locator, "evidence.locator"),
      sha256,
      ...(artifact.mediaType
        ? { mediaType: requireBoardFarmText(artifact.mediaType, "evidence.mediaType", 256) }
        : {}),
      ...(artifact.summary
        ? { summary: requireBoardFarmText(artifact.summary, "evidence.summary", 1024) }
        : {}),
    };
  });
}

export function boardFarmAdapterFailure(
  operation: BoardFarmAdapterOperation,
  failureCode: string,
): BoardFarmAdapterResult {
  return {
    status: "failed",
    failureCode,
    evidence: [
      {
        kind: "adapter-error",
        locator: `board-farm-evidence://${encodeURIComponent(operation.runId)}/${encodeURIComponent(operation.operationId)}`,
        sha256: createHash("sha256")
          .update(`${operation.operationId}:${failureCode}`, "utf8")
          .digest("hex"),
        mediaType: "application/json",
        summary: "Board farm adapter operation failed",
      },
    ],
  };
}

/** Turn an untrusted adapter response into the canonical evidence-bearing result. */
export function normalizeBoardFarmAdapterResult(
  operation: BoardFarmAdapterOperation,
  result: BoardFarmAdapterResult,
): BoardFarmAdapterResult {
  try {
    const evidence = normalizeEvidence(result.evidence);
    if (result.status === "failed") {
      return {
        status: "failed",
        failureCode: requireBoardFarmId(result.failureCode, "adapter.failureCode"),
        evidence,
      };
    }
    if (result.status !== "passed") {
      throw new BoardFarmError("invalid_state", "adapter result status is invalid");
    }
    return { status: "passed", evidence };
  } catch {
    return boardFarmAdapterFailure(operation, "adapter_contract_invalid");
  }
}

export function boardFarmCleanupPendingState(
  target: BoardFarmCleanupTarget,
): BoardFarmLease["state"] {
  return target === "released" ? "releasing" : target === "cancelled" ? "cancelling" : "expiring";
}

export function beginBoardFarmCleanup(
  state: BoardFarmStateSnapshot,
  lease: BoardFarmLease,
  target: BoardFarmCleanupTarget,
  now: number,
  ids: BoardFarmIdFactory,
  actorUserId?: string,
): void {
  if (!lease.boardId) {
    throw new BoardFarmError("invalid_state", "active lease has no board");
  }
  lease.state = boardFarmCleanupPendingState(target);
  lease.cleanupTarget = target;
  lease.updatedAt = now;
  const resource = requiredBoardFarmResource(state, lease.boardId);
  resource.state = "cleanup_pending";
  resource.updatedAt = now;
  appendBoardFarmAudit(state, ids, {
    eventType: `board_farm.cleanup.${target}_requested`,
    ...(actorUserId ? { actorUserId } : {}),
    runId: lease.runId,
    leaseId: lease.id,
    boardId: lease.boardId,
    createdAt: now,
  });
}

export function isStaleBoardFarmLease(
  lease: BoardFarmLease,
  now: number,
  policy: BoardFarmPolicy,
): boolean {
  if (lease.state !== "active") {
    return false;
  }
  const expiresAt = lease.expiresAt ?? 0;
  const lastHeartbeatAt = lease.lastHeartbeatAt ?? lease.acquiredAt ?? lease.requestedAt;
  return now >= expiresAt || now - lastHeartbeatAt >= policy.heartbeatTimeoutMs;
}

export function promoteQueuedBoardFarmLeases(
  state: BoardFarmStateSnapshot,
  now: number,
  policy: BoardFarmPolicy,
  ids: BoardFarmIdFactory,
): void {
  const available = state.resources
    .filter((resource) => resource.state === "available")
    .toSorted((left, right) => left.id.localeCompare(right.id));
  for (const resource of available) {
    const lease = state.leases
      .filter((candidate) => {
        if (
          candidate.state !== "queued" ||
          candidate.resourceRequirement.profile !== resource.profile
        ) {
          return false;
        }
        const capabilities = new Set(resource.capabilities);
        return candidate.resourceRequirement.capabilities.every((capability) =>
          capabilities.has(capability),
        );
      })
      .toSorted((left, right) => left.queueSequence - right.queueSequence)[0];
    if (!lease) {
      continue;
    }
    lease.state = "active";
    lease.boardId = resource.id;
    lease.acquiredAt = now;
    lease.lastHeartbeatAt = now;
    lease.expiresAt = now + policy.leaseDurationMs;
    lease.updatedAt = now;
    resource.state = "leased";
    resource.currentLeaseId = lease.id;
    resource.updatedAt = now;
    const run = requiredBoardFarmRun(state, lease.runId);
    run.status = "leased";
    run.updatedAt = now;
    appendBoardFarmAudit(state, ids, {
      eventType: "board_farm.lease.acquired",
      actorUserId: lease.userId,
      runId: run.id,
      leaseId: lease.id,
      boardId: resource.id,
      details: { expiresAt: lease.expiresAt },
      createdAt: now,
    });
  }
}
