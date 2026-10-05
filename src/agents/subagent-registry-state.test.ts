// Subagent registry state tests cover hot read caching over the persisted SQLite snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptRestoredSubagentRun,
  clearSubagentRunsReadCacheForTest,
  getSubagentSessionListRunsSnapshotForRead,
  getSubagentRunsSnapshotForChildSession,
  getSubagentRunsSnapshotForController,
  getSubagentRunsSnapshotForRead,
  onSubagentRegistryPersisted,
  observeSubagentRegistryChanges,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const mocks = vi.hoisted(() => ({
  loadSubagentRunsForChildSessionFromSqlite:
    vi.fn<(childSessionKey: string) => SubagentRunRecord[]>(),
  loadSubagentRunsForControllerFromSqlite:
    vi.fn<(controllerSessionKey: string) => SubagentRunRecord[]>(),
  loadSubagentRegistryFromSqlite: vi.fn<() => Map<string, SubagentRunRecord>>(),
  loadSubagentSessionListRunsFromSqlite: vi.fn<() => Map<string, SubagentRunReadRecord>>(),
  saveSubagentRegistryChangesToSqlite:
    vi.fn<(runs: Map<string, SubagentRunRecord>, changedRunIds: readonly string[]) => void>(),
  saveSubagentRegistryToSqlite: vi.fn<(runs: Map<string, SubagentRunRecord>) => void>(),
}));

vi.mock("./subagent-registry.store.sqlite.js", () => ({
  loadSubagentRunsForChildSessionFromSqlite: mocks.loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite: mocks.loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite: mocks.loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite: mocks.loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryChangesToSqlite: mocks.saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite: mocks.saveSubagentRegistryToSqlite,
}));

function createRun(runId: string): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: `task ${runId}`,
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running", startedAt: 1 },
  };
}

