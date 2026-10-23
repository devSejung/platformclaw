import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  describeKnoxProgressCall,
  formatKnoxProgressCall,
  terminalKnoxProgressState,
  type KnoxProgressCall,
} from "./progress-format.js";

type AgentEvent = Parameters<Parameters<PluginRuntime["events"]["onAgentEvent"]>[0]>[0];

export function usesKnoxKoreanNotices(text: string): boolean {
  return /\p{Script=Hangul}/u.test(text);
}

/** Request-owned facts only. Display history is bounded; transport ordinals identify recalls. */
export function createKnoxProgress(params: {
  requestText: string;
  delayMs: number;
  abortSignal: AbortSignal;
  subscribe: PluginRuntime["events"]["onAgentEvent"];
  canSend: () => boolean;
  send: (text: string, ordinal: number, signal: AbortSignal) => Promise<void>;
  cancel: (ordinal: number) => Promise<void>;
  warn: (error: unknown) => void;
}) {
  const fallbackText = usesKnoxKoreanNotices(params.requestText)
    ? "⏳ 요청을 처리 중입니다."
    : "⏳ Processing request";
  const calls = new Map<string, KnoxProgressCall>();
  const history = new Map<string, KnoxProgressCall>();
  const finished = new Set<string>();
  const retiredCalls = new Set<string>();
  const approvals = new Map<string, { callId?: string; call: KnoxProgressCall }>();
  const retiredApprovals = new Set<string>();
  const notices = new Set<number>();
  const cancellations = new Map<number, Promise<void>>();
  let latestApproval: KnoxProgressCall | undefined;
  let runId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delivery: Promise<void> | undefined;
  let deliveryAbort: AbortController | undefined;
  let latestNotice: number | undefined;
  let recalling = false;
  let recallFailed = false;
  let active = false;
  let stopped = false;
  let sent = false;
  let ordinal = 0;
  let previousText = "";

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const resetFacts = () => {
    for (const key of approvals.keys()) {
      retiredApprovals.add(key);
    }
    for (const key of [...calls.keys(), ...finished]) {
      retiredCalls.add(key);
    }
    calls.clear();
    history.clear();
    finished.clear();
    approvals.clear();
    latestApproval = undefined;
  };
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    active = false;
    clearTimer();
    deliveryAbort?.abort();
    resetFacts();
    unsubscribe();
    // Abort can follow a native terminal event while final delivery is still pending.
    // Keep the abort cleanup listener until the owner explicitly settles cleanup.
  };
  const cancelNotice = (id: number): Promise<void> => {
    if (!notices.has(id)) {
      return Promise.resolve();
    }
    const current = cancellations.get(id);
    if (current) {
      return current;
    }
    const pending = Promise.resolve()
      .then(() => params.cancel(id))
      .then(() => {
        notices.delete(id);
      })
      .catch((error: unknown) => {
        recallFailed = true;
        params.warn(error);
      })
      .finally(() => {
        cancellations.delete(id);
      });
    cancellations.set(id, pending);
    return pending;
  };
  const cleanup = async () => {
    stop();
    params.abortSignal.removeEventListener("abort", onAbort);
    await Promise.all([...notices].map(cancelNotice));
  };
  const onAbort = () => {
    void cleanup();
  };

  const note = (stream: string, data: Record<string, unknown>) => {
    if (
      stopped ||
      data.hideFromChannelProgress === true ||
      (stream === "item" && data.suppressChannelProgress === true)
    ) {
      return;
    }
    const id =
      typeof data.toolCallId === "string"
        ? data.toolCallId
        : typeof data.itemId === "string"
          ? data.itemId
          : undefined;
    if (id && retiredCalls.has(id)) {
      return;
    }
    const previous = calls.get(id ?? "") ?? history.get(id ?? "");
    if (
      stream === "approval" ||
      (stream === "lifecycle" &&
        ["waiting-approval", "approval-resolved"].includes(String(data.phase)))
    ) {
      const approvalId = typeof data.approvalId === "string" ? data.approvalId : id;
      if (!approvalId || retiredApprovals.has(approvalId)) {
        return;
      }
      const matched = approvals.has(approvalId)
        ? ([approvalId, approvals.get(approvalId)!] as const)
        : typeof data.approvalId !== "string"
          ? [...approvals].find(([, value]) => id !== undefined && value.callId === id)
          : undefined;
      const state =
        data.phase === "waiting-approval" || data.status === "pending"
          ? "pending"
          : data.status === "approved" || data.status === "denied" || data.status === "unavailable"
            ? data.status
            : data.status === "failed"
              ? "unavailable"
              : "resolved";
      const call = {
        ...describeKnoxProgressCall(data, previous ?? matched?.[1].call),
        state,
      } satisfies KnoxProgressCall;
      if (state === "pending") {
        approvals.set(approvalId, { callId: id, call });
      } else {
        if (typeof data.approvalId === "string") {
          approvals.delete(matched?.[0] ?? approvalId);
        } else {
          for (const [key, value] of approvals) {
            if (key === approvalId || (id !== undefined && value.callId === id)) {
              approvals.delete(key);
            }
          }
        }
        calls.delete(id ?? matched?.[1].callId ?? "");
        latestApproval = call;
      }
      return;
    }
    if (
      !id ||
      (stream !== "tool" && stream !== "item") ||
      (stream === "item" && !["tool", "command", "search", "patch"].includes(String(data.kind)))
    ) {
      return;
    }
    if (data.phase === "start" || data.phase === "update") {
      if (!finished.has(id)) {
        calls.set(id, { ...describeKnoxProgressCall(data, previous), state: "running" });
      }
      latestApproval = undefined;
    } else if (data.phase === "result" || data.phase === "end") {
      // Embedded tools emit tool+item+command terminals for the same invocation.
      // Only the first canonical terminal counts; the richer tool result comes first.
      if (finished.has(id)) {
        return;
      }
      if (data.status === "running" || data.status === "inProgress") {
        return;
      }
      const call = {
        ...describeKnoxProgressCall(data, previous),
        state: terminalKnoxProgressState(data),
      };
      calls.delete(id);
      finished.add(id);
      if (call.state === "pending" || call.state === "unavailable") {
        calls.set(id, call);
        latestApproval = call;
        return;
      }
      history.set(id, call);
      if (history.size > 5) {
        history.delete(history.keys().next().value!);
      }
    }
  };
  const unsubscribe = params.subscribe((event: AgentEvent) => {
    if (event.runId !== runId) {
      return;
    }
    if (event.stream === "lifecycle") {
      if (event.data.phase === "end" || event.data.phase === "error") {
        stop();
        return;
      }
      if (event.data.phase === "start" || event.data.phase === "finishing") {
        resetFacts();
        // Attempts share the request's relay delivery; resetting observations
        // must not turn its pending acknowledgement into an ambiguous abort.
      }
    }
    note(event.stream, event.data);
  });

  const snapshot = () => {
    const pending = [...approvals.values()].at(-1)?.call;
    const pendingIds = new Set([...approvals.values()].map((approval) => approval.callId));
    const running = [...calls]
      .filter(([id, call]) => call.state === "running" && !pendingIds.has(id))
      .map(([, call]) => call);
    const current = pending ?? running.at(-1) ?? latestApproval;
    const extra = pending ? running.length : Math.max(0, running.length - 1);
    const suffix = extra ? ` (+${extra} running)` : "";
    const lines = [...history.values()].map((call) => formatKnoxProgressCall(call));
    if (current) {
      lines.push(formatKnoxProgressCall(current, suffix));
    }
    return lines.length > 0 ? lines.join("\n") : fallbackText;
  };
  const tick = () => {
    if (!active || stopped) {
      return;
    }
    timer = setTimeout(tick, 15_000);
    timer.unref?.();
    if (
      !params.canSend() ||
      deliveryAbort ||
      recalling ||
      recallFailed ||
      params.abortSignal.aborted
    ) {
      return;
    }
    const text = snapshot();
    if (text === previousText) {
      return;
    }
    previousText = text;
    const controller = new AbortController();
    deliveryAbort = controller;
    const id = ordinal++;
    notices.add(id);
    delivery = params
      .send(text, id, controller.signal)
      .then(() => {
        sent = true;
        const old = latestNotice;
        latestNotice = id;
        // Recall transport must not hold a substantive/final reply behind drain().
        // A failed recall freezes updates so a relay outage cannot accumulate digests.
        if (old !== undefined) {
          recalling = true;
          void cancelNotice(old).finally(() => {
            recalling = false;
          });
        }
      })
      .catch((error: unknown) => {
        // Transport abort cannot prove non-delivery. Only final acknowledgement
        // or request abort authorizes owner cleanup of the uncertain ordinal.
        recallFailed = true;
        if (!controller.signal.aborted) {
          params.warn(error);
        }
      })
      .finally(() => {
        deliveryAbort = undefined;
      });
  };
  params.abortSignal.addEventListener("abort", onAbort, { once: true });
  if (params.abortSignal.aborted) {
    onAbort();
  }
  return {
    start() {
      if (stopped || active) {
        return;
      }
      active = true;
      timer = setTimeout(tick, params.delayMs);
      timer.unref?.();
    },
    suspend() {
      active = false;
      clearTimer();
      deliveryAbort?.abort();
      resetFacts();
      runId = undefined;
      previousText = "";
    },
    stop,
    cleanup,
    dispose() {
      stop();
      // Failed/unknown final delivery must leave the last acknowledged guide visible.
      params.abortSignal.removeEventListener("abort", onAbort);
    },
    async drain() {
      await delivery;
    },
    visibleReply() {
      deliveryAbort?.abort();
    },
    get sent() {
      return sent;
    },
    replyOptions: {
      onAgentRunStart: (id) => {
        if (!stopped && runId !== id) {
          resetFacts();
          runId = id;
        }
      },
    } satisfies GetReplyOptions,
  };
}
