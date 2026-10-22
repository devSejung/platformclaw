// Centralizes user-facing failure copy for external agent runner errors.
import { buildAgentRunFailureReference } from "../../infra/agent-run-failure-diagnostics.js";
import { diagnosticErrorFailureKind } from "../../infra/diagnostic-error-metadata.js";
import { isTransientNetworkError } from "../../infra/retryable-network-errors.js";

export const GENERIC_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.";

export const HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT =
  "⚠️ Heartbeat check failed before it could produce an update. The main chat session remains available.";

/** Web chat is also used by people without access to the gateway or its logs. */
export function buildControlUiAgentFailureText(
  error: unknown,
  runId: string,
  options?: { replayPrevented?: boolean },
): string {
  const failureKind = diagnosticErrorFailureKind(error);
  const connectionInterrupted =
    failureKind === "connection_closed" ||
    failureKind === "connection_reset" ||
    (failureKind === undefined && isTransientNetworkError(error));
  const description = connectionInterrupted
    ? "The connection to the response service was interrupted, so I couldn't finish your reply."
    : failureKind === "timeout"
      ? "The response service took too long, so I couldn't finish your reply."
      : "I couldn't complete your reply because the response service encountered a problem.";
  const nextStep = options?.replayPrevented
    ? "Some actions may already have completed. Check their results before trying again."
    : "Please try again in a moment.";
  return `⚠️ ${description} ${nextStep}\nIf this keeps happening, share this reference with your administrator.\n${buildAgentRunFailureReference(runId)}`;
}

/** True when text is exactly the generic external run failure copy. */
function isGenericExternalRunFailureText(text: string | undefined): boolean {
  return text?.trim() === GENERIC_EXTERNAL_RUN_FAILURE_TEXT;
}

/** Replaces trailing generic failure text with heartbeat-specific copy. */
export function replaceGenericExternalRunFailureText(text: string): {
  text: string;
  replaced: boolean;
} {
  if (isGenericExternalRunFailureText(text)) {
    return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, replaced: true };
  }

  const genericStart = text.indexOf(GENERIC_EXTERNAL_RUN_FAILURE_TEXT);
  if (genericStart < 0) {
    return { text, replaced: false };
  }

  const trailing = text.slice(genericStart + GENERIC_EXTERNAL_RUN_FAILURE_TEXT.length).trim();
  if (trailing) {
    return { text, replaced: false };
  }

  const prefix = text.slice(0, genericStart).trimEnd();
  return {
    text: prefix
      ? `${prefix} ${HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT}`
      : HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT,
    replaced: true,
  };
}
