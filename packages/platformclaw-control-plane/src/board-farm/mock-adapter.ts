import { createHash } from "node:crypto";
import type {
  BoardFarmAdapter,
  BoardFarmAdapterOperation,
  BoardFarmAdapterResult,
  BoardFarmCleanupOperation,
  BoardFarmDeployOperation,
  BoardFarmEvidencePhase,
  BoardFarmIdFactory,
} from "./contracts.js";

export type DeterministicMockBoardFarmCall = {
  phase: BoardFarmEvidencePhase;
  operationId: string;
  runId: string;
  jobId: string;
  correlationId: string;
  leaseId: string;
  boardId: string;
};

export type DeterministicMockBoardFarmOptions = {
  failures?: Partial<Record<BoardFarmEvidencePhase, number | "always">>;
  beforeOperation?: (call: DeterministicMockBoardFarmCall) => Promise<void>;
};

/** Stable ids make mock golden-run JSON reproducible without weakening production ids. */
export function createDeterministicBoardFarmIdFactory(
  namespace = "mock",
  initialSequence = 0,
): BoardFarmIdFactory {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(namespace)) {
    throw new Error("deterministic Board Farm namespace is invalid");
  }
  if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
    throw new Error("deterministic Board Farm initial sequence is invalid");
  }
  let sequence = initialSequence;
  const next = (kind: string) => `${namespace}-${kind}-${String(++sequence).padStart(6, "0")}`;
  return {
    nextRunId: () => next("run"),
    nextLeaseId: () => next("lease"),
    nextEvidenceId: () => next("evidence"),
    nextAuditEventId: () => next("audit"),
    nextAccessToken: () => next("access-token"),
  };
}

/** Credential-free adapter that emits reproducible MOCK evidence and idempotent effects. */
export class DeterministicMockBoardFarmAdapter implements BoardFarmAdapter {
  readonly calls: DeterministicMockBoardFarmCall[] = [];
  readonly completedEffects: DeterministicMockBoardFarmCall[] = [];
  private readonly successfulResults = new Map<string, BoardFarmAdapterResult>();
  private readonly failures: Partial<Record<BoardFarmEvidencePhase, number | "always">>;

  constructor(private readonly options: DeterministicMockBoardFarmOptions = {}) {
    this.failures = { ...options.failures };
  }

  deploy(operation: BoardFarmDeployOperation): Promise<BoardFarmAdapterResult> {
    return this.run("deploy", operation);
  }

  boot(operation: BoardFarmAdapterOperation): Promise<BoardFarmAdapterResult> {
    return this.run("boot", operation);
  }

  validate(operation: BoardFarmAdapterOperation): Promise<BoardFarmAdapterResult> {
    return this.run("validate", operation);
  }

  cleanup(operation: BoardFarmCleanupOperation): Promise<BoardFarmAdapterResult> {
    return this.run("cleanup", operation);
  }

  private async run(
    phase: BoardFarmEvidencePhase,
    operation: BoardFarmAdapterOperation,
  ): Promise<BoardFarmAdapterResult> {
    const call = { phase, ...operation };
    this.calls.push(call);
    await this.options.beforeOperation?.(call);
    const cached = this.successfulResults.get(operation.operationId);
    if (cached) {
      return structuredClone(cached);
    }

    const remainingFailures = this.failures[phase];
    const fails =
      remainingFailures === "always" ||
      (typeof remainingFailures === "number" && remainingFailures > 0);
    if (typeof remainingFailures === "number" && remainingFailures > 0) {
      this.failures[phase] = remainingFailures - 1;
    }
    const marker = `${phase}:${operation.operationId}:${fails ? "failed" : "passed"}`;
    const evidence = [
      {
        kind: "mock-board-farm-operation",
        locator: `mock-evidence://${encodeURIComponent(operation.runId)}/${phase}`,
        sha256: createHash("sha256").update(marker, "utf8").digest("hex"),
        mediaType: "application/json",
        summary: `MOCK ${phase} ${fails ? "failed" : "passed"}`,
      },
    ];
    if (fails) {
      return { status: "failed", failureCode: `mock_${phase}_failed`, evidence };
    }
    const result: BoardFarmAdapterResult = { status: "passed", evidence };
    this.successfulResults.set(operation.operationId, result);
    this.completedEffects.push(call);
    return structuredClone(result);
  }
}
