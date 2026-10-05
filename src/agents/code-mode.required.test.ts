import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { runExec } from "./code-mode-execution.js";
import * as state from "./code-mode-state.js";
import * as worker from "./code-mode-worker.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resultDetails,
  resetCodeModeTestState,
} from "./code-mode.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fixture(tools: AnyAgentTool[], timeoutMs = 10_000) {
  const h = createCodeModeHarness();
  Object.assign(h.config, { tools: { codeMode: { enabled: true, timeoutMs } } });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...tools] });
  return { ...h, exec: h.tools[0]! };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetCodeModeTestState();
  resetProcessRegistryForTests();
});

describe("required Code Mode ownership", () => {
  it.each(["cell", "nested", "alias"])(
    "collects real shell terminal output through %s intent",
    async (mode) => {
      const shell = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        notifyOnExit: false,
        backgroundMs: 10,
      });
      const h = fixture([shell]);
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('REQUIRED_SHELL_RESULT'), 120)")}`;
      const result = resultDetails(
        await h.exec.execute("required-shell", {
          required: mode === "cell",
          code: `return await tools.callValue(${JSON.stringify(mode === "alias" ? "exec" : "openclaw:core:exec")}, ${JSON.stringify({ command, required: mode !== "cell", yieldMs: 10 })});`,
        }),
      );
      expect(result).toMatchObject({
        status: "completed",
        value: { status: "completed", exitCode: 0 },
      });
      expect(JSON.stringify(result.value)).toContain("REQUIRED_SHELL_RESULT");
      expect(state.activeRuns.size).toBe(0);
    },
  );

  it("retains one allowance across sequential off-VM waits instead of refilling it", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const releases = [createDeferred(), createDeferred()];
    const started = [createDeferred(), createDeferred()];
    let calls = 0;
    const target = pluginToolWithExecute("required_step", "Step", async () => {
      const index = calls++;
      started[index]!.resolve();
      await releases[index]!.promise;
      return jsonResult(index);
    });
    const h = fixture([target], 1000);
    const budgets: number[] = [];
    vi.spyOn(worker, "runCodeModeWorker").mockImplementation(async (raw) => {
      const leg = raw as { config: { timeoutMs: number } };
      budgets.push(leg.config.timeoutMs);
      now += 200;
      if (budgets.length === 3) {
        return { status: "completed", value: "collected", output: [] };
      }
      return {
        status: "waiting",
        snapshotBytes: new Uint8Array([1]),
        output: [],
        settlementMode: { kind: "awaiting" },
        pendingRequests: [
          {
            id: `bridge:callValue:${budgets.length}`,
            method: "callValue",
            args: ["openclaw:fake-code-mode:required_step", {}],
          },
        ],
      };
    });
    let returned = false;
    const result = h.exec
      .execute("same-budget", { required: true, code: "return 0;" })
      .then((value) => {
        returned = true;
        return value;
      });
    for (let index = 0; index < 2; index++) {
      await started[index]!.promise;
      now += 60_000;
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(state.activeRuns.size).toBe(0);
      releases[index]!.resolve();
    }
    expect(resultDetails(await result)).toMatchObject({ status: "completed", value: "collected" });
    expect(budgets).toEqual([1000, 800, 600]);
    expect(target.execute).toHaveBeenCalledTimes(2);
  });

  it("cancels every pending bridge when synchronous dispatch spends the retained budget", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const release = createDeferred();
    const signals: AbortSignal[] = [];
    const lateUpdates: NonNullable<Parameters<AnyAgentTool["execute"]>[3]>[] = [];
    const target = pluginToolWithExecute("slow_dispatch", "Slow dispatch", async () =>
      jsonResult("unused"),
    );
    const h = fixture([target], 1000);
    const workerRun = vi.spyOn(worker, "runCodeModeWorker").mockResolvedValue({
      status: "waiting",
      snapshotBytes: new Uint8Array([1]),
      output: [],
      settlementMode: { kind: "awaiting" },
      pendingRequests: [0, 1].map((index) => ({
        id: `bridge:callValue:${index}`,
        method: "callValue",
        args: ["openclaw:fake-code-mode:slow_dispatch", {}],
      })),
    });
    const onUpdate = vi.fn();
    const dispatch = vi.fn();
    const result = await runExec({
      ctx: h.ctx,
      toolCallId: "dispatch-timeout",
      code: "return 0;",
      restartSafe: false,
      required: true,
      onUpdate,
      onRuntime: (runtime) => {
        // Model dispatch itself spending time, before createPendingBridgeStates
        // returns. The real bridge state, signal binding, and cleanup all run.
        vi.spyOn(runtime, "callValue").mockImplementation(async (_id, _input, options) => {
          dispatch();
          expect(options?.signal?.aborted).toBe(false);
          signals.push(options!.signal!);
          lateUpdates.push(options!.onUpdate!);
          now += 600;
          await release.promise;
          return "late-result";
        });
      },
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: "failed",
      code: "timeout",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const update of lateUpdates) {
      update(jsonResult("late-update"));
    }
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(workerRun).toHaveBeenCalledOnce();
    expect(state.activeRuns.size).toBe(0);
  });

  it.each(["cancel", "replace", "shutdown"])(
    "ends %s ownership without accepting late output or guest effects",
    async (ending) => {
      const started = createDeferred();
      const release = createDeferred();
      let lateUpdate: Parameters<AnyAgentTool["execute"]>[3];
      let signal: AbortSignal | undefined;
      const pending = pluginToolWithExecute(
        "pending",
        "Pending result",
        async (_id, _args, toolSignal, update) => {
          signal = toolSignal;
          lateUpdate = update;
          started.resolve();
          await release.promise;
          return jsonResult("late-result");
        },
      );
      const effect = pluginToolWithExecute("after", "Effect after result", async () =>
        jsonResult("effect"),
      );
      const h = fixture([pending, effect]);
      const abort = new AbortController();
      const update = vi.fn();
      const running = h.exec.execute(
        "old-cell",
        {
          required: true,
          code: 'await tools.callValue("openclaw:fake-code-mode:pending", {}); return await tools.callValue("openclaw:fake-code-mode:after", {});',
        },
        abort.signal,
        update,
      );
      await started.promise;
      if (ending === "cancel") {
        abort.abort();
      } else if (ending === "shutdown") {
        state.disposeAllCodeModeRuns();
      } else {
        applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, effect] });
      }
      expect(resultDetails(await running)).toMatchObject({ status: "failed", code: "aborted" });
      expect(signal?.aborted).toBe(true);
      lateUpdate?.(jsonResult("late-update"));
      release.resolve();
      await Promise.resolve();
      expect(update).not.toHaveBeenCalled();
      expect(effect.execute).not.toHaveBeenCalled();
      expect(state.activeRuns.size).toBe(0);
      if (ending === "replace") {
        expect(
          resultDetails(await h.exec.execute("new-cell", { code: "return 42;" })),
        ).toMatchObject({ status: "completed", value: 42 });
      }
    },
  );

  it("keeps concurrent cell identities and settlements independent", async () => {
    const started = [createDeferred(), createDeferred()];
    const releases = [createDeferred(), createDeferred()];
    const target = pluginToolWithExecute("concurrent", "Concurrent result", async (_id, args) => {
      const index = (args as { index: number }).index;
      started[index]!.resolve();
      await releases[index]!.promise;
      return jsonResult(index);
    });
    const h = fixture([target]);
    const results = [0, 1].map((index) =>
      h.exec.execute(`cell-${index}`, {
        required: true,
        code: `return await tools.callValue("openclaw:fake-code-mode:concurrent", {index:${index}});`,
      }),
    );
    await Promise.all(started.map((value) => value.promise));
    releases[1]!.resolve();
    expect(resultDetails(await results[1]!)).toMatchObject({ status: "completed", value: 1 });
    releases[0]!.resolve();
    expect(resultDetails(await results[0]!)).toMatchObject({ status: "completed", value: 0 });
    expect(target.execute).toHaveBeenCalledTimes(2);
  });

  it("reports the actual restart-safe rejection before dispatching a required effect", async () => {
    const effect = pluginToolWithExecute("effect", "Side effect", async () => jsonResult("effect"));
    const h = fixture([effect]);
    const result = resultDetails(
      await h.exec.execute("required-replay", {
        required: true,
        restartSafe: true,
        code: 'return await tools.callValue("openclaw:fake-code-mode:effect", {});',
      }),
    );
    expect(result).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: "restart-safe code mode cannot call side-effecting tools.",
    });
    expect(effect.execute).not.toHaveBeenCalled();
  });

  it("preserves guest compute timeout and refuses unfinished required yields", async () => {
    const h = fixture([], 1000);
    expect(
      resultDetails(
        await h.exec.execute("compute-timeout", { required: true, code: "while(true) {}" }),
      ),
    ).toMatchObject({ status: "failed", code: "timeout" });
    expect(
      resultDetails(
        await h.exec.execute("required-yield", {
          required: true,
          code: 'await yield_control("later"); return 1;',
        }),
      ),
    ).toMatchObject({
      status: "failed",
      code: "invalid_input",
      error: expect.stringContaining("cannot yield"),
    });
  });
});
