import { createHash } from "node:crypto";
import type {
  BoardFarmIdFactory,
  BoardFarmLease,
  BoardFarmPolicy,
  BoardFarmRun,
  BoardFarmStateStore,
  BoardFarmSubmission,
  BoardFarmSubmitRequest,
} from "./contracts.js";
import { BoardFarmError } from "./contracts.js";
import {
  BOARD_FARM_SHA256_PATTERN,
  requireBoardFarmId,
  requireBoardFarmText,
  requireBoardFarmTimestamp,
} from "./schema.js";
import {
  appendBoardFarmAudit,
  boardFarmLeaseView,
  hashBoardFarmAccessToken,
  promoteQueuedBoardFarmLeases,
  requiredBoardFarmLease,
  requiredBoardFarmRun,
  requireOwnedBoardFarmLease,
} from "./state-machine.js";

type SubmissionContext = {
  store: BoardFarmStateStore;
  ids: BoardFarmIdFactory;
  policy: BoardFarmPolicy;
};

function fingerprintRequest(
  request: Omit<BoardFarmSubmitRequest, "actorUserId" | "idempotencyKey">,
): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function normalizeBuild(build: BoardFarmSubmitRequest["build"]): BoardFarmSubmitRequest["build"] {
  requireBoardFarmTimestamp(build.completedAt, "build.completedAt");
  if (build.status === "failed") {
    return {
      status: "failed",
      failureCode: requireBoardFarmId(build.failureCode, "build.failureCode"),
      completedAt: build.completedAt,
    };
  }
  const digest = build.artifact.digest.toLowerCase();
  if (!BOARD_FARM_SHA256_PATTERN.test(digest)) {
    throw new BoardFarmError("invalid_request", "build artifact digest is invalid");
  }
  return {
    status: "succeeded",
    artifact: {
      id: requireBoardFarmId(build.artifact.id, "build.artifact.id"),
      digest,
      locator: requireBoardFarmText(build.artifact.locator, "build.artifact.locator"),
    },
    completedAt: build.completedAt,
  };
}

