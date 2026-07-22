import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ConnectParams,
  type ErrorShape,
  type EventFrame,
  type RequestFrame,
  type ResponseFrame,
  validateConnectParams,
  validateRequestFrame,
} from "@openclaw/gateway-protocol";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  handlePlatformClawBrowserAuthRequest,
  readPlatformClawSessionCookie,
  type BrowserLoginRateLimiter,
  type JsonBodyReader,
} from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { projectPlatformClawBrowserHello } from "./browser-gateway-hello.js";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
  type BrowserGatewayEvent,
} from "./browser-gateway-proxy.js";
import type { PlatformClawGatewayBackend } from "./gateway-runtime-client.js";
import type { PlatformClawWebAssetHandler } from "./web-assets.js";
import { isPlatformClawApplicationPath, PLATFORMCLAW_WEB_LOGIN_PATH } from "./web-assets.js";

export const PLATFORMCLAW_GATEWAY_PATH = "/platformclaw/gateway";
export const PLATFORMCLAW_HEALTH_PATH = "/platformclaw/health";

const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_BROWSER_REQUESTS = 8;
// The upstream Control UI opens a burst of independent RPCs after connect. Keep enough
// headroom for that supported client while bounding work retained by an untrusted browser.
const MAX_PENDING_BROWSER_REQUESTS = 64;
const MUTATING_BROWSER_METHODS = new Set([
  "agents.files.set",
  "chat.abort",
  "chat.send",
  "sessions.abort",
  "sessions.create",
  "sessions.patch",
]);

export type PlatformClawBrowserGatewayPolicy = {
  resolveAccess(token: string, touch?: boolean): Promise<BrowserGatewayAccess>;
  request(token: string, method: string, params?: unknown): Promise<unknown>;
  filterEvent(token: string, event: BrowserGatewayEvent): Promise<BrowserGatewayEvent | null>;
};

export type PlatformClawWebIngressOptions = {
  publicOrigin: string;
  authService: BrowserAuthService;
  loginRateLimiter: BrowserLoginRateLimiter;
  gatewayProxy: PlatformClawBrowserGatewayPolicy;
  gateway: PlatformClawGatewayBackend;
  webAssets?: PlatformClawWebAssetHandler;
  gatewayPath?: string;
  healthPath?: string;
  maxPayloadBytes?: number;
  resolveClientIp?: (req: IncomingMessage) => string | undefined;
};

export type PlatformClawWebIngressListenOptions = {
  host: string;
  port: number;
};

function normalizePublicOrigin(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PlatformClaw public origin must use http or https");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "PlatformClaw public origin must not include credentials, path, query, or hash",
    );
  }
  return parsed.origin;
}

const readJsonBody: JsonBodyReader = async (req, maxBytes) => {
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > maxBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) {
    return { ok: false, error: "request body too large" };
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, error: "invalid JSON body" };
  }
};

