// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentEvent, createHost, useToolStreamFakeTimers } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent, resetToolStream } from "./tool-stream.ts";

beforeAll(() => {
  const browserGlobal = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
  browserGlobal.window ??= globalThis as unknown as Window & typeof globalThis;
});
beforeEach(useToolStreamFakeTimers);
afterEach(() => vi.useRealTimers());

const details = { uiAction: { requestId: "synthetic-request" } };
const result = (overrides: Record<string, unknown> = {}) => ({
  phase: "result",
  toolCallId: "call-1",
  name: "sample_settings",
  result: { content: [], details },
  ...overrides,
});

describe("accepted live tool-result notifications", () => {
  it("publishes the started call's concrete name synchronously before stream cleanup", () => {
    const onChatToolResult = vi.fn();
    const host = createHost({ chatRunId: "run-1", onChatToolResult });
    handleAgentEvent(
      host,
      agentEvent("run-1", 1, "tool", {
        phase: "start",
        toolCallId: "call-1",
        name: "sample_settings",
      }),
      { source: "live" },
    );
    handleAgentEvent(host, agentEvent("run-1", 2, "tool", result({ name: "spoofed" })), {
      source: "live",
    });
    expect(onChatToolResult).toHaveBeenCalledExactlyOnceWith({
      name: "sample_settings",
      toolCallId: "call-1",
      runId: "run-1",
      sessionKey: "main",
      details,
    });
    resetToolStream(host);
    expect(onChatToolResult).toHaveBeenCalledOnce();
  });

  it.each([undefined, { source: "history" as const }])(
    "leaves omitted or history sources inert: %j",
    (options) => {
      const onChatToolResult = vi.fn();
      const host = createHost({ onChatToolResult });
      handleAgentEvent(host, agentEvent("run-1", 1, "tool", result()), options);
      expect(host.chatToolMessages).toHaveLength(1);
      expect(onChatToolResult).not.toHaveBeenCalled();
    },
  );

  it.each([
    { phase: "update", partialResult: { details } },
    { isError: true },
    { result: { content: [], details, isError: true } },
    { name: undefined },
  ])("does not publish incomplete, erroneous or unnamed results: %j", (overrides) => {
    const onChatToolResult = vi.fn();
    const host = createHost({ onChatToolResult });
    handleAgentEvent(host, agentEvent("run-1", 1, "tool", result(overrides)), { source: "live" });
    expect(onChatToolResult).not.toHaveBeenCalled();
  });

  it("fences duplicate sequences, other sessions and sibling runs", () => {
    const onChatToolResult = vi.fn();
    const host = createHost({ chatRunId: "run-1", onChatToolResult });
    const event = agentEvent("run-1", 2, "tool", result());
    handleAgentEvent(host, event, { source: "live" });
    handleAgentEvent(host, event, { source: "live" });
    handleAgentEvent(host, agentEvent("run-1", 3, "tool", result(), "other"), { source: "live" });
    handleAgentEvent(host, agentEvent("run-2", 4, "tool", result()), { source: "live" });
    expect(onChatToolResult).toHaveBeenCalledOnce();
  });

  it("does not republish old history details when a later live result omits them", () => {
    const onChatToolResult = vi.fn();
    const host = createHost({ onChatToolResult });
    handleAgentEvent(host, agentEvent("run-1", 1, "tool", result()), { source: "history" });
    handleAgentEvent(host, agentEvent("run-1", 2, "tool", result({ result: { content: [] } })), {
      source: "live",
    });
    expect(onChatToolResult).toHaveBeenCalledOnce();
    expect(onChatToolResult.mock.calls[0]?.[0].details).toBeUndefined();
  });
});
