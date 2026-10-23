import { randomUUID } from "node:crypto";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { usesKnoxKoreanNotices } from "./progress.js";
import type { KnoxConversationType, KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

type KnoxOutboundStatus = "progress" | "final" | "error" | "timeout";

export type KnoxOutboundContext = {
  account: ResolvedKnoxAccount;
  inbound: KnoxInboundMessage;
  agentId: string;
  sessionKey: string;
  runId: string;
  executionTarget?: "platform_server" | "assigned_vm";
};

const MAX_RESPONSE_BYTES = 64 * 1024;
const RELAY_DEADLINE_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

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
  abortSignal?: AbortSignal;
}): Promise<string> {
  if (!params.text.trim()) {
    throw new KnoxOutboundError("Knox outbound text is empty", false);
  }
  const requestId = params.requestId?.trim() || randomUUID();
  const chatMsgId = randomUUID();
  const { account, inbound, agentId, sessionKey, runId } = params.context;
  const text = formatKnoxOutboundText(params.context, params.text);
  return await runKnoxRelayOperation({
    account,
    operation: "send",
    requestId,
    runId,
    fetchImpl: params.fetchImpl,
    abortSignal: params.abortSignal,
    body: {
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
      text,
      final: params.final,
      errorCode: params.status === "error" ? "AGENT_ERROR" : null,
      errorMessage: params.status === "error" ? text : null,
      senderDisplayName: inbound.conversation.type === "room" ? inbound.sender.displayName : null,
    },
  });
}