export function submitBoardFarmRequest(
  context: SubmissionContext,
  request: BoardFarmSubmitRequest,
  now: number,
): BoardFarmSubmission {
  // This mock workflow begins with a completed VM build result. Short-circuiting
  // a failed result here must not be treated as the actual MCP lease policy.
  const actorUserId = requireBoardFarmId(request.actorUserId, "actorUserId");
  const userAlias = requireBoardFarmId(request.userAlias, "userAlias");
  const jobId = requireBoardFarmId(request.jobId, "jobId");
  const correlationId = requireBoardFarmId(request.correlationId, "correlationId");
  const idempotencyKey = requireBoardFarmText(request.idempotencyKey, "idempotencyKey", 256);
  if (!request.resourceRequirement || !Array.isArray(request.resourceRequirement.capabilities)) {
    throw new BoardFarmError("invalid_request", "resourceRequirement is invalid");
  }
  const resourceRequirement = {
    profile: requireBoardFarmId(request.resourceRequirement.profile, "resourceRequirement.profile"),
    capabilities: [...new Set(request.resourceRequirement.capabilities)]
      .map((capability) => requireBoardFarmId(capability, "resourceRequirement.capability"))
      .toSorted(),
  };
  const build = normalizeBuild(request.build);
  const requestFingerprint = fingerprintRequest({
    userAlias,
    jobId,
    correlationId,
    resourceRequirement,
    build,
  });
  const submission = context.store.transaction((state) => {
    const previous = state.idempotencyRecords.find(
      (record) => record.userId === actorUserId && record.key === idempotencyKey,
    );
    if (previous) {
      if (previous.requestFingerprint !== requestFingerprint) {
        throw new BoardFarmError(
          "idempotency_conflict",
          "idempotency key was already used for a different request",
        );
      }
      const run = requiredBoardFarmRun(state, previous.runId);
      const lease = run.leaseId ? requiredBoardFarmLease(state, run.leaseId) : undefined;
      return {
        created: false,
        run: structuredClone(run),
        lease: lease && boardFarmLeaseView(lease),
      };
    }

    const liveLeaseCount = state.leases.filter(
      (lease) =>
        lease.userId === actorUserId &&
        !new Set(["released", "cancelled", "expired"]).has(lease.state),
    ).length;
    if (build.status === "succeeded" && liveLeaseCount >= context.policy.maximumLeasesPerUser) {
      throw new BoardFarmError(
        "user_lease_quota_exceeded",
        "user has reached the Board Farm lease quota",
      );
    }

    const runId = requireBoardFarmId(context.ids.nextRunId(), "run.id");
    const run: BoardFarmRun = {
      id: runId,
      userId: actorUserId,
      userAlias,
      jobId,
      correlationId,
      idempotencyKey,
      requestFingerprint,
      resourceRequirement,
      build,
      status: build.status === "failed" ? ("build_failed" as const) : ("queued" as const),
      ...(build.status === "failed"
        ? { failureCode: build.failureCode, failureCategory: "build" as const, completedAt: now }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    state.runs.push(run);
    state.idempotencyRecords.push({
      userId: actorUserId,
      key: idempotencyKey,
      requestFingerprint,
      runId,
    });
    appendBoardFarmAudit(state, context.ids, {
      eventType: build.status === "failed" ? "board_farm.build.rejected" : "board_farm.run.created",
      actorUserId,
      runId,
      jobId,
      correlationId,
      createdAt: now,
      ...(build.status === "failed" ? { details: { failureCode: build.failureCode } } : {}),
    });
    if (build.status === "failed") {
      return { created: true, run: structuredClone(run) };
    }

    const lease: BoardFarmLease = {
      id: requireBoardFarmId(context.ids.nextLeaseId(), "lease.id"),
      runId,
      userId: actorUserId,
      jobId,
      correlationId,
      resourceRequirement,
      state: "queued",
      queueSequence: state.nextSequence++,
      requestedAt: now,
      updatedAt: now,
    };
    run.leaseId = lease.id;
    state.leases.push(lease);
    appendBoardFarmAudit(state, context.ids, {
      eventType: "board_farm.lease.queued",
      actorUserId,
      runId,
      jobId,
      correlationId,
      leaseId: lease.id,
      createdAt: now,
    });
    promoteQueuedBoardFarmLeases(state, now, context.policy, context.ids);
    return { created: true, run: structuredClone(run), lease: boardFarmLeaseView(lease) };
  });

  if (submission.created && submission.lease?.state === "active") {
    const accessToken = issueBoardFarmLeaseAccess(
      context,
      actorUserId,
      submission.lease.id,
      now,
      false,
    );
    const lease = context.store.transaction((state) =>
      boardFarmLeaseView(requireOwnedBoardFarmLease(state, actorUserId, submission.lease!.id)),
    );
    return { ...submission, lease, accessToken };
  }
  return submission;
}

export function issueBoardFarmLeaseAccess(
  context: Pick<SubmissionContext, "store" | "ids">,
  actorUserId: string,
  leaseId: string,
  now: number,
  rotate: boolean,
): string {
  const token = requireBoardFarmText(context.ids.nextAccessToken(), "accessToken", 512);
  context.store.transaction((state) => {
    const lease = requireOwnedBoardFarmLease(state, actorUserId, leaseId);
    if (lease.state !== "active") {
      throw new BoardFarmError("lease_access_unavailable", "lease is not active");
    }
    if (lease.accessTokenHash && !rotate) {
      throw new BoardFarmError("lease_access_unavailable", "lease access was already claimed");
    }
    lease.accessTokenHash = hashBoardFarmAccessToken(token);
    lease.updatedAt = now;
    appendBoardFarmAudit(state, context.ids, {
      eventType: rotate ? "board_farm.lease.access_rotated" : "board_farm.lease.access_claimed",
      actorUserId,
      runId: lease.runId,
      jobId: lease.jobId,
      correlationId: lease.correlationId,
      leaseId: lease.id,
      boardId: lease.boardId,
      createdAt: now,
    });
  });
  return token;
}
