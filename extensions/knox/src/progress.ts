import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

type ProgressState =
  | "running"
  | "completed"
  | "failed"
  | "pending"
  | "approved"
  | "denied"
  | "unavailable"
  | "resolved";
type ToolState = { name?: string; state: ProgressState };
type AgentEvent = Parameters<Parameters<PluginRuntime["events"]["onAgentEvent"]>[0]>[0];

export function usesKnoxKoreanNotices(text: string): boolean {
  return /\p{Script=Hangul}/u.test(text);
}

function progressText(korean: boolean, tool?: ToolState): string {
  if (!tool) {
    return korean ? "요청을 처리 중입니다." : "Processing your request.";
  }
  const name = tool.name;
  const subject = name ? `${name} ` : "";
  const messages: Record<ProgressState, readonly [string, string]> = {
    running: [`${subject}호출 진행 중입니다.`, name ? `Calling ${name}.` : "Calling a tool."],
    completed: [
      `${subject}호출이 완료됐습니다.`,
      name ? `${name} call completed.` : "Tool call completed.",
    ],
    failed: [`${subject}호출이 실패했습니다.`, name ? `${name} call failed.` : "Tool call failed."],
    pending: [
      `${subject}승인 대기 중입니다.`,
      name ? `Awaiting approval for ${name}.` : "Awaiting approval.",
    ],
    approved: [
      `${subject}실행이 승인됐습니다.`,
      name ? `${name} execution approved.` : "Execution approved.",
    ],
    denied: [
      `${subject}실행이 거절됐습니다.`,
      name ? `${name} execution denied.` : "Execution denied.",
    ],
    unavailable: [
      `${subject}승인을 받을 수 없습니다.`,
      name ? `Approval unavailable for ${name}.` : "Approval unavailable.",
    ],
    resolved: [
      `${subject}승인 대기가 종료됐습니다.`,
      name ? `Approval wait ended for ${name}.` : "Approval wait ended.",
    ],
  };
  return messages[tool.state][korean ? 0 : 1];
}

