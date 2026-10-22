import { isContextOverflowError } from "../../agents/embedded-agent-helpers.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import { logVerbose } from "../../globals.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { recordAgentRunFailure } from "../../infra/agent-run-failure-diagnostics.js";
import { defaultRuntime } from "../../runtime.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";
import { buildControlUiAgentFailureText } from "./agent-runner-failure-copy.js";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import type { AgentFallbackCandidatesResult } from "./agent-runner-fallback-candidate.js";
import type {
  AgentFallbackCycleParams,
  AgentFallbackCycleResult,
} from "./agent-runner-fallback-cycle.types.js";
import { drainPendingToolTasks } from "./pending-tool-task-drain.js";
import {
  classifyProviderRequestError,
  PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE,
} from "./provider-request-error-classifier.js";
import {
  isReplyOperationRestartAbort,
  isReplyOperationUserAbort,
} from "./reply-operation-abort.js";

/** Settles abort, lifecycle, and terminal failure state after fallback execution. */
export async function settleAgentFallbackCycle(params: {
  cycle: AgentFallbackCycleParams;
  fallbackResult: AgentFallbackCandidatesResult;
}): Promise<AgentFallbackCycleResult> {
  const { cycle, fallbackResult } = params;
  const turn = cycle.turn;
  const runResult = fallbackResult.result;
  const fallbackProvider = fallbackResult.provider;
  const fallbackModel = fallbackResult.model;
  const fallbackExhausted = fallbackResult.outcome === "exhausted";
  const settledLifecycleTerminal =
    cycle.state.pendingLifecycleTerminal?.provider === fallbackProvider &&
    cycle.state.pendingLifecycleTerminal.model === fallbackModel
      ? cycle.state.pendingLifecycleTerminal.backstop
      : undefined;
  cycle.state.pendingLifecycleTerminal = undefined;
  if (isReplyOperationRestartAbort(turn.replyOperation)) {
    settledLifecycleTerminal?.emit("end", runResult);
    throw isAgentRunRestartAbortReason(cycle.runAbortSignal?.reason)
      ? cycle.runAbortSignal?.reason
      : createAgentRunRestartAbortError();
  }
  if (isReplyOperationUserAbort(turn.replyOperation)) {
    settledLifecycleTerminal?.emit("end", runResult);
    await drainPendingToolTasks({ tasks: turn.pendingToolTasks, onTimeout: logVerbose });
    return { kind: "final", payload: { text: SILENT_REPLY_TOKEN } };
  }
  cycle.commitTerminalOutcome();
  const fallbackAttempts = Array.isArray(fallbackResult.attempts)
    ? fallbackResult.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        error: attempt.error,
        reason: attempt.reason || undefined,
        status: typeof attempt.status === "number" ? attempt.status : undefined,
        code: attempt.code || undefined,
      }))
    : [];
  if (!fallbackExhausted) {
    await fallbackResult.settleSessionOverride();
  }
  const embeddedError = runResult.meta?.error;
  const deferredLifecycleError = settledLifecycleTerminal?.getDeferredError();
  const userFacingErrorPayload = runResult.payloads?.find(
    (payload) => payload.isError === true && typeof payload.text === "string",
  )?.text;
  const technicalError = deferredLifecycleError ?? embeddedError?.message ?? userFacingErrorPayload;
  const isFailure = fallbackExhausted || Boolean(deferredLifecycleError || embeddedError);
  let failureReport = runResult.payloads
    ?.map((payload) => getReplyPayloadMetadata(payload)?.agentRunFailureReport)
    .find((report) => report !== undefined);
  const terminalErrorMessage =
    cycle.shouldSurfaceToControlUi && isFailure
      ? (userFacingErrorPayload ??
        buildControlUiAgentFailureText(technicalError, cycle.runId, {
          replayPrevented: embeddedError?.fallbackSafe === false,
        }))
      : (deferredLifecycleError ??
        userFacingErrorPayload ??
        (embeddedError ? "Agent run failed" : undefined));
  if (isFailure) {
    const recordedReport = recordAgentRunFailure({
      runId: cycle.runId,
      sessionId: turn.followupRun.run.sessionId,
      sessionKey: turn.sessionKey,
      provider: fallbackProvider,
      model: fallbackModel,
      phase: "fallback-settlement",
      error: embeddedError ?? deferredLifecycleError ?? technicalError,
      details: {
        fallbackExhausted,
        fallbackAttemptCount: fallbackAttempts.length,
        deferredLifecycleError,
      },
    });
    failureReport ??= recordedReport;
    for (const payload of runResult.payloads ?? []) {
      if (payload.isError) {
        setReplyPayloadMetadata(payload, { agentRunFailureReport: failureReport });
      }
    }
  }
  const attachFailureReport = <T extends object>(payload: T): T =>
    failureReport
      ? setReplyPayloadMetadata(payload, { agentRunFailureReport: failureReport })
      : payload;
  const emitSettledLifecycleError = (error: Error, extraData?: Record<string, unknown>) => {
    const terminalData = { ...extraData, errorDetails: failureReport };
    if (settledLifecycleTerminal) {
      settledLifecycleTerminal.emit("error", error, terminalData);
      return;
    }
    emitAgentEvent({
      runId: cycle.runId,
      lifecycleGeneration: cycle.state.lifecycleGeneration,
      ...(turn.sessionKey ? { sessionKey: turn.sessionKey } : {}),
      stream: "lifecycle",
      data: { phase: "error", error: error.message, endedAt: Date.now(), ...terminalData },
    });
  };
  if (embeddedError && isContextOverflowError(embeddedError.message)) {
    emitSettledLifecycleError(new Error(terminalErrorMessage ?? "Agent run failed"));
    defaultRuntime.error(
      `Auto-compaction failed (${embeddedError.message}). Preserving existing session mapping for ${turn.sessionKey ?? turn.followupRun.run.sessionId}.`,
    );
    turn.replyOperation?.fail("run_failed", embeddedError);
    return {
      kind: "final",
      payload: attachFailureReport(
        markAgentRunFailureReplyPayload({
          text: buildContextOverflowRecoveryText({
            preserveSessionMapping: true,
            cfg: cycle.runtimeConfig,
            agentId: turn.followupRun.run.agentId,
            primaryProvider: turn.followupRun.run.provider,
            primaryModel: turn.followupRun.run.model,
            runtimeProvider: cycle.state.attemptedRuntimeProvider,
            runtimeModel: cycle.state.attemptedRuntimeModel,
            activeSessionEntry: turn.getActiveSessionEntry(),
          }),
        }),
      ),
    };
  }
  if (embeddedError?.kind === "role_ordering") {
    const providerRequestError = classifyProviderRequestError(embeddedError);
    const text = cycle.shouldSurfaceToControlUi
      ? buildControlUiAgentFailureText(embeddedError, cycle.runId, {
          replayPrevented: embeddedError.fallbackSafe === false,
        })
      : (providerRequestError?.userMessage ?? PROVIDER_CONVERSATION_STATE_ERROR_USER_MESSAGE);
    emitSettledLifecycleError(
      new Error(cycle.shouldSurfaceToControlUi ? text : terminalErrorMessage),
    );
    turn.replyOperation?.fail("run_failed", embeddedError);
    return {
      kind: "final",
      payload: attachFailureReport(markAgentRunFailureReplyPayload({ text })),
    };
  }
  const terminalMetadata = fallbackResult.terminal.metadata;
  let terminalRunFailed = false;
  if (fallbackExhausted) {
    const exhaustionError = new Error(
      terminalErrorMessage ?? "All model fallback candidates failed",
    );
    terminalRunFailed = true;
    if (cycle.modelPatch.captureFallbackFailure(fallbackAttempts) === undefined) {
      cycle.modelPatch.captureFailure(embeddedError ?? exhaustionError);
    }
    emitSettledLifecycleError(exhaustionError, {
      ...terminalMetadata,
      fallbackExhaustedFailure: true,
    });
    turn.replyOperation?.retainFailureUntilComplete();
    turn.replyOperation?.fail("run_failed", exhaustionError);
  } else if (deferredLifecycleError || embeddedError) {
    const terminalError = new Error(terminalErrorMessage ?? "Agent run failed");
    terminalRunFailed = true;
    cycle.modelPatch.captureFailure(embeddedError ?? terminalError);
    emitSettledLifecycleError(terminalError, terminalMetadata);
    turn.replyOperation?.retainFailureUntilComplete();
    turn.replyOperation?.fail("run_failed", terminalError);
  } else {
    settledLifecycleTerminal?.emit("end", runResult);
  }
  return {
    kind: "completed",
    runResult,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    fallbackAttempts,
    terminalRunFailed,
  };
}
