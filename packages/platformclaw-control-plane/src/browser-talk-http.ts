import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie } from "./browser-auth-http.js";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
} from "./browser-gateway-contracts.js";
import {
  PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH,
  PLATFORMCLAW_TALK_OFFER_PREFIX,
} from "./browser-gateway-talk-policy.js";
import { sendBrowserJson } from "./browser-http-shared.js";

const MAX_SDP_BYTES = 256 * 1024;
const OFFER_TIMEOUT_MS = 30_000;

type BrowserTalkOfferPolicy = {
  resolveAccess(token: string, touch?: boolean): Promise<BrowserGatewayAccess>;
  claimTalkOffer(access: BrowserGatewayAccess, ticket: string): { path: string; secret: string };
  assertTalkOfferActive(access: BrowserGatewayAccess, ticket: string): void;
};

type BrowserTalkRelayOptions = {
  publicOrigin: string;
  gatewayOrigin: string;
  gatewayProxy: BrowserTalkOfferPolicy;
  fetchImpl?: typeof fetch;
};

function origin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Talk relay requires an HTTP(S) origin");
  }
  return url.origin;
}

function readSdpRequest(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    const onError = (error: Error) => {
      cleanup();
      // Keep the HTTP response writable so oversized input has a visible error.
      req.resume();
      reject(error);
    };
    const onAbort = () => onError(new Error("Talk connection setup timed out or disconnected"));
    const onData = (raw: Buffer | string) => {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > MAX_SDP_BYTES) {
        onError(
          new BrowserGatewayProxyError("invalid-params", "Talk connection offer is too large"),
        );
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      if (!size) {
        reject(new BrowserGatewayProxyError("invalid-params", "Talk connection offer is empty"));
        return;
      }
      resolve(Buffer.concat(chunks));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readSdpResponse(response: Response): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Talk connection returned no answer");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_SDP_BYTES) {
        throw new Error("Talk connection answer is too large");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (!size) {
    throw new Error("Talk connection returned an empty answer");
  }
  return Buffer.concat(chunks);
}

/** Relays a single leased SDP exchange to the Gateway-owned browser transport. */
export class PlatformClawBrowserTalkRelay {
  private readonly publicOrigin: string;
  private readonly gatewayOrigin: string;

  constructor(private readonly options: BrowserTalkRelayOptions) {
    this.publicOrigin = origin(options.publicOrigin);
    this.gatewayOrigin = origin(options.gatewayOrigin);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", this.publicOrigin);
    if (!url.pathname.startsWith(PLATFORMCLAW_TALK_OFFER_PREFIX)) {
      return false;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const ticket = url.pathname.slice(PLATFORMCLAW_TALK_OFFER_PREFIX.length);
    if (!/^[a-f0-9-]{36}$/u.test(ticket) || url.search || req.method !== "POST") {
      sendBrowserJson(res, req.method === "POST" ? 404 : 405, {
        error: "Talk connection endpoint is unavailable",
      });
      return true;
    }
    if (req.headers.origin !== this.publicOrigin) {
      sendBrowserJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/sdp") {
      sendBrowserJson(res, 415, { error: "Talk connection requires application/sdp" });
      return true;
    }
    const token = readPlatformClawSessionCookie(req);
    if (!token) {
      sendBrowserJson(res, 401, { error: "active browser session required" });
      return true;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const abortResponse = () => {
      if (!res.writableEnded) {
        abort();
      }
    };
    const timeout = setTimeout(abort, OFFER_TIMEOUT_MS);
    timeout.unref?.();
    req.once("aborted", abort);
    res.once("close", abortResponse);
    try {
      await this.options.gatewayProxy.resolveAccess(token, false);
      const body = await readSdpRequest(req, controller.signal);
      const access = await this.options.gatewayProxy.resolveAccess(token, false);
      // The body read awaited arbitrary browser input. Revalidate authority and
      // consume the lease immediately before using the provider's one-shot token.
      const offer = this.options.gatewayProxy.claimTalkOffer(access, ticket);
      if (offer.path !== PLATFORMCLAW_TALK_GATEWAY_OFFER_PATH) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Talk offer target is invalid",
        );
      }
      const response = await (this.options.fetchImpl ?? fetch)(
        new URL(offer.path, this.gatewayOrigin),
        {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${offer.secret}`, "Content-Type": "application/sdp" },
          body: new Uint8Array(body),
        },
      );
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "application/sdp"
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("Talk connection setup was rejected; start a new voice session");
      }
      const answer = await readSdpResponse(response);
      const current = await this.options.gatewayProxy.resolveAccess(token, false);
      this.options.gatewayProxy.assertTalkOfferActive(current, ticket);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/sdp");
      res.end(answer);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const status =
          error instanceof BrowserGatewayProxyError
            ? error.code === "unauthenticated"
              ? 401
              : error.code === "invalid-params"
                ? 400
                : 403
            : 502;
        sendBrowserJson(res, status, {
          error:
            error instanceof BrowserGatewayProxyError
              ? error.message
              : "Talk connection failed; start a new voice session",
        });
      }
    } finally {
      clearTimeout(timeout);
      req.off("aborted", abort);
      res.off("close", abortResponse);
    }
    return true;
  }
}
