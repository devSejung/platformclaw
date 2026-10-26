/** Shared sender identity helpers for authorization checks. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import type { MsgContext } from "./templating.js";

/** Personal commands carry a bounded Agent grant, never Gateway-owner authority. */
export function resolvePersonalAgentCommandScope(
  ctx: Pick<MsgContext, "Provider" | "SenderIsOwner" | "SenderAgentId" | "AgentId">,
): string | undefined {
  if (!isInternalMessageChannel(ctx.Provider) || ctx.SenderIsOwner !== false) {
    return undefined;
  }
  const senderAgentId = normalizeOptionalString(ctx.SenderAgentId);
  return senderAgentId && senderAgentId === normalizeOptionalString(ctx.AgentId)
    ? senderAgentId
    : undefined;
}

function isConversationLikeIdentity(value: string): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("chat_id:")) {
    return true;
  }
  return /(^|:)(channel|group|thread|topic|room|space|spaces):/.test(normalized);
}

export function shouldUseFromAsSenderFallback(params: {
  from?: string | null;
  chatType?: string | null;
}): boolean {
  const from = normalizeOptionalString(params.from) ?? "";
  if (!from) {
    return false;
  }
  const chatType = normalizeLowercaseStringOrEmpty(params.chatType);
  if (chatType && chatType !== "direct") {
    return false;
  }
  return !isConversationLikeIdentity(from);
}
