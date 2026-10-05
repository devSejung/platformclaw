import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../subagent-registry.mocks.shared.js";
import { callGateway } from "../../gateway/call.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { spawnNodeEvalSync } from "../../test-utils/node-process.js";
import { withTimeout } from "../../utils/with-timeout.js";
import { subagentRuns } from "../subagent-registry-memory.js";
import {
  clearSubagentRunsReadCacheForTest,
  observeSubagentRegistryChanges,
  persistSubagentRunsToDisk,
} from "../subagent-registry-state.js";
import * as registry from "../subagent-registry.js";
import {
  createSubagentRegistryTestDeps,
  writeSubagentSessionEntry,
} from "../subagent-registry.persistence.test-support.js";
import { saveSubagentRegistryToSqlite } from "../subagent-registry.store.sqlite.js";
import { resetSubagentRegistryForTests, testing } from "../subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../subagent-registry.types.js";
import { releaseSwarmRun } from "../swarm-scheduler.js";
import { createAgentsWaitTool } from "./agents-wait-tool.js";

const owner = "agent:main:main";
const run: SubagentRunRecord = {
  runId: "cross-process-collector",
  childSessionKey: "agent:worker:subagent:cross-process",
  requesterSessionKey: owner,
  requesterDisplayKey: "main",
  controllerSessionKey: owner,
  task: "synthetic collector",
  cleanup: "keep",
  createdAt: 1,
  execution: { status: "running", startedAt: 1 },
  completion: { required: false },
  delivery: { status: "not_required" },
  collect: true,
  swarmRequesterSessionKey: owner,
};

function completeInAnotherProcess(source = run) {
  const completed: SubagentRunRecord = {
    ...source,
    execution: { status: "terminal", startedAt: 1, endedAt: 2, outcome: { status: "ok" } },
    completion: { required: false, resultText: "REMOTE_COLLECTOR_RESULT", capturedAt: 2 },
    collectorCompletion: { status: "done" },
  };
  writeInAnotherProcess(completed);
}

function writeInAnotherProcess(record: SubagentRunRecord | null) {
  const store = new URL("../subagent-registry.store.sqlite.ts", import.meta.url).href;
  const database = new URL("../../state/openclaw-state-db.ts", import.meta.url).href;
  const result = spawnNodeEvalSync(
    `
    import { saveSubagentRegistryChangesToSqlite } from ${JSON.stringify(store)};
    import { closeOpenClawStateDatabaseForTest } from ${JSON.stringify(database)};
    const run = ${JSON.stringify(record)};
    saveSubagentRegistryChangesToSqlite(run ? new Map([[run.runId, run]]) : new Map(), [${JSON.stringify(run.runId)}]);
    closeOpenClawStateDatabaseForTest();
  `,
    { imports: ["tsx"], timeout: 15_000 },
  );
  expect(result.status, result.stderr).toBe(0);
}