describe("subagent registry state read cache", () => {
  const previousReadSqliteFlag = process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = "1";
    clearSubagentRunsReadCacheForTest();
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReset();
    mocks.loadSubagentRunsForControllerFromSqlite.mockReset();
    mocks.loadSubagentRegistryFromSqlite.mockReset();
    mocks.loadSubagentSessionListRunsFromSqlite.mockReset();
    mocks.saveSubagentRegistryChangesToSqlite.mockReset();
    mocks.saveSubagentRegistryToSqlite.mockReset();
  });

  afterEach(() => {
    clearSubagentRunsReadCacheForTest();
    if (previousReadSqliteFlag === undefined) {
      delete process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE;
    } else {
      process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE = previousReadSqliteFlag;
    }
    vi.useRealTimers();
  });

  it("reuses persisted snapshots for hot reads within the ttl", () => {
    const firstRun = createRun("run-first");
    const secondRun = createRun("run-second");
    mocks.loadSubagentRegistryFromSqlite
      .mockReturnValueOnce(new Map([[firstRun.runId, firstRun]]))
      .mockReturnValueOnce(new Map([[secondRun.runId, secondRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-second"]);
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(2);
  });

  function restoreCollector() {
    const pending = { ...createRun("restored"), collect: true };
    mocks.loadSubagentRegistryFromSqlite.mockImplementation(() =>
      structuredClone(new Map([[pending.runId, pending]])),
    );
    const local = new Map<string, SubagentRunRecord>();
    restoreSubagentRunsFromDisk({ runs: local });
    const entry = local.get(pending.runId)!;
    const remote: SubagentRunRecord = {
      ...pending,
      collectorCompletion: { status: "done" },
      execution: { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
    };
    mocks.loadSubagentRegistryFromSqlite.mockImplementation(() =>
      structuredClone(new Map([[remote.runId, remote]])),
    );
    return { local, entry, remote };
  }

  it("observes remote completion after restore and incidental archive backfill", () => {
    const { local, entry, remote } = restoreCollector();
    entry.archiveAtMs = 100_000;
    persistSubagentRunsToDisk(local);
    expect(
      getSubagentRunsSnapshotForRead(local).get(entry.runId)?.collectorCompletion,
    ).toBeUndefined();
    vi.advanceTimersByTime(500);
    expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toEqual(remote);
    expect(entry.collectorCompletion).toBeUndefined();
  });

  it.each(["mutation", "adoption", "replacement", "failed-write"])(
    "retains local %s authority over an older remote completion",
    (kind) => {
      const { local, entry } = restoreCollector();
      if (kind === "adoption") {
        adoptRestoredSubagentRun(entry);
      } else if (kind === "replacement") {
        local.set(entry.runId, { ...entry, generation: 2 });
      } else {
        entry.generation = 2;
        entry.execution = { status: "running", lifecycleGeneration: "new-owner" };
        if (kind === "failed-write") {
          mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
            throw new Error("disk unavailable");
          });
          persistSubagentRunsToDisk(local, [entry.runId]);
          vi.advanceTimersByTime(500);
        }
      }
      expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toBe(local.get(entry.runId));
      expect(
        getSubagentRunsSnapshotForRead(local).get(entry.runId)?.collectorCompletion,
      ).toBeUndefined();
    },
  );

  it("preserves replica provenance after a strict write failure and synchronous rollback", () => {
    const { local, entry, remote } = restoreCollector();
    const previousExecution = entry.execution;
    entry.execution = { status: "terminal", endedAt: 3, outcome: { status: "error" } };
    mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    expect(() => persistSubagentRunsToDiskOrThrow(local, [entry.runId])).toThrow(
      "disk unavailable",
    );
    entry.execution = previousExecution;
    expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toEqual(remote);
  });

  it("keeps cancellation authoritative despite a failed write and later remote success", () => {
    const { local, entry } = restoreCollector();
    entry.collectorCompletion = { status: "killed" };
    mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    persistSubagentRunsToDisk(local, [entry.runId]);
    vi.advanceTimersByTime(500);
    expect(
      getSubagentRunsSnapshotForRead(local).get(entry.runId)?.collectorCompletion?.status,
    ).toBe("killed");
  });

  it.each(["revoked", "deleted"])("observes a remote %s replica", (kind) => {
    const { local, entry, remote } = restoreCollector();
    remote.swarmWaitOwnerSessionKeys = ["agent:other:main"];
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      kind === "deleted" ? new Map() : new Map([[remote.runId, remote]]),
    );
    const observed = getSubagentRunsSnapshotForRead(local).get(entry.runId);
    expect(observed).toEqual(kind === "deleted" ? undefined : remote);
  });

  it("retains locally revoked wait ownership over remote success", () => {
    const { local, entry } = restoreCollector();
    entry.swarmWaitOwnerSessionKeys = ["agent:other:main"];
    expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toBe(entry);
    expect(
      getSubagentRunsSnapshotForRead(local).get(entry.runId)?.collectorCompletion,
    ).toBeUndefined();
  });

  it("reconciles restored replicas in scoped and projected readers too", () => {
    const { local, entry, remote } = restoreCollector();
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([remote]);
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([remote]);
    mocks.loadSubagentSessionListRunsFromSqlite.mockReturnValue(new Map([[remote.runId, remote]]));
    expect(
      getSubagentRunsSnapshotForController(local, entry.requesterSessionKey).get(entry.runId),
    ).toEqual(remote);
    expect(
      getSubagentRunsSnapshotForChildSession(local, entry.childSessionKey).get(entry.runId),
    ).toEqual(remote);
    expect(
      getSubagentSessionListRunsSnapshotForRead(local).get(entry.runId)?.execution.endedAt,
    ).toBe(2);
  });

  it.each(["terminal", "suppressed", "killed", "recovery"])(
    "does not demote restored %s local owners",
    (kind) => {
      const pending: SubagentRunRecord = { ...createRun("owned-restored"), collect: true };
      if (kind === "terminal") {
        pending.execution.status = "terminal";
      }
      if (kind === "suppressed") {
        pending.execution.suppressSessionEffects = true;
      }
      if (kind === "killed") {
        pending.killIntent = { reason: "cancelled", requestedAt: 2 };
      }
      if (kind === "recovery") {
        pending.terminalOwner = "interrupted-recovery";
      }
      mocks.loadSubagentRegistryFromSqlite
        .mockReturnValueOnce(new Map([[pending.runId, pending]]))
        .mockReturnValue(new Map());
      const local = new Map<string, SubagentRunRecord>();
      restoreSubagentRunsFromDisk({ runs: local });
      expect(getSubagentRunsSnapshotForRead(local).get(pending.runId)).toBe(pending);
    },
  );

  it("uses the restored replica when SQLite is unavailable without losing provenance", () => {
    const { local, entry, remote } = restoreCollector();
    mocks.loadSubagentRegistryFromSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toBe(entry);
    expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toEqual(remote);
  });

  it("does not renew unrelated persisted observations with partial writes", () => {
    const { local, entry, remote } = restoreCollector();
    const unrelated = createRun("local-writer");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValueOnce(
      new Map([[entry.runId, structuredClone(entry)]]),
    );
    expect(
      getSubagentRunsSnapshotForRead(local).get(entry.runId)?.collectorCompletion,
    ).toBeUndefined();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(100);
      unrelated.task = `write ${i}`;
      persistSubagentRunsToDisk(new Map([[unrelated.runId, unrelated]]), [unrelated.runId]);
    }
    expect(getSubagentRunsSnapshotForRead(local).get(entry.runId)).toEqual(remote);
  });

  it("refreshes the local read cache after successful writes", () => {
    const firstRun = createRun("run-first");
    const savedRun = createRun("run-saved");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[firstRun.runId, firstRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);

    persistSubagentRunsToDisk(new Map([[savedRun.runId, savedRun]]));

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-saved"]);
    expect(mocks.saveSubagentRegistryToSqlite).toHaveBeenCalledOnce();
    expect(mocks.loadSubagentRegistryFromSqlite).toHaveBeenCalledTimes(1);
  });

  it("uses the projected sqlite snapshot for session-list reads", () => {
    const firstRun = createRun("run-first");
    firstRun.model = "openai/gpt-5.6";
    const secondRun = createRun("run-second");
    mocks.loadSubagentSessionListRunsFromSqlite
      .mockReturnValueOnce(new Map([[firstRun.runId, firstRun]]))
      .mockReturnValueOnce(new Map([[secondRun.runId, secondRun]]));

    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual(["run-first"]);
    expect(mocks.loadSubagentSessionListRunsFromSqlite).toHaveBeenCalledTimes(1);
    expect(mocks.loadSubagentRegistryFromSqlite).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "run-second",
    ]);
    expect(mocks.loadSubagentSessionListRunsFromSqlite).toHaveBeenCalledTimes(2);
  });

  it("refreshes session-list projections from authoritative writes", () => {
    const savedRun = createRun("run-saved");
    savedRun.model = "openai/gpt-5.6";
    savedRun.execution.outcome = { status: "ok", error: "not projected" };
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[savedRun.runId, savedRun]]));

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map()).get(savedRun.runId);
    expect(projected).toMatchObject({
      runId: savedRun.runId,
      model: savedRun.model,
      execution: { outcome: { status: "ok" } },
    });
    expect(projected?.execution.outcome).not.toHaveProperty("error");
    expect(mocks.loadSubagentSessionListRunsFromSqlite).not.toHaveBeenCalled();
  });

  it("preserves unrelated projected rows across incremental writes", () => {
    const retained = createRun("retained");
    const changed = createRun("changed");
    mocks.loadSubagentSessionListRunsFromSqlite.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [changed.runId, changed],
      ]),
    );
    expect([...getSubagentSessionListRunsSnapshotForRead(new Map()).keys()]).toEqual([
      "retained",
      "changed",
    ]);

    changed.model = "openai/gpt-5.6";
    persistSubagentRunsToDisk(new Map([[changed.runId, changed]]), [changed.runId]);

    const projected = getSubagentSessionListRunsSnapshotForRead(new Map());
    expect([...projected.keys()]).toEqual(["retained", "changed"]);
    expect(projected.get(changed.runId)?.model).toBe("openai/gpt-5.6");
    expect(mocks.loadSubagentSessionListRunsFromSqlite).toHaveBeenCalledOnce();
  });

  it("updates only named runs in the local read cache", () => {
    const changed = createRun("changed");
    const untouched = createRun("untouched");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [changed.runId, changed],
        [untouched.runId, untouched],
      ]),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["changed", "untouched"]);

    changed.task = "updated";
    const runs = new Map([
      [changed.runId, changed],
      [untouched.runId, untouched],
    ]);
    persistSubagentRunsToDisk(runs, [changed.runId]);

    expect(mocks.saveSubagentRegistryChangesToSqlite).toHaveBeenCalledWith(runs, [changed.runId]);
    expect(mocks.saveSubagentRegistryToSqlite).not.toHaveBeenCalled();
    expect(getSubagentRunsSnapshotForRead(new Map()).get(changed.runId)?.task).toBe("updated");
    expect(getSubagentRunsSnapshotForRead(new Map()).get(untouched.runId)?.task).toBe(
      untouched.task,
    );
  });

  it("keeps an exact deletion authoritative after a best-effort write failure", () => {
    const retained = createRun("retained");
    const removed = createRun("removed");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(
      new Map([
        [retained.runId, retained],
        [removed.runId, removed],
      ]),
    );
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["retained", "removed"]);
    mocks.saveSubagentRegistryChangesToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[retained.runId, retained]]), [removed.runId]);

    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["retained"]);
  });

  it("wakes local readers when a best-effort write fails", () => {
    const staleRun = createRun("stale");
    const updatedRun = createRun("updated");
    mocks.loadSubagentRegistryFromSqlite.mockReturnValue(new Map([[staleRun.runId, staleRun]]));
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["stale"]);
    const listener = vi.fn();
    const unsubscribe = onSubagentRegistryPersisted(listener);
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });

    persistSubagentRunsToDisk(new Map([[updatedRun.runId, updatedRun]]));

    expect(listener).toHaveBeenCalledOnce();
    expect([...getSubagentRunsSnapshotForRead(new Map()).keys()]).toEqual(["updated"]);
    unsubscribe();
  });

  it("observes external snapshots at cache cadence and releases both wake sources", () => {
    const listener = vi.fn();
    const unsubscribe = observeSubagentRegistryChanges(listener);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(499);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledOnce();
    persistSubagentRunsToDisk(new Map());
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    persistSubagentRunsToDisk(new Map());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("queries controller rows directly and overlays matching in-memory state", () => {
    const persisted = createRun("shared");
    persisted.controllerSessionKey = "agent:main:controller";
    persisted.task = "persisted";
    const inMemory = { ...persisted, task: "in-memory" };
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([persisted]);

    const result = getSubagentRunsSnapshotForController(
      new Map([[inMemory.runId, inMemory]]),
      "agent:main:controller",
    );

    expect(result.get("shared")?.task).toBe("in-memory");
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledOnce();
    expect(getSubagentRunsSnapshotForController(new Map(), "   ")).toEqual(new Map());
  });

  it("queries one child directly and returns isolated snapshots", () => {
    const childSessionKey = "agent:main:subagent:child";
    const persisted = createRun("child");
    persisted.childSessionKey = childSessionKey;
    persisted.task = "persisted";
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([persisted]);

    const first = getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);
    first.get("child")!.task = "mutated";
    const second = getSubagentRunsSnapshotForChildSession(new Map(), childSessionKey);

    expect(second.get("child")?.task).toBe("persisted");
    expect(mocks.loadSubagentRunsForChildSessionFromSqlite).toHaveBeenCalledTimes(2);
  });

  it("masks persisted scope membership when the live run moved", () => {
    const persisted = createRun("moved");
    persisted.controllerSessionKey = "agent:main:controller:old";
    persisted.childSessionKey = "agent:main:subagent:old";
    const inMemory = {
      ...persisted,
      controllerSessionKey: "agent:main:controller:new",
      childSessionKey: "agent:main:subagent:new",
    };
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([persisted]);
    mocks.loadSubagentRunsForChildSessionFromSqlite.mockReturnValue([persisted]);
    const live = new Map([[inMemory.runId, inMemory]]);

    expect(getSubagentRunsSnapshotForController(live, "agent:main:controller:old")).toEqual(
      new Map(),
    );
    expect(getSubagentRunsSnapshotForChildSession(live, "agent:main:subagent:old")).toEqual(
      new Map(),
    );
  });

  it("preserves the fresh authoritative write snapshot before returning to scoped SQL", () => {
    const controllerSessionKey = "agent:main:controller";
    const saved = createRun("saved");
    saved.controllerSessionKey = controllerSessionKey;
    mocks.saveSubagentRegistryToSqlite.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    mocks.loadSubagentRunsForControllerFromSqlite.mockReturnValue([]);

    persistSubagentRunsToDisk(new Map([[saved.runId, saved]]));

    expect([
      ...getSubagentRunsSnapshotForController(new Map(), controllerSessionKey).keys(),
    ]).toEqual(["saved"]);
    expect(mocks.loadSubagentRunsForControllerFromSqlite).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(getSubagentRunsSnapshotForController(new Map(), controllerSessionKey)).toEqual(
      new Map(),
    );
    expect(mocks.loadSubagentRunsForControllerFromSqlite).toHaveBeenCalledOnce();
  });
});
