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

export const PLATFORMCLAW_GATEWAY_PATH = "/platformclaw/gateway";
export const PLATFORMCLAW_HEALTH_PATH = "/platformclaw/health";

const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_PENDING_BROWSER_REQUESTS = 8;

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
      const pathname = new URL(req.url ?? "/", this.publicOrigin).pathname;
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
    let messageChain = Promise.resolve();
    let pendingRequestCount = 0;
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

    websocket.on("message", (data: RawData, isBinary) => {
      if (connectionClosed) {
        return;
      }
      if (pendingRequestCount >= MAX_PENDING_BROWSER_REQUESTS) {
        websocket.close(1013, "too many pending browser requests");
        return;
      }
      pendingRequestCount += 1;
      messageChain = messageChain
        .then(async () => {
          if (connectionClosed) {
            return;
          }
          if (isBinary) {
            websocket.close(1003, "binary frames are not supported");
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString());
          } catch {
            websocket.close(1008, "invalid JSON frame");
            return;
          }
          if (!validateRequestFrame(parsed)) {
            websocket.close(1008, "invalid request frame");
            return;
          }
          await handleRequest(parsed);
        })
        .catch(() => websocket.close(1011, "request handling failed"))
        .finally(() => {
          pendingRequestCount -= 1;
        });
    });

    // `ws` forwards transport/protocol failures as EventEmitter errors; consume them per client.
    websocket.on("error", () => websocket.terminate());

    websocket.once("close", () => {
      connectionClosed = true;
      clearTimeout(handshakeTimer);
      unsubscribe();
    });
  }
}