async function withPersistedCollector(
  operation: (source: SubagentRunRecord) => Promise<void>,
  restore: boolean | "queued" = false,
  dispatch?: Promise<unknown>,
) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "collector-wait-")));
  try {
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: directory,
        // The registry deliberately disables its production SQLite reads in Vitest.
        OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1",
      },
      async () => {
        resetSubagentRegistryForTests({ persist: false });
        const source: SubagentRunRecord = {
          ...run,
          createdAt: Date.now(),
          execution: { ...run.execution, startedAt: Date.now() },
          // A legacy pending collector may have retention metadata. Real restore
          // backfills it and persists all rows; that must not claim execution.
          archiveAtMs: Date.now() + 60_000,
        };
        if (restore === "queued") {
          source.execution = { status: "queued" };
          source.groupId = "restored-group";
          source.queuedLaunch = {
            request: { sessionKey: source.childSessionKey, idempotencyKey: source.runId },
            timeoutMs: 60_000,
            schedulerGroupKey: "restored-group",
            maxConcurrent: 1,
          };
        }
        saveSubagentRegistryToSqlite(new Map([[source.runId, source]]));
        if (restore) {
          await writeSubagentSessionEntry({
            stateDir: directory,
            agentId: "worker",
            sessionKey: source.childSessionKey,
            defaultSessionId: "synthetic-child-session",
          });
          vi.mocked(callGateway).mockReset().mockResolvedValue({ status: "pending" });
          if (dispatch) {
            vi.mocked(callGateway).mockReturnValueOnce(dispatch);
          }
          testing.setDepsForTest(
            createSubagentRegistryTestDeps({
              callGateway: vi.mocked(callGateway),
              resolveAgentTimeoutMs: () => 60_000,
            }),
          );
          registry.initSubagentRegistry();
          await vi.waitFor(() =>
            expect(callGateway).toHaveBeenCalledWith(
              expect.objectContaining({
                method: restore === "queued" ? "agent" : "agent.wait",
                params: expect.objectContaining(
                  restore === "queued" ? { idempotencyKey: source.runId } : { runId: source.runId },
                ),
              }),
            ),
          );
          expect(subagentRuns.get(source.runId)).toMatchObject({
            collect: true,
            execution: { status: restore === "queued" ? "queued" : "running" },
          });
          expect(subagentRuns.get(source.runId)?.archiveAtMs).toBeUndefined();
        }
        try {
          await operation(source);
        } finally {
          releaseSwarmRun(source.runId);
          resetSubagentRegistryForTests({ persist: false });
          testing.setDepsForTest();
        }
      },
    );
  } finally {
    closeOpenClawStateDatabaseForTest();
    clearSubagentRunsReadCacheForTest();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("collector completion persisted by another process", () => {
  it.each([
    { required: false, restore: false },
    { required: true, restore: false },
    { required: false, restore: true },
    { required: true, restore: true },
  ])(
    "wakes required=$required restored=$restore without a local event or model polling",
    async ({ required, restore }) => {
      await withPersistedCollector(async (source) => {
        const controller = new AbortController();
        const observer = vi.fn();
        const unsubscribe = observeSubagentRegistryChanges(observer);
        const tool = createAgentsWaitTool({ agentSessionKey: owner });
        const result = tool.execute(
          "observe-collector",
          { ids: [run.runId], ...(required ? { required: true } : { timeoutSeconds: 60 }) },
          controller.signal,
        );
        try {
          completeInAnotherProcess(source);
          // The synchronous child write cannot emit in this process. Only a
          // subsequent timer turn can observe its committed SQLite state.
          expect(observer).not.toHaveBeenCalled();
          // Much shorter than the ordinary observer timeout: only the persisted
          // registry observation can settle this already-open tool invocation.
          await expect(
            withTimeout(result, 3000, "remote completion was not observed"),
          ).resolves.toMatchObject({
            details: {
              completed: [{ runId: run.runId, status: "done", result: "REMOTE_COLLECTOR_RESULT" }],
              pending: [],
            },
          });
        } finally {
          controller.abort();
          unsubscribe();
          await result.catch(() => undefined);
        }
      }, restore);
    },
  );

  it.each(["revoked", "deleted"])(
    "observes remote %s ownership after real restore",
    async (kind) => {
      await withPersistedCollector(async (source) => {
        const controller = new AbortController();
        const result = createAgentsWaitTool({ agentSessionKey: owner }).execute(
          "remote-owner-change",
          { ids: [run.runId], required: true },
          controller.signal,
        );
        try {
          writeInAnotherProcess(
            kind === "deleted"
              ? null
              : {
                  ...source,
                  swarmWaitOwnerSessionKeys: ["agent:other:main"],
                  collectorCompletion: { status: "done" },
                  completion: { required: false, resultText: "MUST_NOT_LEAK" },
                },
          );
          await expect(
            withTimeout(result, 3000, "remote owner change was hidden"),
          ).resolves.toMatchObject({
            details: {
              completed: [],
              pending: [],
              errors: [
                { runId: source.runId, error: kind === "deleted" ? "not_found" : "not_owner" },
              ],
            },
          });
        } finally {
          controller.abort();
          await result.catch(() => undefined);
        }
      }, true);
    },
  );

  it("keeps a newer local generation pending despite a remote old completion", async () => {
    await withPersistedCollector(async (source) => {
      const controller = new AbortController();
      const current = subagentRuns.get(source.runId)!;
      subagentRuns.set(source.runId, {
        ...current,
        generation: 2,
        execution: { status: "running", lifecycleGeneration: "local-next" },
      });
      const result = createAgentsWaitTool({ agentSessionKey: owner }).execute(
        "new-owner",
        { ids: [source.runId], required: true },
        controller.signal,
      );
      const settled = vi.fn();
      void result.then(settled, () => undefined);
      try {
        completeInAnotherProcess(source);
        clearSubagentRunsReadCacheForTest();
        persistSubagentRunsToDisk(new Map(), []);
        await Promise.resolve();
        expect(registry.getSubagentRunByRunId(source.runId)?.generation).toBe(2);
        expect(settled).not.toHaveBeenCalled();
        const successor = subagentRuns.get(source.runId)!;
        successor.collectorCompletion = { status: "done" };
        successor.completion = { required: false, resultText: "LOCAL_SUCCESSOR_RESULT" };
        persistSubagentRunsToDisk(subagentRuns, [source.runId]);
        await expect(result).resolves.toMatchObject({
          details: { completed: [{ result: "LOCAL_SUCCESSOR_RESULT" }], pending: [] },
        });
      } finally {
        controller.abort();
        await result.catch(() => undefined);
      }
    }, true);
  });

  it("adopts a restored queued dispatch before awaiting its gateway response", async () => {
    let finishDispatch!: (value: unknown) => void;
    const dispatch = new Promise((resolve) => {
      finishDispatch = resolve;
    });
    await withPersistedCollector(
      async (source) => {
        const controller = new AbortController();
        const result = createAgentsWaitTool({ agentSessionKey: owner }).execute(
          "adopted-dispatch",
          { ids: [source.runId], required: true },
          controller.signal,
        );
        const settled = vi.fn();
        void result.then(settled, () => undefined);
        try {
          completeInAnotherProcess(source);
          clearSubagentRunsReadCacheForTest();
          persistSubagentRunsToDisk(new Map(), []);
          await Promise.resolve();
          expect(registry.getSubagentRunByRunId(source.runId)).toMatchObject({
            execution: { status: "queued" },
          });
          expect(settled).not.toHaveBeenCalled();
        } finally {
          controller.abort();
          await result.catch(() => undefined);
          finishDispatch({ runId: source.runId });
          await vi.waitFor(() =>
            expect(subagentRuns.get(source.runId)?.execution.status).toBe("running"),
          );
        }
      },
      "queued",
      dispatch,
    );
  });

  it("does not let steady unrelated writes hide a restored remote completion", async () => {
    await withPersistedCollector(async (source) => {
      const controller = new AbortController();
      const unrelated = { ...source, runId: "unrelated-local-writer", collect: false };
      const result = createAgentsWaitTool({ agentSessionKey: owner }).execute(
        "busy-registry",
        { ids: [source.runId], required: true },
        controller.signal,
      );
      const traffic = setInterval(
        () => persistSubagentRunsToDisk(new Map([[unrelated.runId, unrelated]]), [unrelated.runId]),
        50,
      );
      try {
        completeInAnotherProcess(source);
        await expect(
          withTimeout(result, 3000, "unrelated writes hid remote completion"),
        ).resolves.toMatchObject({
          details: { completed: [{ result: "REMOTE_COLLECTOR_RESULT" }], pending: [] },
        });
      } finally {
        clearInterval(traffic);
        controller.abort();
        await result.catch(() => undefined);
      }
    }, true);
  });

  it("removes the persisted probe and local listener on cancellation before a late remote write", async () => {
    await withPersistedCollector(async (source) => {
      const intervals = vi.spyOn(globalThis, "setInterval");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const reads = vi.spyOn(registry, "getSubagentRunsByRunIds");
      const controller = new AbortController();
      const result = createAgentsWaitTool({ agentSessionKey: owner }).execute(
        "cancel-collector",
        { ids: [run.runId], required: true },
        controller.signal,
      );
      const timer = intervals.mock.results.at(-1)?.value;
      expect(timer).toBeDefined();
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
      const readsAfterAbort = reads.mock.calls.length;
      completeInAnotherProcess(source);
      persistSubagentRunsToDisk(new Map(), []);
      expect(reads).toHaveBeenCalledTimes(readsAfterAbort);
    }, true);
  });
});
