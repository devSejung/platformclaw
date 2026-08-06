import { randomBytes, randomUUID } from "node:crypto";
import type {
  BoardFarmAdapter,
  BoardFarmAdapterOperation,
  BoardFarmAdapterResult,
  BoardFarmAuditEvent,
  BoardFarmCleanupOperation,
  BoardFarmEvidencePhase,
  BoardFarmIdFactory,
  BoardFarmLease,
  BoardFarmLeaseAccess,
  BoardFarmLeaseView,
  BoardFarmPolicy,
  BoardFarmRun,
  BoardFarmStateStore,
  BoardFarmSubmission,
  BoardFarmSubmitRequest,
} from "./contracts.js";
import { BoardFarmError } from "./contracts.js";
import { requireBoardFarmId, requireBoardFarmTimestamp } from "./schema.js";
import {
  appendBoardFarmAudit as appendAudit,
  appendBoardFarmEvidence as appendEvidence,
  authorizeBoardFarmLeaseAccess as authorizeLeaseAccess,
  beginBoardFarmCleanup as beginCleanup,
  boardFarmAdapterFailure as adapterFailure,
  boardFarmCleanupPendingState as cleanupPendingState,
  boardFarmLeaseView as leaseView,
  isStaleBoardFarmLease as isStaleLease,
  normalizeBoardFarmAdapterResult as normalizeAdapterResult,
  promoteQueuedBoardFarmLeases as promoteQueuedLeases,
  requiredBoardFarmLease as requiredLease,
  requiredBoardFarmResource as requiredResource,
  requiredBoardFarmRun as requiredRun,
  requireOwnedBoardFarmLease as requireOwnedLease,
} from "./state-machine.js";
import { issueBoardFarmLeaseAccess, submitBoardFarmRequest } from "./submission.js";

export const DEFAULT_BOARD_FARM_POLICY: BoardFarmPolicy = {
  leaseDurationMs: 10 * 60_000,
  heartbeatTimeoutMs: 2 * 60_000,
  maximumLeaseLifetimeMs: 60 * 60_000,
  maximumLeasesPerUser: 1,
};

const CLEANUP_PENDING_STATES = new Set(["releasing", "cancelling", "expiring"]);
const TERMINAL_LEASE_STATES = new Set(["released", "cancelled", "expired"]);
const RESUMABLE_RUN_STATES = new Set(["deploying", "booting", "validating"]);

type RecoveryResult = {
  expiredLeaseIds: string[];
  cleanupLeaseIds: string[];
  resumedRunIds: string[];
};

function defaultIdFactory(): BoardFarmIdFactory {
  return {
    nextRunId: () => `board-run-${randomUUID()}`,
    nextLeaseId: () => `board-lease-${randomUUID()}`,
    nextEvidenceId: () => `board-evidence-${randomUUID()}`,
    nextAuditEventId: () => `board-audit-${randomUUID()}`,
    nextAccessToken: () => randomBytes(32).toString("base64url"),
  };
}

function assertPolicy(policy: BoardFarmPolicy): BoardFarmPolicy {
  for (const field of [
    "leaseDurationMs",
    "heartbeatTimeoutMs",
    "maximumLeaseLifetimeMs",
    "maximumLeasesPerUser",
  ] as const) {
    const value = policy[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BoardFarmError("invalid_request", `${field} must be a positive integer`);
    }
  }
  if (policy.maximumLeaseLifetimeMs < policy.leaseDurationMs) {
    throw new BoardFarmError(
      "invalid_request",
      "maximumLeaseLifetimeMs must not be shorter than leaseDurationMs",
    );
  }
  return { ...policy };
}

/** Owns board allocation, user authorization, lease lifecycle, and durable workflow facts. */
export class BoardFarmService {
  private readonly policy: BoardFarmPolicy;
  private readonly ids: BoardFarmIdFactory;
  private readonly executionByRunId = new Map<string, Promise<BoardFarmRun>>();
  private readonly cleanupByLeaseId = new Map<string, Promise<BoardFarmLeaseView>>();

  constructor(
    private readonly options: {
      store: BoardFarmStateStore;
      adapter: BoardFarmAdapter;
      policy?: BoardFarmPolicy;
      idFactory?: BoardFarmIdFactory;
      now?: () => number;
    },
  ) {
    this.policy = assertPolicy(options.policy ?? DEFAULT_BOARD_FARM_POLICY);
    this.ids = options.idFactory ?? defaultIdFactory();
  }

