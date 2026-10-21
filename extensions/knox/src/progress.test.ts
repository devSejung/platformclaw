import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKnoxProgress, usesKnoxKoreanNotices } from "./progress.js";

type AgentEvent = Parameters<Parameters<PluginRuntime["events"]["onAgentEvent"]>[0]>[0];
const activeProgress: ReturnType<typeof createKnoxProgress>[] = [];

function setup(
  options: { text?: string; canSend?: () => boolean; pendingDelivery?: boolean } = {},
) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const abort = new AbortController();
  const unsubscribe = vi.fn();
  const subscribe: PluginRuntime["events"]["onAgentEvent"] = (listener) => {
    listeners.add(listener);
    return () => {
      unsubscribe();
      listeners.delete(listener);
    };
  };
  const send = vi.fn(async (_text: string, _ordinal: number, signal: AbortSignal) => {
    if (options.pendingDelivery) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
    }
  });
  const warn = vi.fn();
  const progress = createKnoxProgress({
    text: options.text ?? "Run the checks",
    delayMs: 10_000,
    abortSignal: abort.signal,
    subscribe,
    canSend: options.canSend ?? (() => true),
    send,
    warn,
  });
  activeProgress.push(progress);
  let seq = 0;
  const emit = (stream: string, data: Record<string, unknown>, runId = "own-run") => {
    const event: AgentEvent = { runId, stream, data, seq: ++seq, ts: Date.now() };
    for (const listener of listeners) {
      listener(event);
    }
  };
  progress.replyOptions.onAgentRunStart("own-run");
  return { progress, emit, send, warn, abort, unsubscribe };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const progress of activeProgress.splice(0)) {
    progress.stop();
    await progress.drain();
  }
  vi.useRealTimers();
});

describe("Knox notice language", () => {
  it.each([
    ["Run the checks", false],
    ["漢字だけ", false],
    ["123 /exec 😀", false],
    ["Run 가", true],
    ["ㄱ", true],
    ["가", true],
    ["", false],
  ])("selects Korean exactly when the request contains Hangul: %s", (text, korean) => {
    expect(usesKnoxKoreanNotices(text)).toBe(korean);
  });
});

