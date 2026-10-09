import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { subscribeEmbeddedAgentSession } from "../embedded-agent-subscribe.js";
import type { AgentTool } from "../runtime/index.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { agentSessionAutomaticCompaction } from "./agent-session-compaction.js";
import {
  createAssistant,
  createAssistantResultStream,
  createResourceLoader,
  createTestSession,
  createUsage,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
const createOverflowAssistant = (activeModel: Model) => ({
  ...createAssistant(activeModel, [{ type: "text", text: "truncated answer" }], "length", 100),
  usage: { ...createUsage(100), output: 0 },
});

const createAutoCompactionSettings = () =>
  SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
    retry: { enabled: false },
  });

function mockInvalidThenTextSummary(recoveredText: string) {
  let requests = 0;
  streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
    return createAssistantResultStream(
      createAssistant(
        activeModel,
        ++requests === 1
          ? [{ type: "thinking", thinking: "internal summary reasoning" }]
          : [{ type: "text", text: recoveredText }],
      ),
    );
  });
  return () => requests;
}

function createCompactionHandlers() {
  return new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
    [
      "session_before_compact",
      [
        async (event: unknown) => {
          const preparation = (
            event as {
              preparation: { firstKeptEntryId: string; tokensBefore: number };
            }
          ).preparation;
          return {
            compaction: {
              summary: "condensed history",
              firstKeptEntryId: preparation.firstKeptEntryId,
              tokensBefore: preparation.tokensBefore,
            },
          };
        },
      ],
    ],
  ]);
}

function appendHistory(sessionManager: SessionManager, assistant: AssistantMessage): void {
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: Date.now() - 2 });
  sessionManager.appendMessage({ ...assistant, timestamp: Date.now() - 1 });
}

registerAgentSessionLoopTestLifecycle();