  submit(request: BoardFarmSubmitRequest): BoardFarmSubmission {
    return submitBoardFarmRequest(
      { store: this.options.store, ids: this.ids, policy: this.policy },
      request,
      this.currentTime(),
    );
  }

  claimLeaseAccess(actorUserId: string, leaseId: string): string {
    return issueBoardFarmLeaseAccess(
      { store: this.options.store, ids: this.ids },
      actorUserId,
      leaseId,
      this.currentTime(),
      false,
    );
  }

  rotateLeaseAccess(actorUserId: string, leaseId: string): string {
    return issueBoardFarmLeaseAccess(
      { store: this.options.store, ids: this.ids },
      actorUserId,
      leaseId,
      this.currentTime(),
      true,
    );
  }

  getRun(actorUserId: string, runId: string): BoardFarmRun {
    const state = this.options.store.snapshot();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run || run.userId !== actorUserId) {
      throw new BoardFarmError("not_authorized", "run is not available to this user");
    }
    return structuredClone(run);
  }

  getLease(actorUserId: string, leaseId: string): BoardFarmLeaseView {
    const state = this.options.store.snapshot();
    return leaseView(requireOwnedLease(state, actorUserId, leaseId));
  }

  listEvidence(actorUserId: string, runId: string) {
    const state = this.options.store.snapshot();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run || run.userId !== actorUserId) {
      throw new BoardFarmError("not_authorized", "run is not available to this user");
    }
    return structuredClone(state.evidence.filter((artifact) => artifact.runId === runId));
  }

  listAuditEvents(actorUserId: string, runId: string): BoardFarmAuditEvent[] {
    this.getRun(actorUserId, runId);
    return structuredClone(
      this.options.store.snapshot().auditEvents.filter((event) => event.runId === runId),
    );
  }

  async heartbeat(access: BoardFarmLeaseAccess): Promise<BoardFarmLeaseView> {
    return await this.updateLiveLease(access, "heartbeat");
  }

  async renew(access: BoardFarmLeaseAccess): Promise<BoardFarmLeaseView> {
    return await this.updateLiveLease(access, "renew");
  }

  async execute(access: BoardFarmLeaseAccess): Promise<BoardFarmRun> {
    this.assertLeaseAccess(access, true);
    const existing = this.executionByRunId.get(
      requiredLease(this.options.store.snapshot(), access.leaseId).runId,
    );
    if (existing) {
      return await existing;
    }
    const runId = requiredLease(this.options.store.snapshot(), access.leaseId).runId;
    const task = this.runWorkflow(runId);
    this.executionByRunId.set(runId, task);
    try {
      return await task;
    } finally {
      if (this.executionByRunId.get(runId) === task) {
        this.executionByRunId.delete(runId);
      }
      const lease = requiredLease(this.options.store.snapshot(), access.leaseId);
      if (CLEANUP_PENDING_STATES.has(lease.state)) {
        await this.ensureCleanup(lease.id);
      }
    }
  }

  async release(access: BoardFarmLeaseAccess): Promise<BoardFarmLeaseView> {
    const now = this.currentTime();
    const result = this.options.store.transaction((state) => {
      const lease = authorizeLeaseAccess(state, access, false);
      if (TERMINAL_LEASE_STATES.has(lease.state) || lease.state === "cleanup_failed") {
        return { lease: leaseView(lease), cleanup: lease.state === "cleanup_failed" };
      }
      if (lease.state === "queued") {
        lease.state = "cancelled";
        lease.terminalAt = now;
        lease.updatedAt = now;
        const run = requiredRun(state, lease.runId);
        run.status = "cancelled";
        run.completedAt = now;
        run.updatedAt = now;
        appendAudit(state, this.ids, {
          eventType: "board_farm.lease.cancelled",
          actorUserId: lease.userId,
          runId: run.id,
          leaseId: lease.id,
          createdAt: now,
        });
        return { lease: leaseView(lease), cleanup: false };
      }
      if (lease.state === "active") {
        beginCleanup(state, lease, "released", now, this.ids, lease.userId);
      }
      return { lease: leaseView(lease), cleanup: CLEANUP_PENDING_STATES.has(lease.state) };
    });
    return result.cleanup ? await this.ensureCleanup(access.leaseId) : result.lease;
  }

  async cancel(params: {
    actorUserId: string;
    leaseId: string;
    accessToken?: string;
  }): Promise<BoardFarmLeaseView> {
    const now = this.currentTime();
    const result = this.options.store.transaction((state) => {
      const lease = requireOwnedLease(state, params.actorUserId, params.leaseId);
      if (lease.state !== "queued") {
        authorizeLeaseAccess(state, { ...params, accessToken: params.accessToken ?? "" }, false);
      }
      if (TERMINAL_LEASE_STATES.has(lease.state) || lease.state === "cleanup_failed") {
        return { lease: leaseView(lease), cleanup: lease.state === "cleanup_failed" };
      }
      if (lease.state === "queued") {
        lease.state = "cancelled";
        lease.terminalAt = now;
        lease.updatedAt = now;
        const run = requiredRun(state, lease.runId);
        run.status = "cancelled";
        run.completedAt = now;
        run.updatedAt = now;
        appendAudit(state, this.ids, {
          eventType: "board_farm.lease.cancelled",
          actorUserId: lease.userId,
          runId: run.id,
          leaseId: lease.id,
          createdAt: now,
        });
        return { lease: leaseView(lease), cleanup: false };
      }
      if (lease.state === "active") {
        beginCleanup(state, lease, "cancelled", now, this.ids, lease.userId);
      }
      return { lease: leaseView(lease), cleanup: CLEANUP_PENDING_STATES.has(lease.state) };
    });
    if (!result.cleanup) {
      return result.lease;
    }
    const runId = requiredLease(this.options.store.snapshot(), params.leaseId).runId;
    await this.executionByRunId.get(runId)?.catch(() => undefined);
    return await this.ensureCleanup(params.leaseId);
  }

  async expireStale(): Promise<BoardFarmLeaseView[]> {
    const now = this.currentTime();
    const leaseIds = this.options.store.transaction((state) => {
      const expired: string[] = [];
      for (const lease of state.leases) {
        if (lease.state === "active" && isStaleLease(lease, now, this.policy)) {
          beginCleanup(state, lease, "expired", now, this.ids);
          expired.push(lease.id);
        }
      }
      return expired;
    });
    return await Promise.all(
      leaseIds.map(async (leaseId) => {
        const runId = requiredLease(this.options.store.snapshot(), leaseId).runId;
        await this.executionByRunId.get(runId)?.catch(() => undefined);
        return await this.ensureCleanup(leaseId);
      }),
    );
  }

  async retryCleanup(access: BoardFarmLeaseAccess): Promise<BoardFarmLeaseView> {
    const lease = this.assertLeaseAccess(access, false);
    if (lease.state !== "cleanup_failed") {
      return leaseView(lease);
    }
    return await this.ensureCleanup(lease.id);
  }

  async recover(): Promise<RecoveryResult> {
    const now = this.currentTime();
    const prepared = this.options.store.transaction((state) => {
      const expiredLeaseIds: string[] = [];
      const cleanupLeaseIds: string[] = [];
      for (const lease of state.leases) {
        if (lease.state === "active" && isStaleLease(lease, now, this.policy)) {
          beginCleanup(state, lease, "expired", now, this.ids);
          expiredLeaseIds.push(lease.id);
        }
        if (CLEANUP_PENDING_STATES.has(lease.state) || lease.state === "cleanup_failed") {
          cleanupLeaseIds.push(lease.id);
        }
      }
      promoteQueuedLeases(state, now, this.policy, this.ids);
      return { expiredLeaseIds, cleanupLeaseIds };
    });

    await Promise.all(
      prepared.cleanupLeaseIds.map(async (leaseId) => await this.ensureCleanup(leaseId)),
    );
    const resumable = this.options.store
      .snapshot()
      .runs.filter((run) => RESUMABLE_RUN_STATES.has(run.status))
      .filter((run) => {
        const lease = run.leaseId
          ? this.options.store.snapshot().leases.find((candidate) => candidate.id === run.leaseId)
          : undefined;
        return lease?.state === "active";
      });
    await Promise.all(resumable.map(async (run) => await this.executeRecoveredRun(run.id)));
    return {
      ...prepared,
      resumedRunIds: resumable.map((run) => run.id),
    };
  }

  private currentTime(): number {
    return requireBoardFarmTimestamp((this.options.now ?? Date.now)(), "now");
  }

  private assertLeaseAccess(access: BoardFarmLeaseAccess, requireActive: boolean): BoardFarmLease {
    const state = this.options.store.snapshot();
    const lease = authorizeLeaseAccess(state, access, requireActive);
    return structuredClone(lease);
  }

  private async updateLiveLease(
    access: BoardFarmLeaseAccess,
    action: "heartbeat" | "renew",
  ): Promise<BoardFarmLeaseView> {
    const now = this.currentTime();
    const result = this.options.store.transaction((state) => {
      const lease = authorizeLeaseAccess(state, access, true);
      if (isStaleLease(lease, now, this.policy)) {
        beginCleanup(state, lease, "expired", now, this.ids);
        return { expired: true, lease: leaseView(lease) };
      }
      if (action === "heartbeat") {
        lease.lastHeartbeatAt = now;
      } else {
        const maximum = (lease.acquiredAt ?? now) + this.policy.maximumLeaseLifetimeMs;
        lease.expiresAt = Math.min(now + this.policy.leaseDurationMs, maximum);
      }
      lease.updatedAt = now;
      appendAudit(state, this.ids, {
        eventType: `board_farm.lease.${action}`,
        actorUserId: lease.userId,
        runId: lease.runId,
        leaseId: lease.id,
        boardId: lease.boardId,
        createdAt: now,
        ...(action === "renew" ? { details: { expiresAt: lease.expiresAt } } : {}),
      });
      return { expired: false, lease: leaseView(lease) };
    });
    if (!result.expired) {
      return result.lease;
    }
    await this.ensureCleanup(access.leaseId);
    throw new BoardFarmError("lease_expired", "lease expired before it could be updated");
  }

  private async runWorkflow(runId: string): Promise<BoardFarmRun> {
    while (true) {
      const state = this.options.store.snapshot();
      const run = requiredRun(state, runId);
      const lease = run.leaseId ? requiredLease(state, run.leaseId) : undefined;
      if (!lease || lease.state !== "active" || !lease.boardId) {
        return structuredClone(run);
      }
      if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") {
        return structuredClone(run);
      }
      if (run.build.status !== "succeeded") {
        throw new BoardFarmError("invalid_state", "run has no successful build artifact");
      }

      let phase: Exclude<BoardFarmEvidencePhase, "cleanup">;
      if (run.status === "leased" || run.status === "deploying") {
        phase = "deploy";
      } else if (run.status === "booting") {
        phase = "boot";
      } else if (run.status === "validating") {
        phase = "validate";
      } else {
        throw new BoardFarmError("invalid_state", `run cannot execute from state ${run.status}`);
      }

      const now = this.currentTime();
      this.options.store.transaction((draft) => {
        const current = requiredRun(draft, runId);
        const currentLease = requiredLease(draft, lease.id);
        if (currentLease.state !== "active") {
          return;
        }
        if (phase === "deploy" && current.status === "leased") {
          current.status = "deploying";
          current.updatedAt = now;
          appendAudit(draft, this.ids, {
            eventType: "board_farm.workflow.deploying",
            actorUserId: current.userId,
            runId: current.id,
            leaseId: currentLease.id,
            boardId: currentLease.boardId,
            createdAt: now,
          });
        }
      });

      const operation: BoardFarmAdapterOperation = {
        operationId: `${run.id}:${phase}:v1`,
        runId: run.id,
        jobId: run.jobId,
        correlationId: run.correlationId,
        leaseId: lease.id,
        boardId: lease.boardId,
      };
      const result = await this.invokeAdapter(
        phase,
        operation,
        run.build.status === "succeeded" ? run.build.artifact : undefined,
      );
      const updated = this.recordPhaseResult(run.id, lease.id, phase, operation, result);
      if (updated.status === "failed" || updated.status === "cancelled") {
        return updated;
      }
    }
  }

  private async invokeAdapter(
    phase: Exclude<BoardFarmEvidencePhase, "cleanup">,
    operation: BoardFarmAdapterOperation,
    artifact?: { id: string; digest: string; locator: string },
  ): Promise<BoardFarmAdapterResult> {
    try {
      let result: BoardFarmAdapterResult;
      if (phase === "deploy") {
        if (!artifact) {
          throw new Error("build artifact is unavailable");
        }
        result = await this.options.adapter.deploy({ ...operation, artifact });
      } else {
        result =
          phase === "boot"
            ? await this.options.adapter.boot(operation)
            : await this.options.adapter.validate(operation);
      }
      return normalizeAdapterResult(operation, result);
    } catch {
      return adapterFailure(operation, "adapter_operation_failed");
    }
  }

  private recordPhaseResult(
    runId: string,
    leaseId: string,
    phase: Exclude<BoardFarmEvidencePhase, "cleanup">,
    operation: BoardFarmAdapterOperation,
    result: BoardFarmAdapterResult,
  ): BoardFarmRun {
    const now = this.currentTime();
    return this.options.store.transaction((state) => {
      const run = requiredRun(state, runId);
      const lease = requiredLease(state, leaseId);
      appendEvidence(state, this.ids, run, lease, phase, operation.operationId, result, now);
      appendAudit(state, this.ids, {
        eventType: `board_farm.workflow.${phase}.${result.status}`,
        actorUserId: run.userId,
        runId,
        leaseId,
        boardId: lease.boardId,
        createdAt: now,
        ...(result.status === "failed" ? { details: { failureCode: result.failureCode } } : {}),
      });
      if (lease.state !== "active") {
        appendAudit(state, this.ids, {
          eventType: "board_farm.workflow.late_result_preserved",
          runId,
          leaseId,
          boardId: lease.boardId,
          createdAt: now,
          details: { phase, status: result.status },
        });
        return structuredClone(run);
      }
      if (result.status === "failed") {
        run.status = "failed";
        run.failureCode = requireBoardFarmId(result.failureCode, "adapter.failureCode");
        run.failureCategory = result.failureCode.startsWith("adapter_")
          ? "adapter"
          : phase === "deploy"
            ? "deployment"
            : phase === "boot"
              ? "boot"
              : "validation";
        run.completedAt = now;
        run.updatedAt = now;
        beginCleanup(state, lease, "released", now, this.ids);
        return structuredClone(run);
      }
      run.status = phase === "deploy" ? "booting" : phase === "boot" ? "validating" : "succeeded";
      run.updatedAt = now;
      if (run.status === "succeeded") {
        run.completedAt = now;
      }
      return structuredClone(run);
    });
  }

  private async ensureCleanup(leaseId: string): Promise<BoardFarmLeaseView> {
    const existing = this.cleanupByLeaseId.get(leaseId);
    if (existing) {
      return await existing;
    }
    const task = this.runCleanup(leaseId);
    this.cleanupByLeaseId.set(leaseId, task);
    try {
      return await task;
    } finally {
      if (this.cleanupByLeaseId.get(leaseId) === task) {
        this.cleanupByLeaseId.delete(leaseId);
      }
    }
  }

  private async runCleanup(leaseId: string): Promise<BoardFarmLeaseView> {
    const now = this.currentTime();
    const prepared = this.options.store.transaction((state) => {
      const lease = requiredLease(state, leaseId);
      if (TERMINAL_LEASE_STATES.has(lease.state)) {
        return { lease: leaseView(lease) };
      }
      if (lease.state === "cleanup_failed") {
        const target = lease.cleanupTarget;
        if (!target || !lease.boardId) {
          throw new BoardFarmError("invalid_state", "failed cleanup has no recovery target");
        }
        lease.state = cleanupPendingState(target);
        lease.failureCode = undefined;
        lease.updatedAt = now;
        const resource = requiredResource(state, lease.boardId);
        resource.state = "cleanup_pending";
        resource.failureCode = undefined;
        resource.updatedAt = now;
        appendAudit(state, this.ids, {
          eventType: "board_farm.cleanup.retried",
          runId: lease.runId,
          leaseId: lease.id,
          boardId: lease.boardId,
          createdAt: now,
        });
      }
      if (!CLEANUP_PENDING_STATES.has(lease.state) || !lease.boardId || !lease.cleanupTarget) {
        return { lease: leaseView(lease) };
      }
      const operation: BoardFarmCleanupOperation = {
        operationId: `${lease.runId}:cleanup:v1`,
        runId: lease.runId,
        jobId: lease.jobId,
        correlationId: lease.correlationId,
        leaseId: lease.id,
        boardId: lease.boardId,
        reason: lease.cleanupTarget,
      };
      return { lease: leaseView(lease), operation };
    });
    if (!prepared.operation) {
      return prepared.lease;
    }

    let result: BoardFarmAdapterResult;
    try {
      result = normalizeAdapterResult(
        prepared.operation,
        await this.options.adapter.cleanup(prepared.operation),
      );
    } catch {
      result = adapterFailure(prepared.operation, "adapter_cleanup_failed");
    }
    const completedAt = this.currentTime();
    return this.options.store.transaction((state) => {
      const lease = requiredLease(state, leaseId);
      const run = requiredRun(state, lease.runId);
      if (!lease.boardId || !lease.cleanupTarget) {
        throw new BoardFarmError("invalid_state", "cleanup state lost its board or target");
      }
      appendEvidence(
        state,
        this.ids,
        run,
        lease,
        "cleanup",
        prepared.operation.operationId,
        result,
        completedAt,
      );
      const resource = requiredResource(state, lease.boardId);
      if (result.status === "failed") {
        lease.state = "cleanup_failed";
        lease.failureCode = requireBoardFarmId(result.failureCode, "adapter.failureCode");
        lease.cleanupResult = {
          status: "failed",
          failureCode: lease.failureCode,
          completedAt,
        };
        lease.updatedAt = completedAt;
        resource.state = "quarantined";
        resource.failureCode = lease.failureCode;
        resource.updatedAt = completedAt;
        run.status = "failed";
        run.failureCode = lease.failureCode;
        run.failureCategory = "cleanup";
        run.completedAt = completedAt;
        run.updatedAt = completedAt;
        appendAudit(state, this.ids, {
          eventType: "board_farm.cleanup.failed",
          runId: run.id,
          leaseId: lease.id,
          boardId: lease.boardId,
          details: { failureCode: lease.failureCode },
          createdAt: completedAt,
        });
        return leaseView(lease);
      }

      const target = lease.cleanupTarget;
      lease.state = target;
      lease.terminalAt = completedAt;
      lease.updatedAt = completedAt;
      lease.failureCode = undefined;
      lease.cleanupResult = { status: "passed", completedAt };
      resource.state = "available";
      resource.currentLeaseId = undefined;
      resource.failureCode = undefined;
      resource.updatedAt = completedAt;
      if (target === "cancelled") {
        run.status = "cancelled";
        run.completedAt = completedAt;
        run.updatedAt = completedAt;
      } else if (target === "expired") {
        run.status = "failed";
        run.failureCode = "lease_expired";
        run.failureCategory = "lease";
        run.completedAt = completedAt;
        run.updatedAt = completedAt;
      } else if (!new Set(["succeeded", "failed", "cancelled"]).has(run.status)) {
        run.status = "cancelled";
        run.completedAt = completedAt;
        run.updatedAt = completedAt;
      }
      appendAudit(state, this.ids, {
        eventType: `board_farm.lease.${target}`,
        runId: run.id,
        leaseId: lease.id,
        boardId: lease.boardId,
        createdAt: completedAt,
      });
      promoteQueuedLeases(state, completedAt, this.policy, this.ids);
      return leaseView(lease);
    });
  }

  private async executeRecoveredRun(runId: string): Promise<void> {
    const existing = this.executionByRunId.get(runId);
    if (existing) {
      await existing;
      return;
    }
    const task = this.runWorkflow(runId);
    this.executionByRunId.set(runId, task);
    try {
      await task;
    } finally {
      if (this.executionByRunId.get(runId) === task) {
        this.executionByRunId.delete(runId);
      }
      const run = requiredRun(this.options.store.snapshot(), runId);
      const lease = run.leaseId
        ? requiredLease(this.options.store.snapshot(), run.leaseId)
        : undefined;
      if (lease && CLEANUP_PENDING_STATES.has(lease.state)) {
        await this.ensureCleanup(lease.id);
      }
    }
  }
}
