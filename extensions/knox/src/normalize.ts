import type { KnoxInboundMessage } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return String(value);
    }
  }
  return undefined;
}

function identifier(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value && value === value.trim()) {
      return value;
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      return String(value);
    }
  }
  return undefined;
}

function strictIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value && value === value.trim() ? value : undefined;
}

function messageText(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  );
}

function isCanonicalUtcTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]00:00)$/u.exec(
    value,
  );
  if (!match) {
    return false;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return false;
  }
  const parsed = new Date(timestamp);
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() + 1 === Number(match[2]) &&
    parsed.getUTCDate() === Number(match[3]) &&
    parsed.getUTCHours() === Number(match[4]) &&
    parsed.getUTCMinutes() === Number(match[5]) &&
    parsed.getUTCSeconds() === Number(match[6])
  );
}

export function normalizeKnoxInbound(value: unknown): KnoxInboundMessage {
  const root = record(value);
  if (root?.schemaVersion !== undefined && root.schemaVersion !== 1 && root.schemaVersion !== 2) {
    throw new Error("Knox inbound schemaVersion is not supported");
  }
  const selfInSpace = root?.schemaVersion === 2;
  if (selfInSpace ? root.executionMode !== "self_in_space" : root && "executionMode" in root) {
    throw new Error("Knox inbound executionMode is invalid for schemaVersion");
  }
  const versioned = root?.schemaVersion === 1 || selfInSpace;
  const sender = record(root?.sender);
  const conversation = record(root?.conversation);
  const message = record(root?.message);
  const messageId = versioned
    ? strictIdentifier(root?.messageId)
    : identifier(root?.messageId, root?.msgId);
  const conversationId = versioned
    ? strictIdentifier(conversation?.conversationId)
    : identifier(conversation?.conversationId, root?.conversationId, root?.chatroomId);
  const knoxUserId = versioned
    ? strictIdentifier(sender?.knoxUserId)
    : identifier(sender?.knoxUserId, root?.knoxUserId);
  const displayName = versioned
    ? text(sender?.displayName)
    : (text(sender?.displayName, sender?.name, root?.senderName) ?? knoxUserId);
  const providerType = text(
    conversation?.providerType,
    ...(versioned ? [] : [root?.chatType]),
  )?.toUpperCase();
  const explicitType = text(conversation?.type)?.toLowerCase();
  const conversationType =
    explicitType === "dm" || providerType === "SINGLE"
      ? "dm"
      : explicitType === "room" || providerType === "GROUP"
        ? "room"
        : undefined;
  if (
    (explicitType === "dm" && providerType && providerType !== "SINGLE") ||
    (explicitType === "room" && providerType && providerType !== "GROUP")
  ) {
    throw new Error("Knox conversation type fields disagree");
  }
  if (versioned && (!providerType || !explicitType)) {
    throw new Error("Knox versioned conversation type fields are required");
  }
  if (
    versioned &&
    !(
      (explicitType === "dm" && providerType === "SINGLE") ||
      (explicitType === "room" && providerType === "GROUP")
    )
  ) {
    throw new Error("Knox versioned conversation type fields are invalid");
  }
  if (selfInSpace && (conversation?.type !== "room" || conversation.providerType !== "GROUP")) {
    throw new Error("Knox self_in_space requires room/GROUP conversation type fields");
  }
  const body = versioned
    ? messageText(message?.text)
    : messageText(message?.text, root?.text, root?.chatMsg);
  const messageType =
    text(message?.type, ...(versioned ? [] : [root?.msgType]))?.toLowerCase() ??
    (versioned ? undefined : "text");
  const eventId =
    (versioned ? strictIdentifier(root?.eventId) : identifier(root?.eventId)) ??
    (!versioned && conversationId && messageId ? `${conversationId}:${messageId}` : undefined);
  const sentTime = typeof root?.sentTime === "number" ? root.sentTime : undefined;
  const occurredAt =
    (versioned
      ? typeof root?.occurredAt === "string"
        ? root.occurredAt
        : undefined
      : text(root?.occurredAt)) ??
    (!versioned && sentTime !== undefined && Number.isFinite(sentTime)
      ? new Date(sentTime).toISOString()
      : undefined);

  if (
    !messageId ||
    !conversationId ||
    !knoxUserId ||
    !displayName ||
    !conversationType ||
    !eventId ||
    !occurredAt ||
    !body
  ) {
    throw new Error("Knox inbound payload is missing required fields");
  }
  if (messageType !== "text") {
    throw new Error(`Knox message type is not supported: ${messageType}`);
  }
  if (selfInSpace && messageId.length > 256) {
    throw new Error("Knox v2 messageId must not exceed 256 UTF-16 code units");
  }
  if (versioned && !isCanonicalUtcTimestamp(occurredAt)) {
    throw new Error("Knox occurredAt must be an ISO 8601 UTC timestamp");
  }
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Knox occurredAt must be an ISO timestamp");
  }
  const normalized = {
    eventId,
    messageId,
    occurredAt: versioned ? occurredAt : new Date(timestamp).toISOString(),
    sender: { knoxUserId, displayName },
    message: { type: "text" as const, text: body },
  };
  const conversationFields = {
    conversationId,
    ...(text(conversation?.displayName) ? { displayName: text(conversation?.displayName) } : {}),
  };
  if (selfInSpace) {
    return {
      ...normalized,
      schemaVersion: 2,
      executionMode: "self_in_space",
      conversation: { ...conversationFields, type: "room", providerType: "GROUP" },
    };
  }
  return {
    ...normalized,
    schemaVersion: 1,
    conversation: {
      ...conversationFields,
      type: conversationType,
      providerType: conversationType === "dm" ? "SINGLE" : "GROUP",
    },
  };
}