/** Request-owned observation only: never expose command arguments, output, or model reasoning. */
export function createKnoxProgress(params: {
  /** Private executions expose only a generic state, never tool or approval identity. */
  privateExecution?: boolean;
  text: string;
  delayMs: number;
  abortSignal: AbortSignal;
  subscribe: PluginRuntime["events"]["onAgentEvent"];
  canSend: () => boolean;
  send: (text: string, ordinal: number, signal: AbortSignal) => Promise<void>;
  warn: (error: unknown) => void;
}) {
  const korean = usesKnoxKoreanNotices(params.text);
  const calls = new Map<string, ToolState>();
  const approvals = new Map<string, { callId?: string; tool: ToolState }>();
  let latest: ToolState | undefined;
  let runId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delivery: Promise<void> | undefined;
  let deliveryAbort: AbortController | undefined;
  let active = false;
  let stopped = false;
  let firstTick = true;
  let sent = false;
  let visibleReply = false;
  let ordinal = 0;
  let previousText = "";

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    active = false;
    clearTimer();
    deliveryAbort?.abort();
    calls.clear();
    approvals.clear();
    latest = undefined;
    unsubscribe();
    params.abortSignal.removeEventListener("abort", stop);
  };
  const note = (stream: string, data: Record<string, unknown>) => {
    // Native item records defer progress to normalized tool events; some tools
    // intentionally have no visible replacement (for example, message delivery).
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
    const name =
      typeof data.name === "string"
        ? data.name.replace(/[\p{C}\s]/gu, "").slice(0, 80)
        : calls.get(id ?? "")?.name;
    if (
      stream === "approval" ||
      (stream === "lifecycle" &&
        (data.phase === "waiting-approval" || data.phase === "approval-resolved"))
    ) {
      const approvalId = typeof data.approvalId === "string" ? data.approvalId : id;
      if (!approvalId) {
        return;
      }
      const matching = approvals.has(approvalId)
        ? ([approvalId, approvals.get(approvalId)!] as const)
        : typeof data.approvalId !== "string"
          ? [...approvals].find(([, value]) => id !== undefined && value.callId === id)
          : undefined;
      const pending = matching?.[1];
      const state =
        data.phase === "waiting-approval" || data.status === "pending"
          ? "pending"
          : data.status === "approved" || data.status === "denied" || data.status === "unavailable"
            ? data.status
            : data.status === "failed"
              ? "unavailable"
              : "resolved";
      const tool: ToolState = { name: name ?? pending?.tool.name, state };
      if (state === "pending") {
        approvals.set(approvalId, { callId: id, tool });
      } else {
        if (typeof data.approvalId === "string") {
          approvals.delete(matching?.[0] ?? approvalId);
        } else {
          // Failure notifications can omit the generated approval ID; retire that item's waits.
          for (const [key, value] of approvals) {
            if (key === approvalId || (id !== undefined && value.callId === id)) {
              approvals.delete(key);
            }
          }
        }
        // A call can start before approval. Resolution alone does not prove execution resumed.
        calls.delete(id ?? pending?.callId ?? "");
        latest = tool;
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
      calls.set(id, { name, state: "running" });
    } else if (data.phase === "result" || data.phase === "end") {
      if (data.status === "running" || data.status === "inProgress") {
        return;
      }
      calls.delete(id);
      latest = {
        name,
        state:
          data.isError === true ||
          ["failed", "error", "blocked", "declined"].includes(String(data.status))
            ? "failed"
            : "completed",
      };
    }
  };
  const unsubscribe = params.subscribe((event: AgentEvent) => {
    // Session keys can be shared by queued turns; only this request's actual run may update it.
    if (event.runId === runId) {
      if (event.stream === "lifecycle") {
        if (event.data.phase === "end" || event.data.phase === "error") {
          stop();
          return;
        }
        if (event.data.phase === "start" || event.data.phase === "finishing") {
          // Attempts share a run ID. Missing item terminals cannot keep a dead
          // attempt's tools or approvals visible while its fallback is running.
          calls.clear();
          approvals.clear();
          latest = undefined;
          if (previousText !== progressText(korean)) {
            deliveryAbort?.abort();
          }
        }
      }
      note(event.stream, event.data);
    }
  });
  const tick = () => {
    if (!active || stopped) {
      return;
    }
    timer = setTimeout(tick, 10_000);
    timer.unref?.();
    if (!params.canSend() || deliveryAbort || params.abortSignal.aborted) {
      return;
    }
    const pending = [...approvals.values()].at(-1)?.tool;
    const tool = pending ?? [...calls.values()].at(-1) ?? latest;
    // An actionable approval must not be concealed behind the generic first notice.
    const text = params.privateExecution
      ? pending
        ? korean
          ? "소유자 웹에서 확인이 필요합니다."
          : "Owner action is required in the web app."
        : progressText(korean)
      : progressText(korean, firstTick && !pending && !visibleReply ? undefined : tool);
    firstTick = false;
    if ((!tool && visibleReply) || text === previousText) {
      return;
    }
    previousText = text;
    const controller = new AbortController();
    deliveryAbort = controller;
    delivery = params
      .send(text, ordinal++, controller.signal)
      .then(() => {
        sent = true;
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          params.warn(error);
        }
      })
      .finally(() => {
        deliveryAbort = undefined;
      });
  };
  params.abortSignal.addEventListener("abort", stop, { once: true });
  if (params.abortSignal.aborted) {
    stop();
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
      calls.clear();
      approvals.clear();
      latest = undefined;
      runId = undefined;
      firstTick = true;
      previousText = "";
      visibleReply = false;
    },
    stop,
    async drain() {
      await delivery;
    },
    visibleReply() {
      visibleReply = true;
      // A real reply must not wait behind a slow best-effort status acknowledgement.
      deliveryAbort?.abort();
    },
    get sent() {
      return sent;
    },
    replyOptions: {
      onAgentRunStart: (id) => {
        if (stopped) {
          return;
        }
        if (runId !== id) {
          calls.clear();
          approvals.clear();
          latest = undefined;
          runId = id;
        }
      },
    } satisfies GetReplyOptions,
  };
}