/** Recall by the original logical send key, including sends whose acknowledgement was lost. */
export async function cancelKnoxOutbound(params: {
  context: KnoxOutboundContext;
  targetRequestId: string;
  targetRunId?: string;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<void> {
  const { account, inbound, runId } = params.context;
  const requestId = `cancel:${params.targetRequestId}`;
  await runKnoxRelayOperation({
    account,
    operation: "cancel",
    requestId,
    runId,
    fetchImpl: params.fetchImpl,
    body: {
      requestId,
      runId,
      targetRequestId: params.targetRequestId,
      targetRunId: params.targetRunId ?? runId,
      chatroomId: inbound.conversation.conversationId,
      conversationType: inbound.conversation.type,
    },
  });
}

type RelayOperationParams = {
  account: ResolvedKnoxAccount;
  operation: "send" | "cancel";
  requestId: string;
  runId: string;
  body: Record<string, unknown>;
  fetchImpl?: typeof globalThis.fetch;
  abortSignal?: AbortSignal;
};

function relayEndpoint(outboundUrl: string, operation: "cancel" | "status"): URL {
  const url = new URL(outboundUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  if (!path.endsWith("/send")) {
    throw new KnoxOutboundError("Knox relay URL must end with /send", false);
  }
  url.pathname = `${path.slice(0, -4)}${operation}`;
  return url;
}

function unknownRelayResult(operation: "send" | "cancel", cause?: unknown): KnoxOutboundError {
  return new KnoxOutboundError(`Knox ${operation} result could not be confirmed`, false, {
    cause,
    errorCode: operation === "send" ? "DELIVERY_UNKNOWN" : "CANCEL_UNKNOWN",
  });
}

function relayFailure(response: Response, body?: Record<string, unknown>): KnoxOutboundError {
  const code = typeof body?.errorCode === "string" ? body.errorCode : undefined;
  const unknown = code === "DELIVERY_UNKNOWN" || code === "CANCEL_UNKNOWN";
  const retryable =
    !unknown &&
    body?.retryable !== false &&
    (body?.retryable === true || response.status === 429 || response.status >= 500);
  return new KnoxOutboundError(
    typeof body?.message === "string"
      ? body.message
      : `Knox relay rejected request (${response.status})`,
    retryable,
    { errorCode: code },
  );
}

function relayRetryDelay(response: Response, body?: Record<string, unknown>): number {
  if (
    typeof body?.retryAfterSeconds === "number" &&
    Number.isFinite(body.retryAfterSeconds) &&
    body.retryAfterSeconds >= 0
  ) {
    return Math.max(100, body.retryAfterSeconds * 1_000);
  }
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(100, seconds * 1_000);
    }
    const until = Date.parse(header);
    if (Number.isFinite(until)) {
      return Math.max(100, until - Date.now());
    }
  }
  return 1_000;
}

function runKnoxRelayOperation(
  params: RelayOperationParams & { operation: "send" },
): Promise<string>;
function runKnoxRelayOperation(
  params: RelayOperationParams & { operation: "cancel" },
): Promise<void>;
async function runKnoxRelayOperation(params: RelayOperationParams): Promise<string | void> {
  const deadline = Date.now() + RELAY_DEADLINE_MS;
  const expectedState = params.operation === "send" ? "sent" : "cancelled";
  const endpoint =
    params.operation === "send"
      ? params.account.outboundUrl
      : relayEndpoint(params.account.outboundUrl, "cancel");
  let lookup = false;
  let waitMs = 0;
  while (Date.now() < deadline) {
    if (params.abortSignal?.aborted) {
      throw new KnoxOutboundError("Knox outbound request was cancelled", false);
    }
    if (waitMs > 0) {
      if (Date.now() + waitMs >= deadline) {
        throw unknownRelayResult(params.operation);
      }
      try {
        await sleepWithAbort(waitMs, params.abortSignal);
      } catch (cause) {
        throw new KnoxOutboundError("Knox outbound request was cancelled", false, { cause });
      }
    }
    const url = lookup ? relayEndpoint(params.account.outboundUrl, "status") : endpoint;
    if (url instanceof URL && lookup) {
      url.searchParams.set("requestId", params.requestId);
      url.searchParams.set("runId", params.runId);
    }
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.min(HTTP_TIMEOUT_MS, deadline - Date.now())),
    );
    let response: Response;
    let body: Record<string, unknown> | undefined;
    try {
      response = await (params.fetchImpl ?? globalThis.fetch)(url, {
        method: lookup ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${params.account.serviceToken}`,
          "Content-Type": "application/json",
        },
        signal: params.abortSignal ? AbortSignal.any([params.abortSignal, timeout]) : timeout,
        ...(lookup ? {} : { body: JSON.stringify(params.body) }),
      });
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new Error("response_too_large");
      }
      const value: unknown = JSON.parse(await readBoundedResponse(response));
      body = isRecord(value) ? value : undefined;
    } catch (cause) {
      if (params.abortSignal?.aborted) {
        throw new KnoxOutboundError("Knox outbound request was cancelled", false, { cause });
      }
      // A lost acknowledgement must never cause another POST: Knox does not deduplicate msgId.
      waitMs = lookup ? 1_000 : 0;
      lookup = true;
      continue;
    }
    const duplicate = params.operation === "send" && body?.errorCode === "DUPLICATE_MESSAGE";
    const messageId =
      typeof body?.messageId === "string" && body.messageId.trim() ? body.messageId : undefined;
    const confirmedState = body?.state === expectedState;
    const legacySend = params.operation === "send" && !lookup && body?.state === undefined;
    if (
      response.status !== 202 &&
      (body?.ok === true || duplicate) &&
      (response.ok || duplicate) &&
      (confirmedState || legacySend) &&
      (params.operation === "cancel" || messageId)
    ) {
      return params.operation === "send" ? messageId : undefined;
    }
    if (lookup && response.status === 404) {
      throw unknownRelayResult(params.operation);
    }
    if (body?.state === "failed" || (body?.ok === false && !duplicate)) {
      throw relayFailure(response, body);
    }
    if (body?.state === "cancelled" && params.operation === "send") {
      throw new KnoxOutboundError("Knox delivery was cancelled", false, {
        errorCode: "DELIVERY_CANCELLED",
      });
    }
    if (response.status === 202 || (response.ok && body?.state === "pending")) {
      lookup = true;
      waitMs = relayRetryDelay(response, body);
      continue;
    }
    if (!response.ok && !duplicate) {
      throw response.status === 404
        ? unknownRelayResult(params.operation)
        : relayFailure(response, body);
    }
    if (lookup) {
      throw unknownRelayResult(params.operation);
    }
    lookup = true;
    waitMs = 0;
  }
  throw unknownRelayResult(params.operation);
}

function formatKnoxOutboundText(context: KnoxOutboundContext, text: string): string {
  if (context.inbound.conversation.type !== "dm" || !context.executionTarget) {
    return text;
  }
  const korean = usesKnoxKoreanNotices(context.inbound.message.text);
  const statusLine =
    context.executionTarget === "assigned_vm"
      ? korean
        ? "🟢 VM 사용 중"
        : "🟢 Using VM"
      : korean
        ? "🟠 PlatformClaw 서버 사용 중"
        : "🟠 Using PlatformClaw server";
  const lines = text.split(/\r\n|[\r\n]/u);
  let bodyStart = 0;
  while (lines[bodyStart]?.trim() === "") {
    bodyStart += 1;
  }
  if (lines[bodyStart] && isKnoxExecutionStatusLine(lines[bodyStart])) {
    do {
      bodyStart += 1;
      while (lines[bodyStart]?.trim() === "") {
        bodyStart += 1;
      }
    } while (lines[bodyStart] && isKnoxExecutionStatusLine(lines[bodyStart]));
  } else {
    // Preserve intentional leading whitespace when there was no generated indicator.
    bodyStart = 0;
  }
  const body = lines.slice(bodyStart).join("\n");
  if (!body) {
    return statusLine;
  }
  return `${statusLine}\n\n${body}`;
}

function isKnoxExecutionStatusLine(line: string | undefined): boolean {
  const normalized = line?.trim();
  return (
    normalized === "🟢 VM 사용 중" ||
    normalized === "🟠 PlatformClaw 서버 사용 중" ||
    normalized === "🟢 Using VM" ||
    normalized === "🟠 Using PlatformClaw server"
  );
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
  readonly errorCode?: string;

  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions & { errorCode?: string },
  ) {
    super(message, options);
    this.name = "KnoxOutboundError";
    this.errorCode = options?.errorCode;
  }
}
