import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKnoxProgress, usesKnoxKoreanNotices } from "./progress.js";

type AgentEvent = Parameters<Parameters<PluginRuntime["events"]["onAgentEvent"]>[0]>[0];
const active: ReturnType<typeof createKnoxProgress>[] = [];

function setup(
  options: {
    text?: string;
    canSend?: () => boolean;
    pendingDelivery?: boolean;
    cancel?: (ordinal: number) => Promise<void>;
  } = {},
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
    if (options.pendingDelivery)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      });
  });
  const cancel = vi.fn(options.cancel ?? (async (_ordinal: number) => {}));
  const warn = vi.fn();
  const progress = createKnoxProgress({
    text: options.text ?? "Run checks",
    delayMs: 15_000,
    abortSignal: abort.signal,
    subscribe,
    canSend: options.canSend ?? (() => true),
    send,
    cancel,
    warn,
  });
  active.push(progress);
  let seq = 0;
  const emit = (stream: string, data: Record<string, unknown>, runId = "own-run") => {
    const event: AgentEvent = { runId, stream, data, seq: ++seq, ts: Date.now() };
    for (const listener of listeners) listener(event);
  };
  const tool = (id: string, command: string, state?: string) => {
    emit("tool", { phase: "start", name: "exec", toolCallId: id, args: { command } });
    if (state) emit("tool", { phase: "result", name: "exec", toolCallId: id, status: state });
  };
  progress.replyOptions.onAgentRunStart("own-run");
  return { progress, emit, tool, send, cancel, warn, abort, unsubscribe };
}
const texts = (send: ReturnType<typeof setup>["send"]) => send.mock.calls.map(([text]) => text);

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const progress of active.splice(0)) {
    await progress.cleanup();
    await progress.drain();
  }
  vi.useRealTimers();
});

describe("Knox notice language compatibility", () => {
  it.each([
    ["Run checks", false],
    ["漢字", false],
    ["가", true],
    ["ㄱ", true],
    ["가", true],
  ] as const)("retains the Hangul detector used by other channel notices: %s", (text, korean) => {
    expect(usesKnoxKoreanNotices(text)).toBe(korean);
  });
});

