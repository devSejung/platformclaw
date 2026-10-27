import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import { findTranscriptEvent } from "../../config/sessions/session-accessor.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";

type AgentRestartRecoveryChannelContext = {
  channel: string;
  currentChannelId: string;
  currentThreadTs?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  sameChannelThreadRequired: boolean;
  sourceTurnId: string;
};

/** Resolve only the private token durably owned by the admitted recovery cycle. */
export function resolveAgentRestartRecoveryExecutionIdentityAdmission(params: {
  collectionEnabled: boolean;
  isRestartRecoveryResumeRun: boolean;
  retryOnly?: boolean;
  runId: string;
  sessionEntry?: SessionEntry;
}) {
  if (!params.isRestartRecoveryResumeRun || !params.collectionEnabled) {
    return undefined;
  }
  if (params.retryOnly === undefined) {
    throw new Error("restart recovery execution identity admission mode is unavailable");
  }
  const stored = (params.sessionEntry as InternalSessionEntry | undefined)?.mainRestartRecovery
    ?.executionIdentity;
  if (!stored) {
    throw new Error("restart recovery execution identity token is unavailable");
  }
  const token = parseExecutionIdentityAdmissionToken(stored);
  if (!params.retryOnly && token.runId !== params.runId) {
    throw new Error("restart recovery execution identity token disagrees with the admitted run");
  }
  return { token, retryOnly: params.retryOnly };
}

/** Rehydrates durable channel authority only for the exact host-owned recovery run. */
export function resolveAgentRestartRecoveryChannelContext(params: {
  canUseInternalRuntimeHandoff: boolean;
  expectedExistingSessionId?: string;
  resolvedSessionId?: string;
  runId: string;
  sessionEntry?: SessionEntry;
}): AgentRestartRecoveryChannelContext | undefined {
  const expectedSessionId = normalizeOptionalString(params.expectedExistingSessionId);
  const authority = params.sessionEntry
    ? resolveRestartRecoveryChannelAuthority(params.sessionEntry)
    : undefined;
  if (
    !params.canUseInternalRuntimeHandoff ||
    !expectedSessionId ||
    expectedSessionId !== normalizeOptionalString(params.resolvedSessionId) ||
    expectedSessionId !== normalizeOptionalString(params.sessionEntry?.sessionId) ||
    !authority ||
    normalizeOptionalString(params.sessionEntry?.restartRecoveryDeliveryRunId) !== params.runId
  ) {
    return undefined;
  }
  return {
    channel: authority.deliveryContext.channel,
    currentChannelId: authority.deliveryContext.to,
    currentThreadTs:
      authority.deliveryContext.threadId != null
        ? String(authority.deliveryContext.threadId)
        : undefined,
    sourceTurnId: authority.sourceTurnId,
    requesterAccountId: normalizeOptionalString(
      params.sessionEntry?.restartRecoveryRequesterAccountId,
    ),
    requesterSenderId: normalizeOptionalString(
      params.sessionEntry?.restartRecoveryRequesterSenderId,
    ),
    sameChannelThreadRequired:
      params.sessionEntry?.restartRecoverySameChannelThreadRequired === true,
  };
}

/** Restores only the bounded Agent grant from the exact admitted source turn. */
export async function resolveAgentRestartRecoverySenderAgentId(params: {
  agentId: string;
  sessionEntry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<string | undefined> {
  const sourceRunId = normalizeOptionalString(
    params.sessionEntry.restartRecoveryDeliverySourceRunId,
  );
  if (!sourceRunId) {
    return undefined;
  }
  const sourceTurnKey = buildRunUserTurnIdempotencyKey(sourceRunId);
  const found = await findTranscriptEvent(
    {
      agentId: params.agentId,
      sessionEntry: params.sessionEntry,
      sessionId: params.sessionEntry.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    (event) => {
      const message = asOptionalRecord(asOptionalRecord(event)?.message);
      return message?.role === "user" && message.idempotencyKey === sourceTurnKey;
    },
  );
  const message = asOptionalRecord(asOptionalRecord(found?.event)?.message);
  const meta = asOptionalRecord(message?.["__openclaw"]);
  // This capability never restores global ownership or guesses from the latest user message.
  return meta?.senderIsOwner === false ? normalizeOptionalString(meta.senderAgentId) : undefined;
}
