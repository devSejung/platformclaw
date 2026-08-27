import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";

const CANVAS_CAPABILITY_PREFIX = "/__openclaw__/cap/";
const CANVAS_DOCUMENT_PREFIX = "/__openclaw__/canvas/documents/";
const CANVAS_OWNER_AGENT_HEADER = "x-openclaw-canvas-owner-agent-id";
const CANVAS_TICKET_SCOPE = "platformclaw-browser-canvas";
const CANVAS_TICKET_TTL_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
export const CANVAS_LEASE_EXPIRED_MESSAGE_TYPE = "openclaw:canvas-lease-expired";

const CANVAS_LEASE_EXPIRED_HTML = `<!doctype html><meta charset="utf-8"><script>parent.postMessage({type:${JSON.stringify(
  CANVAS_LEASE_EXPIRED_MESSAGE_TYPE,
)}},"*")</script>`;

const RESPONSE_HEADER_ALLOWLIST = [
  "cache-control",
  "content-length",
  "content-security-policy",
  "content-type",
] as const;

type BrowserCanvasAccess = { binding: { agentId: string } };

export type PlatformClawBrowserCanvasPolicy = {
  resolveAccess(this: void, token: string, touch?: boolean): Promise<BrowserCanvasAccess>;
};

type PlatformClawBrowserCanvasRelayOptions = {
  publicOrigin: string;
  gatewayOrigin: string;
  gatewayAuth: string;
  gatewayProxy: PlatformClawBrowserCanvasPolicy;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type CanvasTicketPayload = {
  scope: typeof CANVAS_TICKET_SCOPE;
  agentId: string;
  nonce: string;
  exp: number;
};

function normalizeOrigin(value: string, label: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) origin`);
  }
  return url.origin;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(JSON.stringify(body));
}

function sendExpiredLeaseSignal(req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.end(req.method === "HEAD" ? undefined : CANVAS_LEASE_EXPIRED_HTML);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Agent-bound Canvas capability and byte relay for employee browsers. */
export class PlatformClawBrowserCanvasRelay {
  private readonly publicOrigin: string;
  private readonly gatewayOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ticketKey: Buffer;

  constructor(private readonly options: PlatformClawBrowserCanvasRelayOptions) {
    this.publicOrigin = normalizeOrigin(options.publicOrigin, "PlatformClaw public origin");
    this.gatewayOrigin = normalizeOrigin(
      options.gatewayOrigin,
      "PlatformClaw Canvas Gateway origin",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.ticketKey = createHmac("sha256", options.gatewayAuth)
      .update("platformclaw-browser-canvas-v1")
      .digest();
  }

  issueSurface(access: BrowserCanvasAccess): {
    surface: "canvas";
    pluginSurfaceUrls: { canvas: string };
    expiresAtMs: number;
  } {
    const expiresAtMs = this.now() + CANVAS_TICKET_TTL_MS;
    const ticket = this.createTicket({
      scope: CANVAS_TICKET_SCOPE,
      agentId: access.binding.agentId,
      nonce: randomBytes(12).toString("base64url"),
      exp: expiresAtMs,
    });
    return {
      surface: "canvas",
      pluginSurfaceUrls: {
        canvas: new URL(`${CANVAS_CAPABILITY_PREFIX}${ticket}`, this.publicOrigin).toString(),
      },
      expiresAtMs,
    };
  }

  async refresh(token: string, params: unknown): Promise<unknown> {
    const input = asRecord(params);
    if (input?.surface !== "canvas") {
      throw new BrowserGatewayProxyError("invalid-params", "canvas surface required");
    }
    const access = await this.options.gatewayProxy.resolveAccess(token);
    const observedUrl = typeof input.observedUrl === "string" ? input.observedUrl.trim() : "";
    if (observedUrl) {
      let observedTicket: CanvasTicketPayload | null = null;
      try {
        const pathname = new URL(observedUrl, this.publicOrigin).pathname;
        if (pathname.startsWith(CANVAS_CAPABILITY_PREFIX)) {
          observedTicket = this.verifyTicket(
            pathname.slice(CANVAS_CAPABILITY_PREFIX.length).split("/", 1)[0] ?? null,
            true,
          );
        }
      } catch {
        // A malformed or foreign observed lease cannot authorize rotation.
      }
      if (!observedTicket || observedTicket.agentId !== access.binding.agentId) {
        throw new BrowserGatewayProxyError(
          "cross-agent-denied",
          "Canvas lease is not owned by this browser user",
        );
      }
    }
    return this.issueSurface(access);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (!requestUrl.pathname.startsWith(CANVAS_CAPABILITY_PREFIX)) {
      return false;
    }
    const remainder = requestUrl.pathname.slice(CANVAS_CAPABILITY_PREFIX.length);
    const slashIndex = remainder.indexOf("/");
    if (slashIndex <= 0) {
      sendJson(res, 404, { error: "Canvas document not found" });
      return true;
    }
    // Verify authenticity before browser identity, but defer expiry disclosure
    // until the active session proves it owns this agent-bound capability.
    const ticket = this.verifyTicket(remainder.slice(0, slashIndex), true);
    const canvasPath = remainder.slice(slashIndex);
    if (!ticket || !canvasPath.startsWith(CANVAS_DOCUMENT_PREFIX)) {
      sendJson(res, 404, { error: "Canvas document not found" });
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return true;
    }
    const browserToken = readPlatformClawSessionCookie(req);
    if (!browserToken) {
      sendJson(res, 401, { error: "active browser session required" });
      return true;
    }
    let access: BrowserCanvasAccess;
    try {
      access = await this.options.gatewayProxy.resolveAccess(browserToken, false);
    } catch {
      sendJson(res, 401, { error: "active browser session required" });
      return true;
    }
    if (access.binding.agentId !== ticket.agentId) {
      sendJson(res, 404, { error: "Canvas document not found" });
      return true;
    }
    if (ticket.exp < this.now()) {
      sendExpiredLeaseSignal(req, res);
      return true;
    }

    const upstreamUrl = new URL(`${canvasPath}${requestUrl.search}`, this.gatewayOrigin);
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
        headers: {
          Authorization: `Bearer ${this.options.gatewayAuth}`,
          [CANVAS_OWNER_AGENT_HEADER]: access.binding.agentId,
        },
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
        return true;
      }
      for await (const chunk of upstream.body) {
        if (!res.write(Buffer.from(chunk)) && !res.writableEnded) {
          await Promise.race([once(res, "drain"), once(res, "close")]);
          if (res.destroyed) {
            return true;
          }
        }
      }
      res.end();
    } catch {
      if (!res.headersSent) {
        sendJson(res, 502, { error: "Canvas gateway unavailable" });
      } else {
        res.destroy();
      }
    } finally {
      clearTimeout(timeout);
      req.off("aborted", abort);
      res.off("close", close);
    }
    return true;
  }

  private createTicket(payload: CanvasTicketPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.ticketKey).update(encoded).digest("base64url");
    return `v1.${encoded}.${signature}`;
  }

  private verifyTicket(ticket: string | null, allowExpired: boolean): CanvasTicketPayload | null {
    const parts = ticket?.split(".");
    if (!parts || parts.length !== 3 || parts[0] !== "v1") {
      return null;
    }
    const encoded = parts[1] ?? "";
    const expected = createHmac("sha256", this.ticketKey).update(encoded).digest();
    let received: Buffer;
    try {
      received = Buffer.from(parts[2] ?? "", "base64url");
    } catch {
      return null;
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return null;
    }
    try {
      const payload = asRecord(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      if (
        payload?.scope !== CANVAS_TICKET_SCOPE ||
        typeof payload.agentId !== "string" ||
        !payload.agentId ||
        typeof payload.nonce !== "string" ||
        !payload.nonce ||
        typeof payload.exp !== "number" ||
        !Number.isSafeInteger(payload.exp) ||
        (!allowExpired && payload.exp < this.now())
      ) {
        return null;
      }
      return payload as CanvasTicketPayload;
    } catch {
      return null;
    }
  }
}
