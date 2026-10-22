import { hasOnlyAssistantReasoningContent } from "../../replay-turn-classification.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const INCOMPLETE_TURN_REASONS = {
  interrupted: "The reply was interrupted before it could finish.",
  output_limit: "The answer reached its length limit before it could finish.",
  unfinished_tools: "The assistant stopped after a step without completing its answer.",
  service_error: "The AI service returned an error before completing its answer.",
  missing_assistant: "The AI service did not return an answer.",
  reasoning_only: "The AI service finished processing but did not return an answer.",
  empty_response: "The AI service returned an empty answer.",
} as const;

/** Describe observed terminal facts without exposing provider errors or private reasoning. */
export function describeIncompleteTurnFailure(
  attempt: Pick<
    EmbeddedRunAttemptResult,
    "currentAttemptAssistant" | "lastAssistant" | "agentHarnessResultClassification"
  >,
  aborted: boolean,
) {
  const assistant = attempt.currentAttemptAssistant ?? attempt.lastAssistant;
  const reason = aborted
    ? "interrupted"
    : assistant?.stopReason === "error"
      ? "service_error"
      : assistant?.stopReason === "length"
        ? "output_limit"
        : assistant?.stopReason === "toolUse"
          ? "unfinished_tools"
          : !assistant
            ? "missing_assistant"
            : attempt.agentHarnessResultClassification === "reasoning-only" ||
                hasOnlyAssistantReasoningContent(assistant)
              ? "reasoning_only"
              : "empty_response";
  return { reason, message: INCOMPLETE_TURN_REASONS[reason] };
}
