import { emitAgentEvent } from "../infra/agent-events.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";

/** Retained approvals share one run-scoped phase and cancellation owner across hosts. */
export async function awaitExecApprovalInline<T>(
  context: {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    toolCallId?: string;
    signal?: AbortSignal;
  },
  approvalId: string,
  operation: () => Promise<T>,
): Promise<T> {
  context.signal?.throwIfAborted();
  const emitPhase = (phase: "waiting-approval" | "approval-resolved") => {
    if (context.runId) {
      emitAgentEvent({
        runId: context.runId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        stream: "lifecycle",
        data: { phase, approvalId, toolCallId: context.toolCallId },
      });
    }
  };
  emitPhase("waiting-approval");
  try {
    const decision = operation();
    return context.signal ? await abortable(context.signal, decision) : await decision;
  } finally {
    emitPhase("approval-resolved");
  }
}
