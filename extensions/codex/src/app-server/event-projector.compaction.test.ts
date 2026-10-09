import {
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach } from "vitest";
import { persistCodexContextCompactionActivity } from "./context-compaction-activity.js";
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  createMockPluginRegistry,
  describe,
  expect,
  forCurrentTurn,
  initializeGlobalHookRunner,
  it,
  path,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
  turnWithStatus,
  vi,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();
afterEach(() => closeOpenClawAgentDatabasesForTest());

async function createPersistedParams() {
  const params = await createParams();
  const sessionTarget = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: "agent:main:compaction",
    storePath: path.join(params.workspaceDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...sessionTarget,
    entry: { sessionId: params.sessionId, updatedAt: 1 },
  });
  return { ...params, sessionKey: sessionTarget.sessionKey, sessionTarget };
}

describe("Codex compaction transcript identity", () => {
  it("persists after context invalidation and waits for the after-hook before live completion", async () => {
    const params = await createPersistedParams();
    const order: string[] = [];
    let beforePersistence: unknown[] | undefined;
    let afterHookEntries: unknown[] | undefined;
    let releaseAfterHook: () => void = () => {};
    const afterHookGate = new Promise<void>((resolve) => {
      releaseAfterHook = resolve;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "after_compaction",
          handler: async () => {
            afterHookEntries = await readSessionTranscriptEvents(params.sessionTarget);
            order.push("after-hook");
            await afterHookGate;
            order.push("after-hook-complete");
          },
        },
      ]),
    );
    const projector = await createProjector(
      {
        ...params,
        onAgentEvent: (event) => {
          if (event.stream === "compaction" && event.data.phase === "end") {
            order.push("live-end");
          }
        },
      },
      {
        onContextCompacted: () => {
          beforePersistence = loadTranscriptEventsSync(params.sessionTarget);
          order.push("context-invalidated");
        },
      },
    );
    const item = { type: "contextCompaction", id: "ordered-compaction" };
    await projector.handleNotification(forCurrentTurn("item/started", { item }));
    const completed = projector.handleNotification(forCurrentTurn("item/completed", { item }));
    try {
      await vi.waitFor(() => expect(afterHookEntries).toBeDefined());
      expect(beforePersistence).toEqual([]);
      expect(afterHookEntries).toMatchObject([
        { type: "session", id: params.sessionId },
        {
          type: "message",
          message: {
            customType: "openclaw.context-compaction",
            __openclaw: { runId: params.runId, itemId: item.id },
          },
        },
      ]);
      expect(order).toEqual(["context-invalidated", "after-hook"]);
    } finally {
      releaseAfterHook();
      await completed;
    }
    expect(order).toEqual(["context-invalidated", "after-hook", "after-hook-complete", "live-end"]);
  });

  it("persists repeated completed items once and correlates lifecycle with history", async () => {
    const params = await createPersistedParams();
    const onAgentEvent = vi.fn();
    const onContextCompacted = vi.fn();
    const projector = await createProjector({ ...params, onAgentEvent }, { onContextCompacted });
    for (const itemId of ["compact-first", "compact-second"]) {
      const item = { type: "contextCompaction", id: itemId };
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      await projector.handleNotification(forCurrentTurn("item/started", { item }));
      await projector.handleNotification(forCurrentTurn("item/completed", { item }));
      await projector.handleNotification(forCurrentTurn("item/completed", { item }));
    }
    await projector.handleNotification(
      turnCompleted([
        { type: "contextCompaction", id: "compact-first" },
        { type: "contextCompaction", id: "compact-second" },
      ]),
    );
    const entries = await readSessionTranscriptEvents(params.sessionTarget);
    const messages = entries.filter(
      (entry) => typeof entry === "object" && entry !== null && "message" in entry,
    );
    expect(messages).toMatchObject([
      {
        message: {
          role: "custom",
          customType: "openclaw.context-compaction",
          excludeFromContext: true,
          __openclaw: { runId: params.runId, itemId: "compact-first" },
        },
      },
      {
        message: {
          role: "custom",
          customType: "openclaw.context-compaction",
          excludeFromContext: true,
          __openclaw: { runId: params.runId, itemId: "compact-second" },
        },
      },
    ]);
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "compaction")
        .map(({ data }) => ({ phase: data.phase, itemId: data.itemId })),
    ).toEqual([
      { phase: "start", itemId: "compact-first" },
      { phase: "end", itemId: "compact-first" },
      { phase: "start", itemId: "compact-second" },
      { phase: "end", itemId: "compact-second" },
    ]);
    expect(
      onAgentEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.stream === "item" && event.data.title === "Context compaction"),
    ).toEqual([]);
    expect(onContextCompacted).toHaveBeenCalledTimes(2);
    expect(projector.buildResult(buildEmptyToolTelemetry()).compactionCount).toBe(2);
  });

  it("recovers a completed snapshot item and idempotently replays its durable activity", async () => {
    const params = await createPersistedParams();
    const projector = await createProjector(params);
    await projector.handleNotification(
      turnCompleted([{ type: "contextCompaction", id: "snapshot-item" }]),
    );
    for (let index = 0; index < 2; index += 1) {
      await persistCodexContextCompactionActivity({
        ...params,
        cwd: params.workspaceDir,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "snapshot-item",
        timestamp: Date.now(),
      });
    }
    const entries = await readSessionTranscriptEvents(params.sessionTarget);
    expect(
      entries.filter((entry) => typeof entry === "object" && entry !== null && "message" in entry),
    ).toHaveLength(1);
    expect(projector.buildResult(buildEmptyToolTelemetry()).compactionCount).toBe(1);
  });

  it.each(["failed", "interrupted"])(
    "ends %s progress without recording success",
    async (status) => {
      const params = await createPersistedParams();
      const onAgentEvent = vi.fn();
      const projector = await createProjector({ ...params, onAgentEvent });
      await projector.handleNotification(
        forCurrentTurn("item/started", { item: { type: "contextCompaction", id: "unfinished" } }),
      );
      await projector.handleNotification(turnWithStatus(status));
      expect(projector.isCompacting()).toBe(false);
      expect(onAgentEvent).toHaveBeenCalledWith({
        stream: "compaction",
        data: { phase: "end", itemId: "unfinished", completed: false, willRetry: false },
      });
      expect(await readSessionTranscriptEvents(params.sessionTarget)).toEqual([]);
    },
  );

  it("does not append completed native activity after the target session is replaced", async () => {
    const params = await createPersistedParams();
    await upsertSessionEntry({
      ...params.sessionTarget,
      entry: { sessionId: "replacement", updatedAt: 2 },
    });
    await persistCodexContextCompactionActivity({
      ...params,
      cwd: params.workspaceDir,
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "old-item",
      timestamp: Date.now(),
    });
    expect(
      await readSessionTranscriptEvents({ ...params.sessionTarget, sessionId: "replacement" }),
    ).toEqual([]);
  });
});
