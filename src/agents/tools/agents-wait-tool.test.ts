import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../subagent-registry.types.js";

const records = new Map<string, SubagentRunRecord>();
const registryEvents = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

vi.mock("../subagent-registry.js", () => ({
  getSwarmRunByLaunchReplayKey: vi.fn(),
  initSubagentRegistry: vi.fn(),
  getSubagentRunsByRunIds: (runIds: readonly string[]) => ({
    entries: new Map(
      runIds.flatMap((runId) => {
        const entry =
          records.get(runId) ??
          [...records.values()].find((candidate) => candidate.swarmRunId === runId);
        return entry ? [[runId, entry] as const] : [];
      }),
    ),
    latestByChildSessionKey: new Map(
      [...records.values()].map((entry) => [entry.childSessionKey, entry]),
    ),
  }),
}));

vi.mock("../subagent-registry-state.js", () => ({
  observeSubagentRegistryChanges: (listener: () => void) => {
    registryEvents.listeners.add(listener);
    return () => registryEvents.listeners.delete(listener);
  },
}));

import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "../code-mode.test-support.js";
import { isToolResultError } from "../tool-result-error.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";
import { testing } from "./agents-wait-tool.test-support.js";

function collectorRun(
  runId: string,
  requesterSessionKey: string,
  completion?: SubagentRunRecord["collectorCompletion"],
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:worker:subagent:${runId}`,
    controllerSessionKey: requesterSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: runId,
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: completion ? "terminal" : "running" },
    collect: true,
    swarmRequesterSessionKey: requesterSessionKey,
    groupId: "group",
    completion: { required: false, resultText: completion ? `result-${runId}` : undefined },
    collectorCompletion: completion,
  };
}

describe("agents_wait", () => {
  afterEach(() => resetCodeModeTestState());
  beforeEach(() => {
    records.clear();
    registryEvents.listeners.clear();
  });

  it("settles a parked collector bridge from a registry write event", async () => {
    const entry = collectorRun("event-driven", "agent:main:main");
    records.set(entry.runId, entry);
    const completion = waitForCollectorCompletion({
      runId: entry.runId,
      currentSessionKeys: new Set(["agent:main:main"]),
    });

    entry.completion = { required: false, resultText: "event result" };
    entry.collectorCompletion = { status: "done" };
    for (const listener of registryEvents.listeners) {
      listener();
    }

    await expect(completion).resolves.toMatchObject({
      runId: "event-driven",
      status: "done",
      result: "event result",
    });
    expect(registryEvents.listeners.size).toBe(0);
  });

  it("returns retained visible output when a successful collector ends with NO_REPLY", async () => {
    const entry = collectorRun("retained", "agent:main:main", { status: "done" });
    entry.execution = { status: "terminal", outcome: { status: "ok" } };
    entry.completion = {
      required: false,
      resultText: "NO_REPLY",
      fallbackResultText: "retained collector result",
    };
    records.set(entry.runId, entry);

    await expect(
      waitForCollectorCompletion({
        runId: entry.runId,
        currentSessionKeys: new Set(["agent:main:main"]),
      }),
    ).resolves.toMatchObject({ result: "retained collector result" });
  });

  it("rejects when abort wins the listener-registration race", async () => {
    const entry = collectorRun("abort-race", "agent:main:main");
    records.set(entry.runId, entry);
    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      controller.abort();
      originalAddEventListener(...args);
    });

    await expect(
      waitForCollectorCompletion({
        runId: entry.runId,
        currentSessionKeys: new Set(["agent:main:main"]),
        signal: controller.signal,
      }),
    ).rejects.toThrow("agents.run wait aborted");
    expect(registryEvents.listeners.size).toBe(0);
  });

  it.each(["cell", "nested"])(
    "retains all collector results through %s intent and registry replacement",
    async (mode) => {
      const first = collectorRun("one", "agent:main:main", { status: "done" });
      const second = collectorRun("two", "agent:main:main");
      records.set(first.runId, first);
      records.set(second.runId, second);
      records.set("foreign", collectorRun("foreign", "agent:other:main", { status: "done" }));
      const tool = createAgentsWaitTool({ agentSessionKey: "agent:main:main" });
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
      let returned = false;
      const running = h.tools[0]!.execute("required", {
        required: mode === "cell",
        code: `return await tools.callValue("openclaw:core:agents_wait", ${JSON.stringify({ ids: ["one", "two", "foreign"], required: mode === "nested" })});`,
      }).then((value) => {
        returned = true;
        return value;
      });
      await vi.waitFor(() => expect(registryEvents.listeners.size).toBe(1));
      expect(returned).toBe(false);
      expect(registryEvents.listeners.size).toBe(1);
      records.set("two", collectorRun("two", "agent:main:main", { status: "failed" }));
      for (const listener of registryEvents.listeners) {
        listener();
      }
      expect(resultDetails(await running)).toMatchObject({
        status: "completed",
        value: {
          completed: [
            { runId: "one", status: "done" },
            { runId: "two", status: "failed" },
          ],
          pending: [],
          errors: [{ runId: "foreign", error: "not_owner" }],
        },
      });
      expect(registryEvents.listeners.size).toBe(0);
    },
  );

  it("cancels a required join without leaving registry listeners or accepting a late result", async () => {
    records.set("one", collectorRun("one", "agent:main:main"));
    const tool = createAgentsWaitTool({ agentSessionKey: "agent:main:main" });
    const controller = new AbortController();
    const running = tool.execute("required", { ids: ["one"], required: true }, controller.signal);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(registryEvents.listeners.size).toBe(0);
    records.set("one", collectorRun("one", "agent:main:main", { status: "done" }));
    for (const listener of registryEvents.listeners) {
      listener();
    }
    await expect(
      tool.execute("invalid", { ids: ["one"], required: true, timeoutSeconds: 1 }),
    ).rejects.toThrow("cannot also specify");
    await expect(tool.execute("invalid", { ids: ["one"], required: "yes" })).rejects.toThrow(
      "boolean",
    );
  });

  it("exposes ownership helpers through test support", () => {
    const entry = collectorRun("owned", "agent:main:main");
    expect(testing.ownsRun(entry, new Set(["agent:main:main"]))).toBe(true);
  });

  it("returns the first completed child and leaves siblings pending", async () => {
    records.set("one", collectorRun("one", "agent:main:main"));
    records.set("two", collectorRun("two", "agent:main:main"));
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });
    setTimeout(() => {
      const entry = records.get("two");
      if (!entry) {
        return;
      }
      entry.completion = { required: false, resultText: "result-two" };
      entry.collectorCompletion = {
        status: "done",
        structured: { winner: 2 },
      };
      for (const listener of registryEvents.listeners) {
        listener();
      }
    }, 5);

    const result = await tool.execute("call", { ids: ["one", "two"], timeoutSeconds: 1 });
    expect(result.details).toEqual({
      completed: [
        {
          runId: "two",
          status: "done",
          result: "result-two",
          structured: { winner: 2 },
          sessionKey: "agent:worker:subagent:two",
        },
      ],
      pending: ["one"],
    });
  });

  it("orders completions by their durable capture time instead of input order", async () => {
    const later = collectorRun("later", "agent:main:main", { status: "done" });
    later.completion = { required: false, resultText: "later", capturedAt: 10 };
    const earlier = collectorRun("earlier", "agent:main:main", { status: "done" });
    earlier.completion = { required: false, resultText: "earlier", capturedAt: 5 };
    records.set(later.runId, later);
    records.set(earlier.runId, earlier);
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", {
      ids: ["later", "earlier"],
      timeoutSeconds: 0,
    });

    expect(result.details).toMatchObject({
      completed: [{ runId: "earlier" }, { runId: "later" }],
      pending: [],
    });
  });

  it("is idempotent and returns per-id ownership and unknown errors", async () => {
    const done = collectorRun("done", "agent:worker:subagent:owner", { status: "done" });
    done.swarmWaitOwnerSessionKeys = ["agent:worker:subagent:owner", "agent:main:main"];
    records.set("done", done);
    records.set("owner", collectorRun("owner", "agent:main:main"));
    records.set("foreign", collectorRun("foreign", "agent:other:main", { status: "failed" }));
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: { enabled: true, waitTimeoutSecondsMax: 1 } } },
    });

    const first = await tool.execute("call", {
      ids: ["done", "foreign", "missing"],
      timeoutSeconds: 5,
    });
    const second = await tool.execute("call", {
      ids: ["done", "foreign", "missing"],
      timeoutSeconds: 5,
    });
    expect(second.details).toEqual(first.details);
    expect(first.details).toMatchObject({
      completed: [{ runId: "done", status: "done" }],
      pending: [],
      errors: [
        { runId: "foreign", error: "not_owner" },
        { runId: "missing", error: "not_found" },
      ],
    });
    expect(isToolResultError(first)).toBe(false);
  });

  it("authorizes a snapshotted ancestor after the ordinary spawner row is archived", async () => {
    const ownerSessionKey = "agent:worker:subagent:ordinary-owner";
    records.set("ordinary-owner", {
      runId: "ordinary-owner",
      childSessionKey: ownerSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "spawn collector",
      cleanup: "delete",
      createdAt: Date.now(),
      execution: { status: "running" },
    });
    const completed = collectorRun("nested", ownerSessionKey, { status: "done" });
    completed.swarmWaitOwnerSessionKeys = [ownerSessionKey, "agent:main:main"];
    records.set(completed.runId, completed);
    records.delete("ordinary-owner");
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", { ids: ["nested"], timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      completed: [{ runId: "nested", status: "done" }],
      pending: [],
    });
  });

  it("keeps the public collector id after gateway run replacement", async () => {
    const remapped = collectorRun("gateway-run", "agent:main:main", { status: "done" });
    remapped.swarmRunId = "collector-run";
    records.set(remapped.runId, remapped);
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", { ids: ["collector-run"], timeoutSeconds: 0 });

    expect(result.details).toMatchObject({
      completed: [{ runId: "collector-run", status: "done" }],
      pending: [],
    });
  });

  it("re-resolves a collector replaced while waiting", async () => {
    const pending = collectorRun("old-gateway-run", "agent:main:main");
    pending.swarmRunId = "collector-run";
    records.set(pending.runId, pending);
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });
    setTimeout(() => {
      records.delete(pending.runId);
      const completed = collectorRun("new-gateway-run", "agent:main:main", { status: "done" });
      completed.swarmRunId = "collector-run";
      records.set(completed.runId, completed);
    }, 5);

    const result = await tool.execute("call", { ids: ["collector-run"], timeoutSeconds: 1 });
    expect(result.details).toMatchObject({
      completed: [{ runId: "collector-run", status: "done" }],
      pending: [],
    });
  });

  it("does not treat a routed completion owner as the spawning session", async () => {
    const routed = collectorRun("routed", "agent:main:main", { status: "done" });
    routed.controllerSessionKey = "agent:worker:route-a";
    routed.swarmRequesterSessionKey = "agent:worker:route-a";
    records.set(routed.runId, routed);
    const routedOwner = createAgentsWaitTool({
      agentSessionKey: "agent:worker:route-a",
      agentId: "worker",
      config: { tools: { swarm: true } },
    });
    const completionOwner = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const allowed = await routedOwner.execute("owner", { ids: ["routed"], timeoutSeconds: 0 });
    const denied = await completionOwner.execute("proxy", {
      ids: ["routed"],
      timeoutSeconds: 0,
    });

    expect(allowed.details).toMatchObject({ completed: [{ runId: "routed" }] });
    expect(denied.details).toEqual({
      completed: [],
      pending: [],
      errors: [{ runId: "routed", error: "not_owner" }],
      success: false,
    });
    expect(isToolResultError(denied)).toBe(true);
  });

  it("marks entirely missing collector batches as failures without losing per-id errors", async () => {
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    const result = await tool.execute("call", { ids: ["missing"], timeoutSeconds: 0 });

    expect(result.details).toEqual({
      completed: [],
      pending: [],
      errors: [{ runId: "missing", error: "not_found" }],
      success: false,
    });
    expect(isToolResultError(result)).toBe(true);
  });

  it("rejects collector batches containing only blank run ids", async () => {
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    await expect(tool.execute("call", { ids: [" ", "\t"], timeoutSeconds: 0 })).rejects.toThrow(
      "at least one non-empty run id",
    );
  });

  it.each(["before", "during", "registration"] as const)(
    "rejects when the wait is aborted %s collector polling",
    async (abortTiming) => {
      records.set("pending", collectorRun("pending", "agent:main:main"));
      const tool = createAgentsWaitTool({
        agentSessionKey: "agent:main:main",
        agentId: "main",
        config: { tools: { swarm: true } },
      });
      const controller = new AbortController();
      if (abortTiming === "before") {
        controller.abort();
      }
      if (abortTiming === "registration") {
        const addEventListener = controller.signal.addEventListener.bind(controller.signal);
        vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
          controller.abort();
          addEventListener(...args);
        });
      }

      const result = tool.execute(
        "call",
        { ids: ["pending"], timeoutSeconds: 1 },
        controller.signal,
      );
      if (abortTiming === "during") {
        controller.abort();
      }

      await expect(result).rejects.toMatchObject({
        name: "AbortError",
        message: "agents_wait aborted.",
      });
    },
  );

  it("rejects oversized wait batches before polling", async () => {
    const tool = createAgentsWaitTool({
      agentSessionKey: "agent:main:main",
      agentId: "main",
      config: { tools: { swarm: true } },
    });

    await expect(
      tool.execute("call", {
        ids: Array.from({ length: 1_001 }, (_, index) => `run-${index}`),
      }),
    ).rejects.toThrow("at most 1000 ids");
  });
});
