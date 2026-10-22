import { describe, expect, it, onTestFinished, vi } from "vitest";
import { onAgentRuntimeEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type { EmbeddedAgentParams } from "./agent-runner-execution.test-support.js";
import {
  buildControlUiAgentFailureText,
  GENERIC_EXTERNAL_RUN_FAILURE_TEXT,
} from "./agent-runner-failure-copy.js";
import { PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE } from "./provider-request-error-classifier.js";

const state = setupAgentRunnerExecutionTestState();

describe("executeAgentTurn: conversation failures", () => {
  it("returns a session reset hint for Bedrock tool mismatch errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error(
        "The number of toolResult blocks at messages.186.content exceeds the number of toolUse blocks of previous turn.",
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "whatsapp",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("returns a provider conversation-state error for OpenAI missing custom tool output errors on external chat channels", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new Error("Custom tool call output is missing for call id: call_live_123."),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "slack",
        ChannelId: "channel-1",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it("does not auto-reset role-ordering provider conversation-state errors", async () => {
    const resetSessionAfterRoleOrderingConflict = vi.fn(async () => true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(new Error("400 Incorrect role information"));

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "telegram",
        ChatId: "chat-1",
      } as unknown as TemplateContext,
      opts: {},
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(resetSessionAfterRoleOrderingConflict).not.toHaveBeenCalled();
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    }
  });

  it.each([
    {
      label: "unknown provider failure",
      error: new Error("private provider implementation details"),
    },
    {
      label: "broken pipe",
      error: Object.assign(new Error("write EPIPE | EPIPE"), { code: "EPIPE" }),
    },
  ])("shows a safe reference for $label on web chat", async ({ error }) => {
    const lifecycleEvents: AgentEventPayload[] = [];
    onTestFinished(onAgentRuntimeEvent((event) => lifecycleEvents.push(event)));
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      commandBody: "hello",
      followupRun: createFollowupRun(),
      sessionCtx: {
        Provider: "chat",
        Surface: "chat",
        MessageSid: "msg",
      } as unknown as TemplateContext,
      opts: { runId: "web-chat-failure" },
      typingSignals: createMockTypingSignaler(),
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => false,
      pendingToolTasks: new Set(),
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "main",
      getActiveSessionEntry: () => undefined,
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Reference: web-chat-failure");
      expect(result.payload.text).not.toContain(error.message);
      expect(result.payload.text).not.toMatch(/EPIPE|terminal|openclaw logs/u);
      const lifecycleError = lifecycleEvents.find(
        (event) => event.runId === "web-chat-failure" && event.data.phase === "error",
      );
      expect(lifecycleError?.data.error).toBe(result.payload.text);
      const report = getReplyPayloadMetadata(result.payload)?.agentRunFailureReport;
      expect(report).toContain("Reference: web-chat-failure");
      expect(report).not.toContain(error.message);
      expect(lifecycleError?.data.errorDetails).toBe(report);
    }
  });

  it("keeps external-channel generic failure copy unchanged", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    );
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());
    expect(result).toMatchObject({
      kind: "final",
      payload: { text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT },
    });
  });

  it("keeps the replay warning when role-ordering recovery cannot repeat actions safely", async () => {
    const lifecycleEvents: AgentEventPayload[] = [];
    onTestFinished(onAgentRuntimeEvent((event) => lifecycleEvents.push(event)));
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [],
      meta: {
        error: {
          kind: "role_ordering",
          message: "Incorrect role information",
          fallbackSafe: false,
        },
      },
    });
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      opts: { runId: "role-ordering-replay-warning" },
    });
    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Check their results before trying again");
      expect(result.payload.text).not.toContain("Please try again in a moment");
      expect(
        lifecycleEvents.find(
          (event) => event.runId === "role-ordering-replay-warning" && event.data.phase === "error",
        )?.data.error,
      ).toBe(result.payload.text);
    }
  });

  it("prefers an owner's safe error payload over deferred technical lifecycle details", async () => {
    const lifecycleEvents: AgentEventPayload[] = [];
    onTestFinished(onAgentRuntimeEvent((event) => lifecycleEvents.push(event)));
    state.isInternalMessageChannelMock.mockReturnValue(true);
    const text = buildControlUiAgentFailureText(new Error("write EPIPE"), "settled-web-failure");
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onAgentEvent?.({
        stream: "lifecycle",
        data: { phase: "finishing", error: "write EPIPE private transport detail" },
      });
      return {
        payloads: [{ text, isError: true }],
        meta: {
          error: { kind: "incomplete_turn", message: "missing assistant", fallbackSafe: false },
        },
      };
    });
    const executeAgentTurn = await getExecuteAgentTurnForTest();
    await executeAgentTurn({
      ...createMinimalRunAgentTurnParams(),
      opts: { runId: "settled-web-failure" },
    });
    const lifecycleError = lifecycleEvents.find(
      (event) => event.runId === "settled-web-failure" && event.data.phase === "error",
    );
    expect(lifecycleError?.data.error).toBe(text);
    expect(lifecycleError?.data.errorDetails).toContain("Reference: settled-web-failure");
    expect(lifecycleError?.data.errorDetails).not.toContain("private transport detail");
  });
});
