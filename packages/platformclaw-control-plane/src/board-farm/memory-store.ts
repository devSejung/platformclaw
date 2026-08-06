import type {
  BoardFarmResource,
  BoardFarmStateSnapshot,
  BoardFarmStateStore,
} from "./contracts.js";
import {
  assertBoardFarmStateSnapshot,
  BOARD_FARM_STATE_SCHEMA_VERSION,
  requireBoardFarmId,
  requireBoardFarmText,
  requireBoardFarmTimestamp,
} from "./schema.js";

export type BoardFarmResourceConfig = {
  id: string;
  profile: string;
  capabilities?: string[];
  metadata?: Record<string, string>;
};

export function createEmptyBoardFarmState(
  resources: BoardFarmResourceConfig[],
  createdAt = 0,
): BoardFarmStateSnapshot {
  requireBoardFarmTimestamp(createdAt, "createdAt");
  const records: BoardFarmResource[] = resources.map((resource) => ({
    id: requireBoardFarmId(resource.id, "resource.id"),
    profile: requireBoardFarmId(resource.profile, "resource.profile"),
    capabilities: [...new Set(resource.capabilities ?? [])]
      .map((capability) => requireBoardFarmId(capability, "resource.capability"))
      .toSorted(),
    metadata: Object.fromEntries(
      Object.entries(resource.metadata ?? {}).map(([key, value]) => [
        requireBoardFarmId(key, "resource.metadata.key"),
        requireBoardFarmText(value, "resource.metadata.value", 1024),
      ]),
    ),
    state: "available",
    updatedAt: createdAt,
  }));
  const state: BoardFarmStateSnapshot = {
    schemaVersion: BOARD_FARM_STATE_SCHEMA_VERSION,
    nextSequence: 1,
    resources: records,
    runs: [],
    leases: [],
    evidence: [],
    auditEvents: [],
    idempotencyRecords: [],
  };
  assertBoardFarmStateSnapshot(state);
  return state;
}

/**
 * Deterministic JSON-safe store for tests and mock deployments.
 * The transaction callback is synchronous so validation and commit form one atomic section.
 */
export class InMemoryBoardFarmStateStore implements BoardFarmStateStore {
  private state: BoardFarmStateSnapshot;

  constructor(initial: BoardFarmStateSnapshot | BoardFarmResourceConfig[], createdAt = 0) {
    this.state = Array.isArray(initial)
      ? createEmptyBoardFarmState(initial, createdAt)
      : structuredClone(initial);
    assertBoardFarmStateSnapshot(this.state);
  }

  snapshot(): BoardFarmStateSnapshot {
    return structuredClone(this.state);
  }

  transaction<Result>(operation: (state: BoardFarmStateSnapshot) => Result): Result {
    const draft = structuredClone(this.state);
    const result = operation(draft);
    assertBoardFarmStateSnapshot(draft);
    this.state = draft;
    return structuredClone(result);
  }
}
