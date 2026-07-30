import { randomUUID } from "node:crypto";
import type { KnoxConversationType, KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

export type KnoxOutboundStatus = "progress" | "final" | "error" | "timeout";

export type KnoxOutboundContext = {
  account: ResolvedKnoxAccount;
  inbound: KnoxInboundMessage;
  agentId: string;
  sessionKey: string;
  runId: string;
};

const MAX_RESPONSE_BYTES = 64 * 1024;

export function buildKnoxTarget(type: KnoxConversationType, conversationId: string): string {
  return `${type}:${conversationId}`;
}

export function parseKnoxTarget(target: string): {
  type: KnoxConversationType;
  conversationId: string;
} | null {
  const match = /^(dm|room):(.+)$/u.exec(target.trim());
  return match?.[1] && match[2]
    ? { type: match[1] as KnoxConversationType, conversationId: match[2] }
    : null;
}

export async function sendKnoxOutbound(params: {
  context: KnoxOutboundContext;
  status: KnoxOutboundStatus;
  text: string;
  final: boolean;
  requestId?: string;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<string> {
  if (!params.text.trim()) {
    throw new KnoxOutboundError("Knox outbound text is empty", false);
  }
  const requestId = params.requestId?.trim() || randomUUID();
  const chatMsgId = randomUUID();
  const { account, inbound, agentId, sessionKey, runId } = params.context;
  let response: Response;
  try {
    response = await (params.fetchImpl ?? globalThis.fetch)(account.outboundUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${account.serviceToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        messageId: inbound.messageId,
        conversationId: inbound.conversation.conversationId,
        threadId: null,
        conversationType: inbound.conversation.type,
        agentId,
        sessionKey,
        runId,
        requestId,
        chatroomId: inbound.conversation.conversationId,
        chatMsgId,
        msgType: "text",
        status: params.status,
        text: params.text,
        final: params.final,
        errorCode: params.status === "error" ? "AGENT_ERROR" : null,
        errorMessage: params.status === "error" ? params.text : null,
        senderDisplayName: inbound.conversation.type === "room" ? inbound.sender.displayName : null,
      }),
    });
  } catch (error) {
    throw new KnoxOutboundError("CDEP outbound request failed", true, { cause: error });
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new KnoxOutboundError("CDEP outbound response exceeded size limit", true);
  }
  let responseText: string;
  try {
    responseText = await readBoundedResponse(response);
  } catch (error) {
    throw new KnoxOutboundError("CDEP outbound response exceeded size limit", true, {
      cause: error,
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(responseText);
  } catch {
    body = null;
  }
  const record =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  if (record?.errorCode === "DUPLICATE_MESSAGE") {
    return typeof record.messageId === "string" ? record.messageId : chatMsgId;
  }
  if (!response.ok || record?.ok === false) {
    const retryable =
      response.status === 429 || response.status >= 500 || record?.retryable === true;
    throw new KnoxOutboundError(
      typeof record?.message === "string"
        ? record.message
        : `CDEP outbound rejected request (${response.status})`,
      retryable,
    );
  }
  if (record?.ok !== true) {
    throw new KnoxOutboundError("CDEP outbound acknowledgement is invalid", true);
  }
  if (typeof record.messageId !== "string" || !record.messageId.trim()) {
    throw new KnoxOutboundError("CDEP outbound acknowledgement is missing messageId", true);
  }
  return record.messageId;
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export class KnoxOutboundError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "KnoxOutboundError";
  }
}