describe("Knox progress digest", () => {
  it.each(["Run checks", "검사해줘"])(
    "waits fifteen seconds and uses English for %s",
    async (text) => {
      const { progress, send } = setup({ text });
      progress.start();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(texts(send)).toEqual(["⏳ Processing request"]);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it("shows the current observed command on the first tick without inferring its purpose", async () => {
    const { progress, tool, send } = setup();
    progress.start();
    tool("a", "python audit.py");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual(["⏳ exec · python audit.py"]);
  });

  it("retains only the latest five completed invocations, in chronological order, plus current last", async () => {
    const { progress, tool, send } = setup();
    progress.start();
    for (let index = 0; index < 8; index++) tool(String(index), `cmd-${index}`, "completed");
    tool("active", "still-running");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual([
      [
        "✓ exec · cmd-3",
        "✓ exec · cmd-4",
        "✓ exec · cmd-5",
        "✓ exec · cmd-6",
        "✓ exec · cmd-7",
        "⏳ exec · still-running",
      ].join("\n"),
    ]);
    expect(send.mock.calls[0]![0]).not.toContain("cmd-2");
  });

  it("does not resend when five new identical rendered results replace five previous ones", async () => {
    const { progress, tool, send } = setup();
    progress.start();
    for (let index = 0; index < 5; index++) tool(String(index), "same", "completed");
    await vi.advanceTimersByTimeAsync(15_000);
    for (let index = 5; index < 10; index++) tool(String(index), "same", "completed");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].split("\n").slice(0, 5)).toEqual(Array(5).fill("✓ exec · same"));
  });

  it("merges embedded tool, item and command events using their shared call ID", async () => {
    const { progress, tool, emit, send } = setup();
    progress.start();
    tool("a", "git status", "completed");
    for (const kind of ["tool", "command"])
      emit("item", {
        phase: "end",
        kind,
        itemId: `${kind}:a`,
        toolCallId: "a",
        name: "exec",
        status: "completed",
      });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual(["✓ exec · git status\n⏳ Processing request"]);
  });

  it("keeps earlier parallel calls active when the newest call finishes", async () => {
    const { progress, tool, send } = setup();
    progress.start();
    tool("a", "one");
    tool("b", "two");
    tool("c", "three", "completed");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual(["✓ exec · three\n⏳ exec · two (+1 running)"]);
  });

  it.each([
    [{ status: "failed" }, "✗ exec · command"],
    [{ status: "cancelled", isError: true }, "– Cancelled exec · command"],
    [{ status: "unknown" }, "? Unknown exec · command"],
    [{ result: { details: { status: "running" } } }, "↗ Background started exec · command"],
    [
      { result: { details: { async: true, status: "started" } } },
      "↗ Background started exec · command",
    ],
  ])("distinguishes actual result facts %j", async (facts, expected) => {
    const { progress, tool, emit, send } = setup();
    progress.start();
    tool("a", "command");
    emit("tool", { phase: "result", name: "exec", toolCallId: "a", ...facts });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual([`${expected}\n⏳ Processing request`]);
  });

  it("does not turn approval-pending result plus item terminal into successful execution", async () => {
    const { progress, tool, emit, send } = setup();
    progress.start();
    tool("a", "command");
    emit("tool", {
      phase: "result",
      name: "exec",
      toolCallId: "a",
      result: { details: { status: "approval-pending" } },
    });
    emit("item", {
      phase: "end",
      kind: "command",
      toolCallId: "a",
      name: "exec",
      status: "blocked",
    });
    emit("approval", {
      phase: "requested",
      status: "pending",
      toolCallId: "a",
      approvalId: "approval-a",
      name: "exec",
    });
    tool("b", "parallel");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual(["? Awaiting approval exec · command (+1 running)"]);
    expect(send.mock.calls[0]![0]).not.toContain("✓");
  });

  it.each([
    ["approved", "✓ Approved exec"],
    ["denied", "– Denied exec"],
    ["unavailable", "? Approval unavailable exec"],
    ["failed", "? Approval unavailable exec"],
    ["other", "? Approval ended exec"],
  ])("resolves approval as %s without claiming execution resumed", async (status, expected) => {
    const { progress, tool, emit, send } = setup();
    progress.start();
    tool("a", "command");
    emit("approval", { status: "pending", toolCallId: "a", approvalId: "approval-a" });
    await vi.advanceTimersByTimeAsync(15_000);
    emit("approval", {
      phase: "resolved",
      status,
      toolCallId: "a",
      approvalId: "approval-a",
      name: "exec",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send).at(-1)).toBe(expected + " · command");
  });

  it("keeps sibling approvals pending and clears catch-path item-only resolutions", async () => {
    const { progress, tool, emit, send } = setup();
    progress.start();
    tool("a", "command");
    for (const approvalId of ["one", "two"])
      emit("approval", { status: "pending", toolCallId: "a", approvalId });
    emit("approval", { phase: "resolved", status: "approved", toolCallId: "a", approvalId: "two" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send).at(-1)).toBe("? Awaiting approval exec · command");
    emit("approval", { phase: "resolved", status: "unavailable", itemId: "a" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send).at(-1)).toBe("? Approval unavailable exec · command");
  });

  it("resets observations at attempt boundaries and ignores late old approvals", async () => {
    const { progress, tool, emit, send } = setup();
    progress.start();
    tool("a", "old", "completed");
    tool("waiting", "old-active");
    emit("approval", { status: "pending", toolCallId: "waiting", approvalId: "old" });
    await vi.advanceTimersByTimeAsync(15_000);
    emit("lifecycle", { phase: "finishing" });
    emit("lifecycle", { phase: "start" });
    emit("approval", { status: "pending", toolCallId: "waiting", approvalId: "old" });
    tool("new", "new-command");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send).at(-1)).toBe("⏳ exec · new-command");
  });

  it("scopes history to the adopted run rather than a shared session", async () => {
    const { progress, emit, tool, send } = setup();
    progress.start();
    tool("old", "old", "completed");
    progress.replyOptions.onAgentRunStart("new-run");
    emit("tool", { phase: "start", toolCallId: "outside", name: "PRIVATE" });
    emit(
      "tool",
      { phase: "start", toolCallId: "inside", name: "read", args: { path: "/private/file.md" } },
      "new-run",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual(["⏳ read · file.md"]);
  });

  it("omits hidden/suppressed items, model prose and raw tool output", async () => {
    const { progress, emit, send } = setup();
    progress.start();
    emit("tool", {
      phase: "start",
      toolCallId: "hidden",
      name: "PRIVATE",
      hideFromChannelProgress: true,
    });
    emit("item", {
      phase: "end",
      itemId: "suppressed",
      kind: "tool",
      name: "PRIVATE",
      status: "completed",
      suppressChannelProgress: true,
    });
    emit("item", {
      phase: "end",
      itemId: "analysis",
      kind: "analysis",
      name: "PRIVATE",
      status: "completed",
    });
    emit("assistant", { text: "PRIVATE" });
    emit("command_output", { toolCallId: "a", output: "PRIVATE" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(texts(send)).toEqual(["⏳ Processing request"]);
  });

  it("recalls the previous notice only after its replacement acknowledges", async () => {
    const { progress, tool, send, cancel } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    let acknowledge = () => {};
    send.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    tool("a", "new");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancel).not.toHaveBeenCalled();
    acknowledge();
    await progress.drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel.mock.calls).toEqual([[0]]);
    expect(send.mock.calls.map(([, ordinal]) => ordinal)).toEqual([0, 1]);
    await progress.cleanup();
    expect(cancel.mock.calls).toEqual([[0], [1]]);
  });

  it("stops at native completion without recalling before the final reply is confirmed", async () => {
    const { progress, emit, send, cancel, unsubscribe } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    emit("lifecycle", { phase: "end" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await progress.cleanup();
    expect(cancel).toHaveBeenCalledWith(0);
  });

  it("still cleans up on abort after a native terminal already stopped its timer", async () => {
    const { progress, emit, abort, cancel } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    emit("lifecycle", { phase: "end" });
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledWith(0);
  });

  it("disposes a failed final's observer without recalling its last acknowledged notice", async () => {
    const { progress, emit, abort, cancel, unsubscribe } = setup();
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    emit("lifecycle", { phase: "end" });
    progress.dispose();
    abort.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not hold final reply drain behind an old notice recall", async () => {
    let finishRecall = () => {};
    const { progress, tool, cancel } = setup({
      cancel: async () =>
        await new Promise<void>((resolve) => {
          finishRecall = resolve;
        }),
    });
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    tool("a", "new");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cancel).toHaveBeenCalledWith(0);
    await expect(progress.drain()).resolves.toBeUndefined();
    finishRecall();
    await vi.advanceTimersByTimeAsync(0);
    cancel.mockImplementation(async () => {});
  });

  it("freezes further digests if recall fails, then reports failure without rejecting cleanup", async () => {
    const { progress, tool, send, cancel, warn } = setup({
      cancel: async () => {
        throw new Error("CANCEL_UNKNOWN");
      },
    });
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    tool("a", "new");
    await vi.advanceTimersByTimeAsync(15_000);
    tool("b", "third");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    await expect(progress.cleanup()).resolves.toBeUndefined();
    expect(cancel.mock.calls.flat()).toContain(1);
  });

  it("cancels an uncertain in-flight ordinal on abort and suppresses future sends", async () => {
    const { progress, abort, send, cancel, warn } = setup({ pendingDelivery: true });
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    abort.abort();
    await progress.drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cancel).toHaveBeenCalledWith(0);
    expect(send).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps ambiguous failed delivery for cleanup and does not accumulate uncertain notices", async () => {
    const { progress, tool, send, cancel } = setup();
    send.mockRejectedValueOnce(new Error("DELIVERY_UNKNOWN"));
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    tool("a", "new");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(send).toHaveBeenCalledOnce();
    await progress.cleanup();
    expect(cancel).toHaveBeenCalledWith(0);
  });

  it("aborts an in-flight notice when a substantive reply arrives", async () => {
    const { progress, send, cancel } = setup({ pendingDelivery: true });
    progress.start();
    await vi.advanceTimersByTimeAsync(15_000);
    progress.visibleReply();
    await progress.drain();
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls[0]![2].aborted).toBe(true);
    expect(cancel).not.toHaveBeenCalled();
    await progress.cleanup();
    expect(cancel).toHaveBeenCalledWith(0);
  });

  it("honors source policy and restarts a deferred request's first delay at adoption", async () => {
    let allowed = false;
    const { progress, tool, send } = setup({ canSend: () => allowed });
    progress.start();
    tool("a", "old");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    progress.suspend();
    allowed = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    progress.replyOptions.onAgentRunStart("followup");
    progress.start();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(texts(send)).toEqual(["⏳ Processing request"]);
  });
});
