import { hasPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/channel-inbound";
import { KnoxRoutingClient } from "./routing-client.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

/** Preserve free-form answers; unwrap Knox transport decoration only for accepted choices. */
export function resolveKnoxPendingQuestionText(params: {
  sessionKey: string;
  text: string;
}): string | undefined {
  if (hasPendingAgentQuestionAnswer(params)) {
    return params.text;
  }
  // A mention can precede a multiline selection or keyed question record.
  // Keep every answer after it: a last-line fallback would silently drop choices.
  const candidate = /(?:^|\r?\n)[ \t]*@\S+[ \t]+([\s\S]+)$/u.exec(params.text)?.[1];
  return candidate &&
    hasPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: candidate })
    ? candidate
    : undefined;
}

/** Only answers accepted by a live question may bypass the ordinary conversation FIFO. */
export async function isKnoxPendingQuestionReply(params: {
  account: ResolvedKnoxAccount;
  message: KnoxInboundMessage;
}): Promise<boolean> {
  if (!hasPendingAgentQuestionAnswer()) {
    return false;
  }
  const routing = await new KnoxRoutingClient({
    url: params.account.controlPlaneUrl,
    token: params.account.serviceToken,
  }).resolve({
    accountId: params.account.accountId,
    conversationType: params.message.conversation.type,
    conversationId: params.message.conversation.conversationId,
    knoxUserId: params.message.sender.knoxUserId,
  });
  if (
    routing.status !== "resolved" ||
    (params.message.conversation.type === "dm" && !routing.senderLinked)
  ) {
    return false;
  }
  return (
    resolveKnoxPendingQuestionText({
      sessionKey: routing.sessionKey,
      text: params.message.message.text,
    }) !== undefined
  );
}
