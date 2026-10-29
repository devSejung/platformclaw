import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  resolveUiSelectedSessionAgentId,
} from "../../lib/sessions/session-key.ts";
import {
  recordWebComposerDispatch,
  recordWebComposerRun,
} from "../../platformclaw/composer-predictions.ts";
import { buildChatApiAttachments } from "./attachment-api.ts";
import type { ChatState } from "./chat-history.ts";
import {
  isTerminalFailureChatSendAck,
  normalizeChatSendAck,
  type ChatSendAck,
} from "./chat-send-ack.ts";

export async function requestChatSend(
  state: ChatState,
  params: {
    message: string;
    attachments?: ChatAttachment[];
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    agentId?: string;
    queueMode?: QueueMode;
    replyToId?: string;
    expectedLeafEntryId?: string | null;
    requireExactLeaf?: boolean;
  },
): Promise<ChatSendAck> {
  const routing = resolveChatSendRouting(state, params);
  const sessionId = params.sessionId ?? routing.sessionId;
  const controlUiReconnectResume = Boolean(
    !params.requireExactLeaf && sessionId && state.reconnectResumeSessionId === sessionId,
  );
  const client = state.client!;
  const pending = client.request(
    "chat.send",
    {
      sessionKey: routing.sessionKey,
      ...(isUiGlobalSessionKey(routing.sessionKey) && routing.selectedAgentId
        ? { agentId: routing.selectedAgentId }
        : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(controlUiReconnectResume ? { __controlUiReconnectResume: true } : {}),
      message: params.message,
      deliver: false,
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      ...(params.requireExactLeaf
        ? { queueMode: "followup" }
        : params.queueMode
          ? { queueMode: params.queueMode }
          : {}),
      ...(params.expectedLeafEntryId !== undefined
        ? { expectedLeafEntryId: params.expectedLeafEntryId }
        : {}),
      ...(params.requireExactLeaf ? { requireExactLeaf: true } : {}),
      idempotencyKey: params.runId,
      attachments: buildChatApiAttachments(params.attachments),
    },
    {
      onSent: () => recordWebComposerDispatch(client, routing.sessionKey, params.runId),
    },
  );
  const payload = await pending;
  if (controlUiReconnectResume) {
    state.reconnectResumeSessionId = null;
  }
  const ack = normalizeChatSendAck(payload, params.runId);
  // ACKs can arrive after the run completes: adopt its ID without dispatching again.
  if (ack.runId !== params.runId && !isTerminalFailureChatSendAck(ack)) {
    recordWebComposerRun(client, routing.sessionKey, ack.runId);
  }
  return ack;
}

export function resolveDisplayedLeafEntryId(
  state: Pick<ChatState, "chatDisplayedLeafEntryId">,
): string | null | undefined {
  if (state.chatDisplayedLeafEntryId === null) {
    return null;
  }
  const leafEntryId = state.chatDisplayedLeafEntryId?.trim();
  return leafEntryId || undefined;
}

function resolveChatSendRouting(
  state: ChatState,
  params: {
    sessionKey?: string;
    agentId?: string;
  },
): { selectedAgentId?: string; sessionId?: string; sessionKey: string } {
  const sessionKey = params.sessionKey ?? state.sessionKey;
  const selectedAgentId = params.agentId
    ? normalizeAgentId(params.agentId)
    : resolveUiSelectedSessionAgentId(state);
  const currentSessionId = state.currentSessionId;
  const canReuseCurrentSessionId =
    sessionKey === state.sessionKey &&
    (!isUiGlobalSessionKey(sessionKey) ||
      (selectedAgentId !== undefined &&
        selectedAgentId === resolveUiSelectedSessionAgentId(state)));
  const sessionId =
    canReuseCurrentSessionId && typeof currentSessionId === "string" && currentSessionId.trim()
      ? currentSessionId.trim()
      : undefined;
  return {
    sessionKey,
    ...(selectedAgentId ? { selectedAgentId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}

export async function requestSkillWorkshopRevisionChatSend(
  state: ChatState,
  params: {
    proposalId: string;
    instructions: string;
    runId: string;
    sessionKey?: string;
    agentId?: string;
    targetAgentId?: string;
  },
): Promise<ChatSendAck> {
  if (
    !canCallGatewayMethod(
      {
        client: state.client,
        hello: state.hello,
        phase: state.connected ? "connected" : "offline",
      },
      "skills.proposals.requestRevision",
      "operator.admin",
    )
  ) {
    throw new Error("Skill Workshop revision requests require operator.admin access.");
  }
  const routing = resolveChatSendRouting(state, {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const client = state.client!;
  const pending = client.request(
    "skills.proposals.requestRevision",
    {
      ...(params.agentId ? { agentId: normalizeAgentId(params.agentId) } : {}),
      ...(routing.selectedAgentId ? { targetAgentId: routing.selectedAgentId } : {}),
      proposalId: params.proposalId,
      instructions: params.instructions,
      sessionKey: routing.sessionKey,
      ...(routing.sessionId ? { sessionId: routing.sessionId } : {}),
      idempotencyKey: params.runId,
    },
    {
      onSent: () => recordWebComposerDispatch(client, routing.sessionKey, params.runId),
    },
  );
  const ack = normalizeChatSendAck(await pending, params.runId);
  if (ack.runId !== params.runId && !isTerminalFailureChatSendAck(ack)) {
    recordWebComposerRun(client, routing.sessionKey, ack.runId);
  }
  return ack;
}
