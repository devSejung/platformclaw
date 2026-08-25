import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";

const ASSISTANT_MEDIA_PATHS = new Set([
  "/__openclaw__/assistant-media",
  "/platformclaw/app/__openclaw__/assistant-media",
]);
const MANAGED_MEDIA_PATH_RE = /^\/api\/chat\/media\/outgoing\/([^/]+)\/([^/]+)\/full$/u;
const INBOUND_MEDIA_SOURCE_RE = /^media:\/\/inbound\/([^/?#\\]+)$/iu;
const FILE_MEDIA_SOURCE_RE = /^file:\/\/([^/]*)(\/[^?#]*)$/iu;
const TRANSCRIPT_MEDIA_BLOCK_TYPES = new Set(["image", "audio", "video", "file", "attachment"]);
const MEDIA_TICKET_SCOPE = "platformclaw-browser-media";
const MEDIA_TICKET_TTL_MS = 5 * 60_000;
const MAX_META_RESPONSE_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

const REQUEST_HEADER_ALLOWLIST = [
  "accept",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
] as const;
const RESPONSE_HEADER_ALLOWLIST = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "referrer-policy",
  "x-content-type-options",
] as const;

type BrowserMediaAccess = { binding: { agentId: string } };

export type PlatformClawBrowserMediaPolicy = {
  resolveAccess(this: void, token: string, touch?: boolean): Promise<BrowserMediaAccess>;
  request<T = unknown>(this: void, token: string, method: string, params?: unknown): Promise<T>;
};

type PlatformClawBrowserMediaRelayOptions = {
  gatewayOrigin: string;
  gatewayAuth: string;
  gatewayProxy: PlatformClawBrowserMediaPolicy;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type BrowserMediaTicketPayload = {
  scope: typeof MEDIA_TICKET_SCOPE;
  agentId: string;
  sessionKey: string;
  source: string;
  exp: number;
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isSafeAbsoluteMediaPath(value: string): boolean {
  return (
    (value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value)) &&
    !value.startsWith("//") &&
    !value.includes("\0") &&
    !value.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")
  );
}

function isAllowedTranscriptMediaSource(source: string): boolean {
  const inbound = INBOUND_MEDIA_SOURCE_RE.exec(source);
  if (inbound) {
    try {
      const fileName = decodeURIComponent(inbound[1] ?? "");
      return (
        fileName !== "." &&
        fileName !== ".." &&
        !fileName.includes("\0") &&
        !/[\\/]/u.test(fileName)
      );
    } catch {
      return false;
    }
  }

  const fileUrl = FILE_MEDIA_SOURCE_RE.exec(source);
  if (fileUrl) {
    if (fileUrl[1] && fileUrl[1].toLowerCase() !== "localhost") {
      return false;
    }
    try {
      return isSafeAbsoluteMediaPath(decodeURIComponent(fileUrl[2] ?? ""));
    } catch {
      return false;
    }
  }
  return isSafeAbsoluteMediaPath(source);
}

function matchesPublicTranscriptMedia(value: unknown, source: string): boolean {
  const record = asRecord(value);
  return (
    record !== null &&
    record.sensitive !== true &&
    record.sensitiveMedia !== true &&
    (record.path === source || record.url === source)
  );
}

function isSensitiveTranscriptMedia(value: unknown): boolean {
  const record = asRecord(value);
  return record?.sensitive === true || record?.sensitiveMedia === true;
}

function historyContainsOwnedMediaSource(result: unknown, source: string): boolean {
  const messages = asRecord(result)?.messages;
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((message) => {
    const record = asRecord(message);
    if (
      !record ||
      (record.role !== "user" && record.role !== "assistant") ||
      isSensitiveTranscriptMedia(record)
    ) {
      return false;
    }
    const envelope = asRecord(record["__openclaw"]);
    if (isSensitiveTranscriptMedia(envelope)) {
      return false;
    }
    const media = envelope?.media;
    if (
      Array.isArray(media) &&
      media.some((entry) => matchesPublicTranscriptMedia(entry, source))
    ) {
      return true;
    }
    if (record.role !== "assistant" || !Array.isArray(record.content)) {
      return false;
    }
    // Text and tool payloads are not attachment ownership. Only explicit
    // assistant media blocks may authorize their exact local path or URL.
    return record.content.some((entry) => {
      const block = asRecord(entry);
      if (
        !block ||
        typeof block.type !== "string" ||
        !TRANSCRIPT_MEDIA_BLOCK_TYPES.has(block.type) ||
        isSensitiveTranscriptMedia(block) ||
        isSensitiveTranscriptMedia(block.attachment) ||
        isSensitiveTranscriptMedia(block.source)
      ) {
        return false;
      }
      return (
        matchesPublicTranscriptMedia(block, source) ||
        matchesPublicTranscriptMedia(block.attachment, source) ||
        matchesPublicTranscriptMedia(block.source, source)
      );
    });
  });
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) {
    return "";
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function normalizeGatewayOrigin(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("PlatformClaw media Gateway origin must be an HTTP(S) origin");
  }
  return url.origin;
}

function decodeOwnedSessionKey(
  encodedSessionKey: string,
  agentId: string,
  resolveAgentIdFromSessionKey: (sessionKey: string) => string | null,
): string | null {
  try {
    const sessionKey = decodeURIComponent(encodedSessionKey);
    return resolveAgentIdFromSessionKey(sessionKey) === agentId ? sessionKey : null;
  } catch {
    return null;
  }
}

/** Strict same-origin bridge for transcript-owned browser media. */
export class PlatformClawBrowserMediaRelay {
  private readonly gatewayOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ticketKey: Buffer;

  constructor(private readonly options: PlatformClawBrowserMediaRelayOptions) {
    this.gatewayOrigin = normalizeGatewayOrigin(options.gatewayOrigin);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ticketKey = createHmac("sha256", options.gatewayAuth)
      .update("platformclaw-browser-media-v1")
      .digest();
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const managedMatch = MANAGED_MEDIA_PATH_RE.exec(requestUrl.pathname);
    const isAssistantMedia = ASSISTANT_MEDIA_PATHS.has(requestUrl.pathname);
    if (!managedMatch && !isAssistantMedia) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return true;
    }

    const token = readPlatformClawSessionCookie(req);
    if (!token) {
      sendJson(res, 401, { error: "active browser session required" });
      return true;
    }
    let access: BrowserMediaAccess;
    try {
      access = await this.options.gatewayProxy.resolveAccess(token, false);
    } catch {
      sendJson(res, 401, { error: "active browser session required" });
      return true;
    }

    if (managedMatch) {
      return this.handleManagedMedia(req, res, requestUrl, managedMatch, access);
    }
    return this.handleAssistantMedia(req, res, requestUrl, token, access);
  }

  private async handleManagedMedia(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
    match: RegExpExecArray,
    access: BrowserMediaAccess,
  ): Promise<true> {
    const sessionKey = decodeOwnedSessionKey(match[1] ?? "", access.binding.agentId, (value) =>
      this.options.resolveAgentIdFromSessionKey(value),
    );
    // Managed downloads must carry the exact short-lived capability minted by
    // artifacts.download; the browser cookie alone is never an upstream bearer.
    if (!sessionKey || !requestUrl.searchParams.get("mediaTicket")) {
      sendJson(res, 404, { error: "media not found" });
      return true;
    }
    await this.proxyBytes(req, res);
    return true;
  }

  private async handleAssistantMedia(
    req: IncomingMessage,
    res: ServerResponse,
    requestUrl: URL,
    token: string,
    access: BrowserMediaAccess,
  ): Promise<true> {
    const source = requestUrl.searchParams.get("source")?.trim() ?? "";
    const sessionKey = requestUrl.searchParams.get("sessionKey")?.trim() ?? "";
    if (
      !isAllowedTranscriptMediaSource(source) ||
      this.options.resolveAgentIdFromSessionKey(sessionKey) !== access.binding.agentId
    ) {
      sendJson(res, 404, { available: false, reason: "Attachment unavailable" });
      return true;
    }

    if (requestUrl.searchParams.get("meta") === "1") {
      return this.handleAssistantMediaMeta(res, token, access, sessionKey, source);
    }
    const ticket = this.verifyTicket(requestUrl.searchParams.get("mediaTicket"));
    if (
      !ticket ||
      ticket.agentId !== access.binding.agentId ||
      ticket.sessionKey !== sessionKey ||
      ticket.source !== source
    ) {
      sendJson(res, 404, { error: "media not found" });
      return true;
    }
    await this.proxyBytes(req, res, access.binding.agentId);
    return true;
  }

  private async handleAssistantMediaMeta(
    res: ServerResponse,
    token: string,
    access: BrowserMediaAccess,
    sessionKey: string,
    source: string,
  ): Promise<true> {
    let history: unknown;
    try {
      history = await this.options.gatewayProxy.request(token, "chat.history", {
        sessionKey,
        limit: 1000,
        maxChars: 500_000,
      });
    } catch {
      sendJson(res, 404, { available: false, reason: "Attachment unavailable" });
      return true;
    }
    if (!historyContainsOwnedMediaSource(history, source)) {
      sendJson(res, 404, { available: false, reason: "Attachment unavailable" });
      return true;
    }

    const upstreamUrl = new URL("/__openclaw__/assistant-media", this.gatewayOrigin);
    upstreamUrl.searchParams.set("source", source);
    upstreamUrl.searchParams.set("meta", "1");
    let upstream: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      upstream = await this.fetchImpl(upstreamUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.options.gatewayAuth}`,
          "X-OpenClaw-Agent-Id": access.binding.agentId,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      sendJson(res, 502, { available: false, reason: "Attachment unavailable" });
      return true;
    } finally {
      clearTimeout(timeout);
    }
    const contentLength = Number(upstream.headers.get("content-length") ?? "0");
    if (!upstream.ok || contentLength > MAX_META_RESPONSE_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      sendJson(res, 502, { available: false, reason: "Attachment unavailable" });
      return true;
    }
    const raw = await readResponseTextBounded(upstream, MAX_META_RESPONSE_BYTES);
    if (raw === null) {
      sendJson(res, 502, { available: false, reason: "Attachment unavailable" });
      return true;
    }
    let availability: Record<string, unknown> | null = null;
    try {
      availability = asRecord(JSON.parse(raw));
    } catch {
      // The private Gateway is trusted, but a malformed response must not escape the BFF.
    }
    if (!availability || availability.available !== true) {
      sendJson(res, 200, availability ?? { available: false, reason: "Attachment unavailable" });
      return true;
    }
    const exp = this.now() + MEDIA_TICKET_TTL_MS;
    sendJson(res, 200, {
      ...availability,
      mediaTicket: this.createTicket({
        scope: MEDIA_TICKET_SCOPE,
        agentId: access.binding.agentId,
        sessionKey,
        source,
        exp,
      }),
      mediaTicketExpiresAt: new Date(exp).toISOString(),
    });
    return true;
  }

  private createTicket(payload: BrowserMediaTicketPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.ticketKey).update(encoded).digest("base64url");
    return `v1.${encoded}.${signature}`;
  }

  private verifyTicket(ticket: string | null): BrowserMediaTicketPayload | null {
    const parts = ticket?.split(".");
    if (!parts || parts.length !== 3 || parts[0] !== "v1") {
      return null;
    }
    const encoded = parts[1] ?? "";
    const signature = parts[2] ?? "";
    const expected = createHmac("sha256", this.ticketKey).update(encoded).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      return null;
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return null;
    }
    try {
      const payload = asRecord(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      if (
        payload?.scope !== MEDIA_TICKET_SCOPE ||
        typeof payload.agentId !== "string" ||
        typeof payload.sessionKey !== "string" ||
        typeof payload.source !== "string" ||
        typeof payload.exp !== "number" ||
        !Number.isFinite(payload.exp) ||
        payload.exp < this.now()
      ) {
        return null;
      }
      return payload as BrowserMediaTicketPayload;
    } catch {
      return null;
    }
  }

  private async proxyBytes(
    req: IncomingMessage,
    res: ServerResponse,
    agentId?: string,
  ): Promise<void> {
    const assistantMedia = agentId !== undefined;
    const incomingUrl = new URL(req.url ?? "/", "http://localhost");
    const upstreamUrl = assistantMedia
      ? new URL("/__openclaw__/assistant-media", this.gatewayOrigin)
      : new URL(`${incomingUrl.pathname}${incomingUrl.search}`, this.gatewayOrigin);
    if (assistantMedia) {
      for (const name of ["source", "playback"]) {
        const value = incomingUrl.searchParams.get(name);
        if (value !== null) {
          upstreamUrl.searchParams.set(name, value);
        }
      }
    }
    const headers = new Headers();
    for (const name of REQUEST_HEADER_ALLOWLIST) {
      const value = req.headers[name];
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    if (assistantMedia) {
      headers.set("Authorization", `Bearer ${this.options.gatewayAuth}`);
      headers.set("X-OpenClaw-Agent-Id", agentId);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, UPSTREAM_TIMEOUT_MS);
    req.once("aborted", abort);
    const close = () => {
      if (!res.writableEnded) {
        abort();
      }
    };
    res.once("close", close);
    try {
      const upstream = await this.fetchImpl(upstreamUrl, {
        method: req.method,
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      res.statusCode = upstream.status;
      for (const name of RESPONSE_HEADER_ALLOWLIST) {
        const value = upstream.headers.get(name);
        if (value !== null) {
          res.setHeader(name, value);
        }
      }
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (req.method === "HEAD" || !upstream.body) {
        res.end();
        return;
      }
      for await (const chunk of upstream.body) {
        if (!res.write(Buffer.from(chunk)) && !res.writableEnded) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
          if (res.destroyed) {
            return;
          }
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        sendJson(res, 502, { error: "media gateway unavailable" });
      } else {
        res.destroy();
      }
    } finally {
      clearTimeout(timeout);
      req.off("aborted", abort);
      res.off("close", close);
    }
  }
}