describe("AgentSession loop correctness", () => {
  it.each(["manual", "automatic"])(
    "correlates repeated %s compactions through events and persisted boundaries",
    async (mode) => {
      const runId = "run-correlation";
      const sessionManager = guardSessionManager(SessionManager.inMemory(), { runId });
      appendHistory(sessionManager, createAssistant(testModel, [{ type: "text", text: "answer" }]));
      let requests = 0;
      streamMocks.streamSimple.mockImplementation((model: Model) =>
        createAssistantResultStream(
          ++requests % 2 === 1
            ? createOverflowAssistant(model)
            : createAssistant(model, [{ type: "text", text: "complete retry" }]),
        ),
      );
      const { session } = await createTestSession({
        sessionManager,
        settingsManager: createAutoCompactionSettings(),
        resourceLoader: createResourceLoader(createCompactionHandlers()),
      });
      const onAgentEvent = vi.fn();
      const subscription = subscribeEmbeddedAgentSession({ session, runId, onAgentEvent });
      try {
        for (const prompt of ["first long request", "second long request"]) {
          if (mode === "manual") {
            appendHistory(
              sessionManager,
              createAssistant(testModel, [{ type: "text", text: prompt }]),
            );
            await session.compact();
          } else {
            await session.prompt(prompt);
          }
        }
        const compactions = sessionManager
          .getBranch()
          .filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(2);
        const itemIds = compactions.map((entry) => entry["__openclaw"]?.itemId);
        expect(itemIds).toEqual([expect.any(String), expect.any(String)]);
        expect(new Set(itemIds).size).toBe(2);
        expect(compactions.map((entry) => entry["__openclaw"]?.runId)).toEqual([runId, runId]);
        const events = onAgentEvent.mock.calls
          .map(([event]) => event)
          .filter((event) => event.stream === "compaction");
        expect(events.map(({ data }) => ({ phase: data.phase, itemId: data.itemId }))).toEqual(
          itemIds.flatMap((itemId) => [
            { phase: "start", itemId },
            { phase: "end", itemId },
          ]),
        );
        expect(subscription.getCompactionCount()).toBe(2);
      } finally {
        subscription.unsubscribe();
      }
    },
  );

  it("carries the canonical assistant entry id through ordered terminal listeners", async () => {
    const assistant = createAssistant(testModel, [{ type: "text", text: "same answer" }]);
    const sessionManager = SessionManager.inMemory();
    sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
    sessionManager.appendMessage({ ...assistant });
    streamMocks.streamSimple.mockImplementation(() => createAssistantResultStream(assistant));
    const appendMessage = vi.spyOn(sessionManager, "appendMessage");
    const { session } = await createTestSession({ sessionManager });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let promptSettled = false;
    let terminalEntryId: string | undefined;

    session.subscribe(async (event) => {
      if (event.type !== "agent_end") {
        return;
      }
      terminalEntryId = event.assistantEntryId;
      order.push("first:start");
      session.subscribe((lateEvent) => {
        if (lateEvent.type === "agent_end") {
          order.push("late");
        }
      });
      unsubscribeSecond();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      throw new Error("listener rejected");
    });
    const unsubscribeSecond = session.subscribe(async (event) => {
      if (event.type === "agent_end") {
        order.push("second");
      }
    });

    const prompt = session.prompt("new prompt").then(() => {
      promptSettled = true;
    });
    await vi.waitFor(() => expect(order).toEqual(["first:start"]));
    expect(promptSettled).toBe(false);

    releaseFirst?.();
    await prompt;

    const persistedAssistantCall = appendMessage.mock.results.findLast(
      (result) => result.type === "return",
    );
    expect(terminalEntryId).toBe(persistedAssistantCall?.value);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("emits agent_settled once after a normal run", async () => {
    const lifecycleEvents: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_end", [async () => lifecycleEvents.push("agent_end")]],
      ["agent_settled", [async () => lifecycleEvents.push("agent_settled")]],
    ]);
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }]),
      ),
    );
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });

    await session.prompt("new prompt");

    expect(lifecycleEvents).toEqual(["agent_end", "agent_settled"]);
  });

  it("manually compacts a completed turn smaller than the retained-token budget", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "short answer" }]),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 10_000 },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });

    const result = await session.compact();

    expect(result.summary).toBe("condensed history");
    expect(sessionManager.getBranch().at(-1)).toMatchObject({
      type: "compaction",
      summary: "condensed history",
    });
  });

  it("keeps a successful high-usage response and performs threshold maintenance without retry", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("new prompt");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "complete answer" }],
      }),
    );
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("skips threshold maintenance when embedded auto-compaction is disabled", async () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("new prompt");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toEqual([]);
  });

  it("does not retry a high-usage turn terminated by a tool result", async () => {
    const terminalTool: ToolDefinition = {
      name: "finish",
      label: "Finish",
      description: "finishes the current run",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: "finished" }],
        details: {},
        terminate: true,
      }),
    };
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "toolCall", id: "call-finish", name: "finish", arguments: {} }],
          "toolUse",
          100,
        ),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      customTools: [terminalTool],
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("finish now");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("compacts and retries a high-usage length-truncated response", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let requestCount = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model) => {
      requestCount += 1;
      return createAssistantResultStream(
        requestCount === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: true }),
    );
    expect(session.getLastAssistantText()).toBe("complete retry");
  });

  it("retries a reasoning-only summary once during default auto-compaction", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let agentRequests = 0;
    let summaryRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      const isSummary = context.systemPrompt?.includes("context summarization assistant") === true;
      if (isSummary) {
        summaryRequests += 1;
        return createAssistantResultStream(
          createAssistant(
            activeModel,
            summaryRequests === 1
              ? [{ type: "thinking", thinking: "internal summary reasoning" }]
              : [{ type: "text", text: "recovered default summary" }],
          ),
        );
      }
      agentRequests += 1;
      return createAssistantResultStream(
        agentRequests === 1
          ? createOverflowAssistant(activeModel)
          : createAssistant(activeModel, [{ type: "text", text: "complete retry" }]),
      );
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect({ agentRequests, summaryRequests }).toEqual({ agentRequests: 2, summaryRequests: 2 });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "overflow", willRetry: true }),
    );
    const compactionEntry = sessionManager.getBranch().find((entry) => entry.type === "compaction");
    expect(compactionEntry).toMatchObject({ type: "compaction", fromHook: false });
    expect(compactionEntry?.summary).toContain("recovered default summary");
    expect(session.getLastAssistantText()).toBe("complete retry");
  });

  it("shares invalid-summary recovery with caller-owned automatic compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "historical answer to summarize" }]),
    );
    const settingsManager = createAutoCompactionSettings();
    const getSummaryRequests = mockInvalidThenTextSummary("recovered caller-owned summary");
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(),
    });

    const result = await session[agentSessionAutomaticCompaction]();

    expect(getSummaryRequests()).toBe(2);
    expect(result.summary).toContain("recovered caller-owned summary");
    const compactions = sessionManager.getBranch().filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
  });

  it("keeps public manual compaction one-shot for invalid summary output", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "historical answer to summarize" }]),
    );
    const settingsManager = createAutoCompactionSettings();
    const getSummaryRequests = mockInvalidThenTextSummary("must not be requested");
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(),
    });

    await expect(session.compact()).rejects.toThrow(
      "Turn prefix summarization failed: model returned no summary text",
    );

    expect(getSummaryRequests()).toBe(1);
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("stops default auto-compaction after two invalid summaries", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let agentRequests = 0;
    let summaryRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      if (context.systemPrompt?.includes("context summarization assistant")) {
        summaryRequests += 1;
        return createAssistantResultStream(
          createAssistant(activeModel, [
            { type: "thinking", thinking: `internal summary reasoning ${summaryRequests}` },
          ]),
        );
      }
      agentRequests += 1;
      return createAssistantResultStream(createOverflowAssistant(activeModel));
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect({ agentRequests, summaryRequests }).toEqual({ agentRequests: 1, summaryRequests: 2 });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "overflow",
        willRetry: false,
        errorMessage:
          "Context overflow recovery failed: Turn prefix summarization failed: model returned no summary text",
      }),
    );
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it.each([1, 2])(
    "preserves cancellation when aborting during summary attempt %i",
    async (abortAttempt) => {
      const settingsManager = createAutoCompactionSettings();
      const compactionEvents: Array<Extract<AgentSessionEvent, { type: "compaction_end" }>> = [];
      let agentRequests = 0;
      let summaryRequests = 0;
      const created = await createTestSession({
        settingsManager,
        resourceLoader: createResourceLoader(),
      });
      const { session } = created;
      streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
        if (context.systemPrompt?.includes("context summarization assistant")) {
          const summaryAttempt = ++summaryRequests;
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            if (summaryAttempt === abortAttempt) {
              session?.abortCompaction();
            }
            stream.push({
              type: "done",
              reason: "stop",
              message: createAssistant(activeModel, [
                { type: "thinking", thinking: `internal summary reasoning ${summaryAttempt}` },
              ]),
            });
            stream.end();
          });
          return stream;
        }
        agentRequests += 1;
        return createAssistantResultStream(createOverflowAssistant(activeModel));
      });
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          compactionEvents.push(event);
        }
      });

      await session.prompt("long request");

      expect({ agentRequests, summaryRequests }).toEqual({
        agentRequests: 1,
        summaryRequests: abortAttempt,
      });
      expect(compactionEvents).toHaveLength(1);
      expect(compactionEvents[0]).toMatchObject({
        type: "compaction_end",
        reason: "overflow",
        aborted: true,
        willRetry: false,
      });
      expect(compactionEvents[0]?.errorMessage).toBeUndefined();
      expect(created.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(
        false,
      );
    },
  );

  it("does not retry provider errors during default auto-compaction", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    let agentRequests = 0;
    let summaryRequests = 0;
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      if (context.systemPrompt?.includes("context summarization assistant")) {
        summaryRequests += 1;
        return createAssistantResultStream({
          ...createAssistant(activeModel, [], "error"),
          errorMessage: "provider unavailable",
        });
      }
      agentRequests += 1;
      return createAssistantResultStream(createOverflowAssistant(activeModel));
    });
    const { session, sessionManager } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(),
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect({ agentRequests, summaryRequests }).toEqual({ agentRequests: 1, summaryRequests: 1 });
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({
        type: "compaction_end",
        reason: "overflow",
        willRetry: false,
        errorMessage:
          "Context overflow recovery failed: Turn prefix summarization failed: provider unavailable",
      }),
    );
    expect(sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
  });

  it("leaves reactive overflow recovery to the caller when configured", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream({
        ...createAssistant(activeModel, [], "error", 100),
        errorMessage: "400 Your input exceeds the context window of this model",
      }),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      contextOverflowRecoveryOwner: "caller",
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toEqual([]);
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model",
    });
  });

  it("keeps threshold maintenance session-owned when the caller owns overflow recovery", async () => {
    const settingsManager = createAutoCompactionSettings();
    const compactionEvents: AgentSessionEvent[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "complete answer" }], "stop", 100),
      ),
    );
    const { session } = await createTestSession({
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
      contextOverflowRecoveryOwner: "caller",
    });
    session.subscribe((event) => {
      if (event.type === "compaction_end") {
        compactionEvents.push(event);
      }
    });

    await session.prompt("long request");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(compactionEvents).toContainEqual(
      expect.objectContaining({ type: "compaction_end", reason: "threshold", willRetry: false }),
    );
  });

  it("delivers a pending prompt immediately after pre-prompt compaction", async () => {
    const sessionManager = SessionManager.inMemory();
    appendHistory(
      sessionManager,
      createAssistant(testModel, [{ type: "text", text: "old answer" }], "stop", 100),
    );
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
      retry: { enabled: false },
    });
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: "new answer" }]),
      );
    });
    const { session } = await createTestSession({
      sessionManager,
      settingsManager,
      resourceLoader: createResourceLoader(createCompactionHandlers()),
    });
    const continueRun = vi.spyOn(session.agent, "continue");

    await session.prompt("pending prompt");

    expect(continueRun).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("pending prompt");
  });

  it("drains a follow-up queued by an agent-end handler", async () => {
    const sessionRef: { current?: AgentSession } = {};
    let queued = false;
    const lifecycleEvents: string[] = [];
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      [
        "agent_end",
        [
          async () => {
            lifecycleEvents.push("agent_end");
            if (!queued) {
              queued = true;
              await sessionRef.current?.followUp("queued after end");
            }
            return undefined;
          },
        ],
      ],
      ["agent_settled", [async () => lifecycleEvents.push("agent_settled")]],
    ]);
    const requests: Context[] = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push(context);
      return createAssistantResultStream(
        createAssistant(activeModel, [{ type: "text", text: `answer ${requests.length}` }]),
      );
    });
    const { session } = await createTestSession({ resourceLoader: createResourceLoader(handlers) });
    sessionRef.current = session;

    await session.prompt("initial prompt");

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("queued after end");
    expect(session.agent.hasQueuedMessages()).toBe(false);
    expect(lifecycleEvents).toEqual(["agent_end", "agent_end", "agent_settled"]);
  });

  it("leaves queued messages dormant after a turn handoff", async () => {
    const sessionRef: { current?: AgentSession } = {};
    const settled = vi.fn();
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["agent_settled", [async () => settled()]],
    ]);
    const yieldTool: ToolDefinition = {
      name: "yield_turn",
      label: "Yield turn",
      description: "ends the current turn for an external handoff",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        activeSession.agent.steer({
          role: "custom",
          customType: "test.turn-handoff",
          content: "resume only for external delivery",
          display: false,
          timestamp: Date.now(),
        });
        activeSession.agent.abort({ code: "turn_handoff", turnHandoff: true });
        return { content: [{ type: "text", text: "yielded" }], details: { yielded: true } };
      },
    };
    streamMocks.streamSimple.mockImplementation((activeModel: Model) =>
      createAssistantResultStream(
        createAssistant(
          activeModel,
          [{ type: "toolCall", id: "call-yield", name: "yield_turn", arguments: {} }],
          "toolUse",
        ),
      ),
    );
    const { session } = await createTestSession({
      customTools: [yieldTool],
      resourceLoader: createResourceLoader(handlers),
    });
    sessionRef.current = session;

    await session.prompt("yield now");

    expect(streamMocks.streamSimple).toHaveBeenCalledOnce();
    expect(session.agent.hasQueuedMessages()).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    session.agent.clearAllQueues();
  });

  it("applies session model, tool, and prompt changes on the following tool turn", async () => {
    const nextModel = { ...testModel, id: "next-model" };
    const sessionRef: { current?: AgentSession } = {};
    const switchTool: ToolDefinition = {
      name: "switch_state",
      label: "Switch state",
      description: "changes the next turn state",
      parameters: Type.Object({}),
      execute: async () => {
        const activeSession = sessionRef.current;
        if (!activeSession) {
          throw new Error("session not ready");
        }
        activeSession.setActiveToolsByName(["second_tool"]);
        activeSession.agent.state.model = nextModel;
        return { content: [{ type: "text", text: "switched" }], details: {} };
      },
    };
    const secondTool: ToolDefinition = {
      name: "second_tool",
      label: "Second tool",
      description: "available after the switch",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const handlers = new Map<string, Array<(...args: unknown[]) => Promise<unknown>>>([
      ["before_agent_start", [async () => ({ systemPrompt: "prompt override" })]],
    ]);
    const requests: Array<{ model: string; prompt: string; tools: string[] }> = [];
    streamMocks.streamSimple.mockImplementation((activeModel: Model, context: Context) => {
      requests.push({
        model: activeModel.id,
        prompt: context.systemPrompt ?? "",
        tools: context.tools?.map((tool) => tool.name) ?? [],
      });
      const content: AssistantMessage["content"] =
        requests.length === 1
          ? [{ type: "toolCall", id: "call-switch", name: "switch_state", arguments: {} }]
          : [{ type: "text", text: "finished" }];
      return createAssistantResultStream(
        createAssistant(activeModel, content, requests.length === 1 ? "toolUse" : "stop"),
      );
    });
    const { session } = await createTestSession({
      resourceLoader: createResourceLoader(handlers),
      customTools: [switchTool, secondTool],
    });
    sessionRef.current = session;
    session.setActiveToolsByName(["switch_state"]);

    await session.prompt("switch now");

    expect(requests).toEqual([
      { model: testModel.id, prompt: "prompt override", tools: ["switch_state"] },
      { model: nextModel.id, prompt: "prompt override", tools: ["second_tool"] },
    ]);
  });

  it("preserves explicit updates from an existing next-turn hook", async () => {
    const hookModel = { ...testModel, id: "hook-model" };
    const hookTool: AgentTool = {
      name: "hook_tool",
      label: "Hook tool",
      description: "provided by the existing turn hook",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const hookContext = {
      systemPrompt: "hook prompt",
      messages: [],
      tools: [hookTool],
    };
    let returnedUpdate = false;
    const { session } = await createTestSession();
    session.agent.prepareNextTurn = () => {
      if (returnedUpdate) {
        return undefined;
      }
      returnedUpdate = true;
      return { context: hookContext, model: hookModel, thinkingLevel: "high" };
    };
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const newMessages = [message];

    const firstUpdate = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [] },
      newMessages,
    });
    const secondUpdate = await contextualHook({
      message,
      toolResults: [],
      context: firstUpdate?.context ?? hookContext,
      newMessages,
    });

    for (const update of [firstUpdate, secondUpdate]) {
      expect(update).toMatchObject({
        context: {
          systemPrompt: "hook prompt",
          tools: [expect.objectContaining({ name: "hook_tool" })],
        },
        model: hookModel,
        thinkingLevel: "high",
      });
    }
  });

  it("preserves fields omitted by an existing next-turn context replacement", async () => {
    const sessionTool: AgentTool = {
      name: "session_tool",
      label: "Session tool",
      description: "available in session state",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
    };
    const initialHook = vi.fn(() => ({
      context: { systemPrompt: "stale prompt", messages: [], tools: [sessionTool] },
    }));
    const replacementHook = vi.fn(() => ({
      context: { systemPrompt: "replacement prompt", messages: [] },
    }));
    const { session } = await createTestSession({ customTools: [sessionTool] });
    session.setActiveToolsByName([sessionTool.name]);
    session.agent.prepareNextTurn = initialHook;
    session.agent.prepareNextTurn = replacementHook;
    const message = createAssistant(testModel, [{ type: "text", text: "turn complete" }]);
    const contextualHook = session.agent.prepareNextTurnWithContext;
    if (!contextualHook) {
      throw new Error("context-aware next-turn hook was not installed");
    }

    const update = await contextualHook({
      message,
      toolResults: [],
      context: { systemPrompt: "loop prompt", messages: [], tools: [sessionTool] },
      newMessages: [message],
    });

    expect(update?.context).toEqual({ systemPrompt: "replacement prompt", messages: [] });
    expect(replacementHook).toHaveBeenCalledOnce();
    expect(initialHook).not.toHaveBeenCalled();
  });

  it("aborts in-flight work when disposed", async () => {
    let providerSignal: AbortSignal | undefined;
    streamMocks.streamSimple.mockImplementation(
      (activeModel: Model, _context: Context, options?: SimpleStreamOptions) => {
        providerSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        options?.signal?.addEventListener(
          "abort",
          () => {
            const message = createAssistant(activeModel, [], "aborted");
            stream.push({ type: "error", reason: "aborted", error: message });
            stream.end();
          },
          { once: true },
        );
        return stream;
      },
    );
    const { session } = await createTestSession();
    const abortRetry = vi.spyOn(session, "abortRetry");
    const abortCompaction = vi.spyOn(session, "abortCompaction");
    const abortBranchSummary = vi.spyOn(session, "abortBranchSummary");
    const abortBash = vi.spyOn(session, "abortBash");
    const abortAgent = vi.spyOn(session.agent, "abort");
    abortRetry.mockImplementationOnce(() => {
      throw new Error("retry abort failed");
    });
    const prompt = session.prompt("wait");
    await vi.waitFor(() => expect(providerSignal).toBeDefined());

    session.dispose();
    await prompt;

    expect(providerSignal?.aborted).toBe(true);
    expect(abortRetry).toHaveBeenCalledOnce();
    expect(abortCompaction).toHaveBeenCalledOnce();
    expect(abortBranchSummary).toHaveBeenCalledOnce();
    expect(abortBash).toHaveBeenCalledOnce();
    expect(abortAgent).toHaveBeenCalledOnce();
  });

  it("resynchronizes queue modes when settings reload", async () => {
    const settingsManager = SettingsManager.inMemory({
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const { session } = await createTestSession({ settingsManager });
    settingsManager.setSteeringMode("all");
    settingsManager.setFollowUpMode("all");
    await settingsManager.flush();

    expect(session.agent.steeringMode).toBe("one-at-a-time");
    expect(session.agent.followUpMode).toBe("one-at-a-time");

    await session.reload();

    expect(session.agent.steeringMode).toBe("all");
    expect(session.agent.followUpMode).toBe("all");
  });
});
