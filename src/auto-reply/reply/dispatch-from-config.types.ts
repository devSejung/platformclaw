import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.types.js";
// Shared type contracts for dispatch-from-config runtime execution.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { NoVisibleReplyReason } from "../reply-payload.js";
import type { FinalizedMsgContext } from "../templating.js";
import type { FormatAbortReplyText, TryFastAbortFromMessage } from "./abort.runtime-types.js";
import type { CommandSessionMetadataChange } from "./command-session-metadata.js";
import type { InternalGetReplyFromConfig, InternalGetReplyOptions } from "./get-reply.types.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

export type DispatchFromConfigResult = {
  queuedFinal: boolean;
  counts: Record<ReplyDispatchKind, number>;
  failedCounts?: Partial<Record<ReplyDispatchKind, number>>;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sendPolicyDenied?: boolean;
  observedReplyDelivery?: boolean;
  /** The source resolver completed without failure or handing its reply to another run. */
  sourceTurnCompleted?: true;
  /** Runner-owned failure survives payload filtering and intentional group silence. */
  sourceTurnFailure?: AgentRunTerminalOutcome;
  noVisibleReplyFallbackEligible?: boolean;
  /** Diagnosis only; source delivery policy still decides whether recovery may be sent. */
  noVisibleReplyReason?: NoVisibleReplyReason;
  noVisibleReplyFallbackDelivered?: boolean;
  beforeAgentRunBlocked?: boolean;
  sessionMetadataChanges?: CommandSessionMetadataChange[];
};

export type DispatchFromConfigParams = {
  ctx: FinalizedMsgContext;
  /** Full runtime config captured by the channel; reply resolution refreshes it per turn. */
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<InternalGetReplyOptions, "onBlockReply">;
  replyResolver?: InternalGetReplyFromConfig;
  onSessionMetadataChanges?: (changes: CommandSessionMetadataChange[]) => void;
  fastAbortResolver?: TryFastAbortFromMessage;
  formatAbortReplyTextResolver?: FormatAbortReplyText;
  /** Optional patch applied to the current runtime config before reply resolution. */
  configOverride?: OpenClawConfig;
  /**
   * Channel turns consume the Gateway's committed model-runtime owner even when the global
   * config snapshot is unavailable during startup or durable ingress replay.
   */
  usePublishedModelRuntime?: boolean;
};

export type DispatchReplyFromConfig = (
  params: DispatchFromConfigParams,
) => Promise<DispatchFromConfigResult>;