describe("Knox request progress", () => {
  it("waits ten seconds, then reports a changed tool state only on ten-second ticks", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.map(([text]) => text)).toEqual(["Processing your request."]);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls[1]?.[0]).toBe("Calling exec.");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(send).toHaveBeenCalledTimes(2);
    emit("tool", { phase: "result", toolCallId: "exec-1", name: "exec" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[2]?.[0]).toBe("exec call completed.");
    expect(send.mock.calls.map(([, ordinal]) => ordinal)).toEqual([0, 1, 2]);
  });

  it("renders the same observed facts in Korean when one request character is Hangul", async () => {
    const { progress, emit, send } = setup({ text: "Please run ㄱ" });
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[0]?.[0]).toBe("요청을 처리 중입니다.");
    emit("tool", { phase: "start", toolCallId: "read-1", name: "read" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("read 호출 진행 중입니다.");
    emit("tool", { phase: "result", toolCallId: "read-1", name: "read", isError: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[2]?.[0]).toBe("read 호출이 실패했습니다.");
  });

  it("keeps an earlier active invocation visible when a newer parallel invocation finishes", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    emit("tool", { phase: "start", toolCallId: "a", name: "exec" });
    emit("tool", { phase: "start", toolCallId: "b", name: "read" });
    emit("tool", { phase: "result", toolCallId: "b", name: "read" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Calling exec.");
  });

  it("prioritizes pending native approval over a command item already marked running", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    emit("item", { phase: "start", itemId: "exec-1", kind: "command", name: "exec" });
    emit("approval", {
      phase: "requested",
      status: "pending",
      itemId: "exec-1",
      approvalId: "approval-1",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[0]?.[0]).toBe("Awaiting approval for exec.");
    emit("approval", {
      phase: "resolved",
      status: "approved",
      itemId: "exec-1",
      approvalId: "approval-1",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("exec execution approved.");
  });

  it("clears native approval on a catch-path resolution containing only the item ID", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    emit("approval", {
      phase: "requested",
      status: "pending",
      itemId: "exec-1",
      approvalId: "approval-1",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    emit("approval", {
      phase: "resolved",
      status: "unavailable",
      itemId: "exec-1",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Approval unavailable for exec.");
  });

  it("retains another approval for the same native command when one approval resolves", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    for (const approvalId of ["a", "b"]) {
      emit("approval", {
        phase: "requested",
        status: "pending",
        itemId: "exec-1",
        approvalId,
      });
    }
    emit("approval", {
      phase: "resolved",
      status: "approved",
      itemId: "exec-1",
      approvalId: "b",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[0]?.[0]).toBe("Awaiting approval for exec.");
    emit("approval", {
      phase: "resolved",
      status: "denied",
      itemId: "exec-1",
      approvalId: "a",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("exec execution denied.");
  });

  it("does not claim approval was granted when an inline exec wait merely ends", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    emit("lifecycle", { phase: "waiting-approval", toolCallId: "exec-1", approvalId: "a" });
    await vi.advanceTimersByTimeAsync(10_000);
    emit("lifecycle", { phase: "approval-resolved", toolCallId: "exec-1", approvalId: "a" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Approval wait ended for exec.");
    expect(send.mock.calls[1]?.[0]).not.toContain("approved");
  });

  it("ignores unrelated runs and discards old observations when a new run adopts the request", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    emit("tool", { phase: "start", toolCallId: "a", name: "read" }, "other-run");
    emit("lifecycle", { phase: "end" }, "other-run");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    emit("tool", { phase: "start", toolCallId: "b", name: "exec" });
    progress.replyOptions.onAgentRunStart("replacement-run");
    emit("tool", { phase: "start", toolCallId: "c", name: "search" }, "replacement-run");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Calling search.");
  });

  it("omits hidden activity, arguments, command output, and model commentary", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    emit("tool", {
      phase: "start",
      toolCallId: "hidden",
      name: "internal",
      hideFromChannelProgress: true,
    });
    emit("item", { phase: "start", itemId: "reason", kind: "analysis", name: "PRIVATE_REASONING" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    emit("tool", {
      phase: "start",
      toolCallId: "exec-1",
      name: "exec",
      args: { command: "PRIVATE_COMMAND" },
    });
    emit("command_output", { phase: "delta", toolCallId: "exec-1", output: "PRIVATE_OUTPUT" });
    emit("assistant", { phase: "commentary", text: "PRIVATE_COMMENTARY" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Calling exec.");
    expect(send.mock.calls.map(([text]) => text).join(" ")).not.toMatch(/PRIVATE|internal/);
  });

  it("honors suppressed native items and consumes their canonical tool events", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    // Codex suppresses message item progress without emitting a tool replacement.
    emit("item", {
      phase: "start",
      itemId: "message-1",
      kind: "tool",
      name: "message",
      suppressChannelProgress: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    emit("item", {
      phase: "end",
      itemId: "message-1",
      kind: "tool",
      name: "message",
      status: "completed",
      suppressChannelProgress: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    // Native commands emit the suppressed item before each normalized tool event.
    emit("item", {
      phase: "start",
      itemId: "command-1",
      kind: "command",
      name: "bash",
      suppressChannelProgress: true,
    });
    emit("tool", { phase: "start", itemId: "command-1", toolCallId: "command-1", name: "bash" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Calling bash.");
    emit("item", {
      phase: "end",
      itemId: "command-1",
      kind: "command",
      name: "bash",
      status: "completed",
      suppressChannelProgress: true,
    });
    emit("tool", {
      phase: "result",
      itemId: "command-1",
      toolCallId: "command-1",
      name: "bash",
      status: "completed",
      isError: false,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[2]?.[0]).toBe("bash call completed.");
  });

  it("keeps a pending generic notice valid across fallback attempts", async () => {
    const { progress, emit, send } = setup({ pendingDelivery: true });
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const signal = send.mock.calls[0]?.[2];
    emit("lifecycle", { phase: "finishing" });
    emit("lifecycle", { phase: "start", startedAt: Date.now() });
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["finishing", "start"] as const)(
    "retires unfinished tools and approvals at attempt %s while the run continues",
    async (phase) => {
      const { progress, emit, send } = setup();
      progress.start();
      await vi.advanceTimersByTimeAsync(10_000);
      emit("tool", { phase: "start", toolCallId: "old-call", name: "exec" });
      emit("lifecycle", {
        phase: "waiting-approval",
        toolCallId: "old-call",
        approvalId: "old-approval",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send.mock.calls.at(-1)?.[0]).toBe("Awaiting approval for exec.");
      // A disconnected native attempt can omit item/completed before fallback.
      emit("lifecycle", { phase, startedAt: Date.now() });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send.mock.calls.at(-1)?.[0]).toBe("Processing your request.");
      emit("tool", { phase: "start", toolCallId: "new-call", name: "read" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send.mock.calls.at(-1)?.[0]).toBe("Calling read.");
    },
  );

  it("continues through attempt-local finishing but stops immediately at terminal end", async () => {
    const { progress, emit, send, unsubscribe } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    emit("lifecycle", { phase: "finishing", error: "retryable" });
    emit("lifecycle", { phase: "start", startedAt: Date.now() });
    emit("tool", { phase: "start", toolCallId: "a", name: "exec" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[1]?.[0]).toBe("Calling exec.");
    emit("lifecycle", { phase: "end" });
    emit("tool", { phase: "start", toolCallId: "b", name: "read" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();
    progress.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "abort", "error"] as const)(
    "cancels in-flight progress and future ticks on %s",
    async (termination) => {
      const { progress, emit, send, warn, abort, unsubscribe } = setup({ pendingDelivery: true });
      progress.start();
      await vi.advanceTimersByTimeAsync(10_000);
      const signal = send.mock.calls[0]?.[2];
      expect(signal?.aborted).toBe(false);
      if (termination === "stop") {
        progress.stop();
      } else if (termination === "abort") {
        abort.abort();
      } else {
        emit("lifecycle", { phase: "error" });
      }
      expect(signal?.aborted).toBe(true);
      await progress.drain();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(send).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("stays quiet while source-delivery policy prohibits notices", async () => {
    const { progress, emit, send } = setup({ canSend: () => false });
    progress.start();
    emit("tool", { phase: "start", toolCallId: "a", name: "exec" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not overlap transport requests when a progress acknowledgement is pending", async () => {
    const { progress, emit, send } = setup({ pendingDelivery: true });
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    emit("tool", { phase: "start", toolCallId: "a", name: "exec" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("suspends a deferred request and starts a new delay only after readoption", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(5_000);
    progress.suspend();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    progress.replyOptions.onAgentRunStart("followup-run");
    progress.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send.mock.calls[0]?.[0]).toBe("Processing your request.");
    emit("tool", { phase: "start", toolCallId: "a", name: "exec" }, "own-run");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
