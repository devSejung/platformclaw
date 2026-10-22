import { emitAgentEvent } from "../infra/agent-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { abortable } from "./embedded-agent-runner/run/abortable.js";

type ExecApprovalContext = {
  agentId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
};

/** Recheck the original request immediately before an approved execution can resume. */
export async function revalidateExecApproval(
  context: ExecApprovalContext,
  approvalId: string,
): Promise<void> {
  context.signal?.throwIfAborted();
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("after_tool_approval")) {
    await hookRunner.runAfterToolApproval(
      { approvalId, toolCallId: context.toolCallId },
      {
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        runId: context.runId,
        abortSignal: context.signal,
      },
    );
  }
  context.signal?.throwIfAborted();
}

/** Retained approvals share one run-scoped phase and cancellation owner across hosts. */
export async function awaitExecApprovalInline<T>(
  context: ExecApprovalContext,
  approvalId: string,
  operation: () => Promise<T>,
): Promise<T> {
  context.signal?.throwIfAborted();
  const approvalContext = {
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    runId: context.runId,
    toolCallId: context.toolCallId,
    signal: context.signal,
  };
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
    const resolved = context.signal ? await abortable(context.signal, decision) : await decision;
    context.signal?.throwIfAborted();
    await revalidateExecApproval(approvalContext, approvalId);
    context.signal?.throwIfAborted();
    return resolved;
  } finally {
    emitPhase("approval-resolved");
  }
}