function requestOrigin(req: IncomingMessage): string | undefined {
  const value = req.headers.origin;
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, statusCode: number, statusText: string): void {
  if (!socket.destroyed) {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function proxyErrorShape(error: unknown): ErrorShape {
  if (!(error instanceof BrowserGatewayProxyError)) {
    return { code: "UNAVAILABLE", message: "Gateway request failed", retryable: true };
  }
  switch (error.code) {
    case "unauthenticated":
      return { code: "UNAUTHENTICATED", message: error.message };
    case "agent-unavailable":
      return { code: "UNAVAILABLE", message: error.message, retryable: true };
    case "invalid-params":
      return { code: "INVALID_REQUEST", message: error.message };
    case "method-not-allowed":
    case "cross-agent-denied":
    case "upstream-result-denied":
      return { code: "FORBIDDEN", message: error.message };
  }
  return { code: "UNAVAILABLE", message: "Gateway request failed", retryable: true };
}

function decodeTextFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.concat(data).toString("utf8");
}

function rawDataByteLength(data: RawData): number {
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return data.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function responseError(id: string, error: unknown): ResponseFrame {
  return { type: "res", id, ok: false, error: proxyErrorShape(error) };
}

function responseOk(id: string, payload: unknown): ResponseFrame {
  return { type: "res", id, ok: true, payload };
}

function isProtocolCompatible(params: ConnectParams): boolean {
  return (
    params.minProtocol <= PROTOCOL_VERSION && params.maxProtocol >= MIN_CLIENT_PROTOCOL_VERSION
  );
}

export class PlatformClawWebIngressServer {
  private readonly publicOrigin: string;
  private readonly gatewayPath: string;
  private readonly healthPath: string;
  private readonly websocketServer: WebSocketServer;
  private readonly httpServer = createServer((req, res) => {
    void this.handleHttpRequest(req, res);
  });
  private started = false;
  private unsubscribeGatewayDisconnect = () => {};

  constructor(private readonly options: PlatformClawWebIngressOptions) {
    this.publicOrigin = normalizePublicOrigin(options.publicOrigin);
    this.gatewayPath = options.gatewayPath ?? PLATFORMCLAW_GATEWAY_PATH;
    this.healthPath = options.healthPath ?? PLATFORMCLAW_HEALTH_PATH;
    this.websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
    this.httpServer.on("upgrade", (req, socket, head) => {
      void this.handleUpgrade(req, socket, head).catch(() => {
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
    });
  }

  async listen(options: PlatformClawWebIngressListenOptions): Promise<void> {
    if (this.started) {
      throw new Error("PlatformClaw web ingress is already listening");
    }
    this.started = true;
    this.unsubscribeGatewayDisconnect = this.options.gateway.subscribeDisconnect(() => {
      for (const socket of this.websocketServer.clients) {
        socket.close(1012, "private Gateway disconnected");
      }
    });
    try {
      this.options.gateway.start();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          this.httpServer.off("error", onError);
          resolve();
        };
        this.httpServer.once("error", onError);
        this.httpServer.once("listening", onListening);
        this.httpServer.listen(options.port, options.host);
      });
    } catch (error) {
      this.started = false;
      this.unsubscribeGatewayDisconnect();
      this.unsubscribeGatewayDisconnect = () => {};
      this.options.gateway.stop();
      throw error;
    }
  }

  address(): ReturnType<typeof this.httpServer.address> {
    return this.httpServer.address();
  }

  async close(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.unsubscribeGatewayDisconnect();
    this.unsubscribeGatewayDisconnect = () => {};
    for (const socket of this.websocketServer.clients) {
      socket.close(1001, "PlatformClaw web ingress stopping");
    }
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    this.options.gateway.stop();
  }

  private isOriginAllowed(req: IncomingMessage): boolean {
    const origin = requestOrigin(req);
    if (!origin) {
      return false;
    }
    try {
      return new URL(origin).origin === this.publicOrigin;
    } catch {
      return false;
    }
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const handled = await handlePlatformClawBrowserAuthRequest(req, res, {
        service: this.options.authService,
        readJsonBody,
        clientIp: this.options.resolveClientIp?.(req) ?? req.socket.remoteAddress,
        gatewayUrl: this.browserGatewayUrl(),
        requestIsSecure: this.publicOrigin.startsWith("https://"),
        isMutationOriginAllowed: (request) => this.isOriginAllowed(request),
        rateLimiter: this.options.loginRateLimiter,
      });
      if (handled) {
        return;
      }
      const requestUrl = new URL(req.url ?? "/", this.publicOrigin);
      if (this.options.webAssets && isPlatformClawApplicationPath(requestUrl.pathname)) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          if (await this.options.webAssets.handleApplication(req, res)) {
            return;
          }
        }
        const token = readPlatformClawSessionCookie(req);
        const authentication = token
          ? await this.options.authService.authenticateToken(token)
          : undefined;
        if (authentication?.status !== "active") {
          const returnTo = `${requestUrl.pathname}${requestUrl.search}`;
          res.statusCode = 302;
          res.setHeader(
            "Location",
            `${PLATFORMCLAW_WEB_LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
          );
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Referrer-Policy", "no-referrer");
          res.end();
          return;
        }
        // Mounted public files such as sw.js share the authenticated application
        // prefix and must be resolved before the SPA document fallback.
        if (
          (await this.options.webAssets.handlePublic(req, res)) ||
          (await this.options.webAssets.handleApplication(req, res))
        ) {
          return;
        }
      }
      if (this.options.webAssets && (await this.options.webAssets.handlePublic(req, res))) {
        return;
      }
      const pathname = requestUrl.pathname;
      if (pathname === this.healthPath && (req.method === "GET" || req.method === "HEAD")) {
        const ready = this.options.gateway.getHello() !== null;
        sendJson(res, ready ? 200 : 503, req.method === "HEAD" ? undefined : { ready });
        return;
      }
      sendJson(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal server error" });
      } else {
        res.destroy();
      }
    }
  }

  private browserGatewayUrl(): string {
    const url = new URL(this.gatewayPath, this.publicOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const pathname = new URL(req.url ?? "/", this.publicOrigin).pathname;
    if (pathname !== this.gatewayPath) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.isOriginAllowed(req)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const token = readPlatformClawSessionCookie(req);
    if (!token) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (!this.options.gateway.getHello()) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    try {
      await this.options.gatewayProxy.resolveAccess(token, false);
    } catch {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    this.websocketServer.handleUpgrade(req, socket, head, (websocket) => {
      this.attachBrowserConnection(websocket, token);
    });
  }

  private attachBrowserConnection(websocket: WebSocket, token: string): void {
    const connectionId = `platformclaw-${randomUUID()}`;
    let connected = false;
    let connectionClosed = false;
    let eventSeq = 0;
    let unsubscribe = () => {};
    let handshakeChain = Promise.resolve();
    let handshakePendingCount = 0;
    let pendingRequestCount = 0;
    let pendingRequestBytes = 0;
    let activeRequestCount = 0;
    const maxPendingRequestBytes = 2 * (this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES);
    const requestQueue: Array<{ handle: () => Promise<void>; byteLength: number }> = [];
    let mutationBarrier = Promise.resolve();
    let eventChain = Promise.resolve();

    const send = (frame: unknown): void => {
      if (websocket.readyState !== WebSocket.OPEN) {
        return;
      }
      const maxBufferedBytes = this.options.gateway.getHello()?.policy.maxBufferedBytes ?? 0;
      if (maxBufferedBytes > 0 && websocket.bufferedAmount > maxBufferedBytes) {
        websocket.close(1013, "browser connection is too slow");
        return;
      }
      websocket.send(JSON.stringify(frame));
    };

    const closeUnauthorized = () => websocket.close(1008, "browser session is not active");
    const handshakeTimer = setTimeout(() => {
      if (!connected) {
        websocket.close(1008, "connect handshake timed out");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: randomUUID(), ts: Date.now() },
    } satisfies EventFrame);

    const forwardEvent = async (event: EventFrame): Promise<void> => {
      if (!connected) {
        return;
      }
      try {
        await this.options.gatewayProxy.resolveAccess(token, false);
      } catch {
        closeUnauthorized();
        return;
      }
      const filtered = await this.options.gatewayProxy.filterEvent(token, event);
      if (!filtered) {
        return;
      }
      eventSeq += 1;
      send({
        type: "event",
        event: filtered.event,
        ...(filtered.payload === undefined ? {} : { payload: filtered.payload }),
        seq: eventSeq,
      } satisfies EventFrame);
    };

    const handleConnect = async (frame: RequestFrame): Promise<void> => {
      if (frame.method !== "connect" || !validateConnectParams(frame.params)) {
        send(
          responseError(
            frame.id,
            new BrowserGatewayProxyError("invalid-params", "invalid connect request"),
          ),
        );
        websocket.close(1008, "invalid connect request");
        return;
      }
      const params = frame.params as ConnectParams;
      if (!isProtocolCompatible(params)) {
        send(
          responseError(
            frame.id,
            new BrowserGatewayProxyError("invalid-params", "incompatible Gateway protocol"),
          ),
        );
        websocket.close(1008, "incompatible Gateway protocol");
        return;
      }
      const upstream = this.options.gateway.getHello();
      if (!upstream) {
        send(
          responseError(
            frame.id,
            new BrowserGatewayProxyError("agent-unavailable", "private Gateway is unavailable"),
          ),
        );
        websocket.close(1013, "private Gateway is unavailable");
        return;
      }
      try {
        const access = await this.options.gatewayProxy.resolveAccess(token);
        if (connectionClosed || websocket.readyState !== WebSocket.OPEN) {
          return;
        }
        const hello = projectPlatformClawBrowserHello({
          upstream,
          access,
          connectionId,
          maxPayloadBytes: this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
        });
        unsubscribe = this.options.gateway.subscribe((event) => {
          eventChain = eventChain
            .then(() => forwardEvent(event))
            .catch(() => websocket.close(1011, "event filtering failed"));
        });
        connected = true;
        clearTimeout(handshakeTimer);
        send(responseOk(frame.id, hello));
      } catch (error) {
        send(responseError(frame.id, error));
        closeUnauthorized();
      }
    };

    const handleRequest = async (frame: RequestFrame): Promise<void> => {
      if (!connected) {
        await handleConnect(frame);
        return;
      }
      if (frame.method === "connect") {
        send(
          responseError(
            frame.id,
            new BrowserGatewayProxyError("invalid-params", "already connected"),
          ),
        );
        return;
      }
      try {
        const payload = await this.options.gatewayProxy.request(token, frame.method, frame.params);
        send(responseOk(frame.id, payload));
      } catch (error) {
        send(responseError(frame.id, error));
        if (error instanceof BrowserGatewayProxyError && error.code === "unauthenticated") {
          closeUnauthorized();
        }
      }
    };

    const discardQueuedRequests = (): void => {
      pendingRequestCount -= requestQueue.length;
      pendingRequestBytes -= requestQueue.reduce((total, request) => total + request.byteLength, 0);
      requestQueue.length = 0;
    };

    const drainRequestQueue = (): void => {
      if (connectionClosed || websocket.readyState !== WebSocket.OPEN) {
        return;
      }
      while (activeRequestCount < MAX_CONCURRENT_BROWSER_REQUESTS) {
        const queuedRequest = requestQueue.shift();
        if (!queuedRequest) {
          return;
        }
        activeRequestCount += 1;
        void queuedRequest
          .handle()
          .catch(() => websocket.close(1011, "request handling failed"))
          .finally(() => {
            activeRequestCount -= 1;
            pendingRequestCount -= 1;
            pendingRequestBytes -= queuedRequest.byteLength;
            drainRequestQueue();
          });
      }
    };

    const handleOrderedRequest = async (frame: RequestFrame): Promise<void> => {
      const priorMutations = mutationBarrier;
      if (MUTATING_BROWSER_METHODS.has(frame.method)) {
        const current = priorMutations.then(async () => {
          if (!connectionClosed) {
            await handleRequest(frame);
          }
        });
        mutationBarrier = current.catch(() => undefined);
        await current;
        return;
      }
      await priorMutations;
      if (!connectionClosed) {
        await handleRequest(frame);
      }
    };

    websocket.on("message", (data: RawData, isBinary) => {
      if (connectionClosed) {
        return;
      }
      if (isBinary) {
        websocket.close(1003, "binary frames are not supported");
        return;
      }
      const messageBytes = rawDataByteLength(data);
      if (
        pendingRequestCount >= MAX_PENDING_BROWSER_REQUESTS ||
        pendingRequestBytes + messageBytes > maxPendingRequestBytes
      ) {
        discardQueuedRequests();
        websocket.close(1013, "too many pending browser requests");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decodeTextFrame(data));
      } catch {
        websocket.close(1008, "invalid JSON frame");
        return;
      }
      if (!validateRequestFrame(parsed)) {
        websocket.close(1008, "invalid request frame");
        return;
      }
      pendingRequestCount += 1;
      pendingRequestBytes += messageBytes;
      const handleMessage = () => handleOrderedRequest(parsed);
      if (connected && handshakePendingCount === 0) {
        // Match upstream's independent RPC progress while bounding in-flight Gateway work.
        // Queued closures are discarded below when the browser disconnects.
        requestQueue.push({ handle: handleMessage, byteLength: messageBytes });
        drainRequestQueue();
        return;
      }
      handshakePendingCount += 1;
      handshakeChain = handshakeChain
        .then(handleMessage)
        .catch(() => websocket.close(1011, "request handling failed"))
        .finally(() => {
          handshakePendingCount -= 1;
          pendingRequestCount -= 1;
          pendingRequestBytes -= messageBytes;
        });
    });

    // `ws` forwards transport/protocol failures as EventEmitter errors; consume them per client.
    websocket.on("error", () => websocket.terminate());

    websocket.once("close", () => {
      connectionClosed = true;
      discardQueuedRequests();
      clearTimeout(handshakeTimer);
      unsubscribe();
    });
  }
}
