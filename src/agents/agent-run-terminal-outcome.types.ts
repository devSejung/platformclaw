import type { AgentRunTimeoutPhase } from "./run-timeout-attribution.js";

/** Wait status reported by agent run terminal wait paths. */
export type AgentRunWaitStatus = "ok" | "error" | "timeout";

/** Normalized terminal reason; runtime classification must cover every reason. */
export type AgentRunTerminalReason =
  | "completed"
  | "hard_timeout"
  | "timed_out"
  | "cancelled"
  | "aborted"
  | "blocked"
  | "abandoned"
  | "failed";

/** Reply-facing consumers need the outcome contract without runtime normalization policy. */
export type AgentRunTerminalOutcome = {
  reason: AgentRunTerminalReason;
  status: AgentRunWaitStatus;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  timeoutPhase?: AgentRunTimeoutPhase;
  providerStarted?: boolean;
  startedAt?: number;
  endedAt?: number;
};
