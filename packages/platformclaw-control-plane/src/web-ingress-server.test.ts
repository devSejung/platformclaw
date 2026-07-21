import type { AddressInfo } from "node:net";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { BrowserGatewayAccess } from "./browser-gateway-proxy.js";
import type { PlatformClawGatewayBackend } from "./gateway-runtime-client.js";
import {
  PlatformClawWebIngressServer,
  type PlatformClawBrowserGatewayPolicy,
} from "./web-ingress-server.js";

const PUBLIC_ORIGIN = "https://platformclaw.example";
const TEST_SESSION = "test-auth-token";

function upstreamHello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: "private" },
    features: {
      methods: ["agents.list", "chat.send", "config.get"],
      events: ["chat", "tick", "presence"],
    },
    snapshot: {
      presence: [{ host: "private-host", ts: 1 }],
      health: { private: true },
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 10,
    },
    auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "test-auth-token" },
    policy: { maxPayload: 1_024, maxBufferedBytes: 2_048, tickIntervalMs: 30_000 },
  };
}

const access: BrowserGatewayAccess = {
  user: {
    id: "user-1",
    accountId: "person.one",
    employeeId: "1001",
    status: "active",
    globalRole: "member",
    groups: [],
    createdAt: 1,
    updatedAt: 1,
  },
  binding: {
    id: "binding-1",
    kind: "personal",
    userId: "user-1",
    agentId: "person_one",
    state: "active",
    createdAt: 1,
    updatedAt: 1,
  },
  mainSessionKey: "agent:person_one:main",
};

class FakeGateway implements PlatformClawGatewayBackend {
  private readonly listeners = new Set<(event: EventFrame) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  readonly start = vi.fn();
  readonly stop = vi.fn();
  readonly request = vi.fn(async () => ({ upstream: true }));

  getHello(): HelloOk {
    return upstreamHello();
  }

  subscribe(listener: (event: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  emit(event: EventFrame): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) {
      listener();
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createPolicy() {
  let active = true;
  const resolveAccess = vi.fn(async () => {
    if (!active) {
      throw new Error("revoked");
    }
    return access;
  });
  const request = vi.fn(async (_token: string, method: string, params?: unknown) => ({
    method,
    params,
  }));
  const policy: PlatformClawBrowserGatewayPolicy = {
    resolveAccess,
    request,
    filterEvent: vi.fn(async (_token, event) => event),
  };
  return { policy, request, resolveAccess, revoke: () => (active = false) };
}

function decodeTestFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.concat(data).toString("utf8");
}

function createFrameQueue(websocket: WebSocket) {
  const frames: unknown[] = [];
  const waiters: Array<{
    predicate: (frame: unknown) => boolean;
    resolve: (frame: unknown) => void;
  }> = [];
  websocket.on("message", (data) => {
    const frame = JSON.parse(decodeTestFrame(data)) as unknown;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex >= 0) {
      waiters.splice(waiterIndex, 1)[0]?.resolve(frame);
      return;
    }
    frames.push(frame);
  });
  return (predicate: (frame: unknown) => boolean) => {
    const index = frames.findIndex(predicate);
    if (index >= 0) {
      return Promise.resolve(frames.splice(index, 1)[0]);
    }
    return new Promise<unknown>((resolve) => {
      waiters.push({ predicate, resolve });
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

describe("PlatformClawWebIngressServer", () => {
  let server: PlatformClawWebIngressServer | undefined;
  let websocket: WebSocket | undefined;

  afterEach(async () => {
    websocket?.terminate();
    websocket = undefined;
    await server?.close();
    server = undefined;
  });

  it("speaks the Gateway wire protocol while enforcing browser session ownership", async () => {
    const gateway = new FakeGateway();
    const { policy, request, revoke } = createPolicy();
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    const nextFrame = createFrameQueue(websocket);
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    await expect(
      nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge"),
    ).resolves.toMatchObject({ type: "event", event: "connect.challenge" });

    websocket.send(
      JSON.stringify({
        type: "req",
        id: "connect-1",
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          },
        },
      }),
    );
    const connected = await nextFrame(
      (frame) => isRecord(frame) && frame.type === "res" && frame.id === "connect-1",
    );
    expect(connected).toMatchObject({
      ok: true,
      payload: {
        type: "hello-ok",
        features: { methods: ["agents.list", "chat.send", "commands.list"] },
        snapshot: {
          presence: [],
          sessionDefaults: {
            defaultAgentId: "person_one",
            mainSessionKey: "agent:person_one:main",
          },
        },
        auth: { scopes: ["operator.read", "operator.write"] },
      },
    });

    websocket.send(
      JSON.stringify({ type: "req", id: "list-1", method: "agents.list", params: {} }),
    );
    await expect(
      nextFrame((frame) => isRecord(frame) && frame.id === "list-1"),
    ).resolves.toMatchObject({
      type: "res",
      ok: true,
      payload: { method: "agents.list", params: {} },
    });
    expect(request).toHaveBeenCalledWith(TEST_SESSION, "agents.list", {});

    gateway.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:person_one:main" },
      seq: 99,
      stateVersion: { presence: 50, health: 50 },
    });
    await expect(nextFrame((frame) => isRecord(frame) && frame.event === "chat")).resolves.toEqual({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:person_one:main" },
      seq: 1,
    });

    revoke();
    const closed = new Promise<number>((resolve) => {
      websocket?.once("close", resolve);
    });
    gateway.emit({ type: "event", event: "tick", payload: { ts: 2 }, seq: 100 });
    await expect(closed).resolves.toBe(1008);
    expect(gateway.start).toHaveBeenCalledOnce();
  });

  it("rejects WebSocket upgrades without the exact public origin", async () => {
    const gateway = new FakeGateway();
    const { policy, resolveAccess } = createPolicy();
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: "https://attacker.example",
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });

    const responseStatus = await new Promise<number>((resolve, reject) => {
      websocket?.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      websocket?.once("error", reject);
    });
    expect(responseStatus).toBe(403);
    expect(resolveAccess).not.toHaveBeenCalled();
  });

  it("closes browsers so they resynchronize after the private Gateway disconnects", async () => {
    const gateway = new FakeGateway();
    const { policy } = createPolicy();
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => {
      websocket?.once("close", resolve);
    });

    gateway.disconnect();

    await expect(closed).resolves.toBe(1012);
  });

  it("lets independent browser requests progress concurrently", async () => {
    const gateway = new FakeGateway();
    const blockedRequest = deferred<unknown>();
    const policy: PlatformClawBrowserGatewayPolicy = {
      resolveAccess: vi.fn(async () => access),
      request: vi.fn(async (_token, _method, params) => {
        if (isRecord(params) && params.blocked === true) {
          return blockedRequest.promise;
        }
        return { completed: true };
      }),
      filterEvent: vi.fn(async (_token, event) => event),
    };
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    const nextFrame = createFrameQueue(websocket);
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
    websocket.send(
      JSON.stringify({
        type: "req",
        id: "connect-concurrent",
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          },
        },
      }),
    );
    await nextFrame((frame) => isRecord(frame) && frame.id === "connect-concurrent");
    websocket.send(
      JSON.stringify({
        type: "req",
        id: "blocked",
        method: "agents.list",
        params: { blocked: true },
      }),
    );
    websocket.send(JSON.stringify({ type: "req", id: "fast", method: "agents.list", params: {} }));

    await expect(
      nextFrame((frame) => isRecord(frame) && frame.id === "fast"),
    ).resolves.toMatchObject({ ok: true, payload: { completed: true } });
    blockedRequest.resolve({});
    await expect(
      nextFrame((frame) => isRecord(frame) && frame.id === "blocked"),
    ).resolves.toMatchObject({ ok: true });
  });

  it("preserves mutation order before serving later reads", async () => {
    const gateway = new FakeGateway();
    const firstMutation = deferred<unknown>();
    const request = vi.fn(async (_token: string, method: string) => {
      if (method === "chat.send" && request.mock.calls.length === 1) {
        return firstMutation.promise;
      }
      return { completed: true };
    });
    const policy: PlatformClawBrowserGatewayPolicy = {
      resolveAccess: vi.fn(async () => access),
      request,
      filterEvent: vi.fn(async (_token, event) => event),
    };
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    const nextFrame = createFrameQueue(websocket);
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
    websocket.send(
      JSON.stringify({
        type: "req",
        id: "connect-order",
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          },
        },
      }),
    );
    await nextFrame((frame) => isRecord(frame) && frame.id === "connect-order");
    websocket.send(JSON.stringify({ type: "req", id: "send-1", method: "chat.send", params: {} }));
    websocket.send(JSON.stringify({ type: "req", id: "send-2", method: "chat.send", params: {} }));
    websocket.send(
      JSON.stringify({ type: "req", id: "read-after", method: "agents.list", params: {} }),
    );

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    firstMutation.resolve({ completed: true });
    await nextFrame((frame) => isRecord(frame) && frame.id === "read-after");
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "chat.send",
      "chat.send",
      "agents.list",
    ]);
  });

  it("drains requests received during connect before post-connect mutations", async () => {
    const gateway = new FakeGateway();
    const connectAccess = deferred<BrowserGatewayAccess>();
    const firstMutation = deferred<unknown>();
    let accessCalls = 0;
    const request = vi.fn(async (_token: string, _method: string, params?: unknown) => {
      if (request.mock.calls.length === 1) {
        return firstMutation.promise;
      }
      return params;
    });
    const policy: PlatformClawBrowserGatewayPolicy = {
      resolveAccess: vi.fn(async () => {
        accessCalls += 1;
        return accessCalls === 1 ? access : connectAccess.promise;
      }),
      request,
      filterEvent: vi.fn(async (_token, event) => event),
    };
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    const nextFrame = createFrameQueue(websocket);
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
    websocket.send(
      JSON.stringify({
        type: "req",
        id: "connect-backlog",
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          },
        },
      }),
    );
    websocket.send(
      JSON.stringify({ type: "req", id: "send-1", method: "chat.send", params: { order: 1 } }),
    );
    websocket.send(
      JSON.stringify({ type: "req", id: "send-2", method: "chat.send", params: { order: 2 } }),
    );
    connectAccess.resolve(access);
    await nextFrame((frame) => isRecord(frame) && frame.id === "connect-backlog");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    websocket.send(
      JSON.stringify({ type: "req", id: "send-3", method: "chat.send", params: { order: 3 } }),
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(request).toHaveBeenCalledTimes(1);

    firstMutation.resolve({ completed: true });
    await nextFrame((frame) => isRecord(frame) && frame.id === "send-3");
    expect(request.mock.calls.map((call) => (call[2] as { order: number }).order)).toEqual([
      1, 2, 3,
    ]);
  });

  it("closes a browser that exceeds the concurrent request limit", async () => {
    const gateway = new FakeGateway();
    const blockedRequest = deferred<unknown>();
    const request = vi.fn(async () => blockedRequest.promise);
    const policy: PlatformClawBrowserGatewayPolicy = {
      resolveAccess: vi.fn(async () => access),
      request,
      filterEvent: vi.fn(async (_token, event) => event),
    };
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    const nextFrame = createFrameQueue(websocket);
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
    websocket.send(
      JSON.stringify({
        type: "req",
        id: "connect-limit",
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          },
        },
      }),
    );
    await nextFrame((frame) => isRecord(frame) && frame.id === "connect-limit");
    const closed = new Promise<number>((resolve) => {
      websocket?.once("close", resolve);
    });
    for (let index = 0; index < 65; index += 1) {
      websocket.send(
        JSON.stringify({ type: "req", id: `pending-${index}`, method: "agents.list", params: {} }),
      );
    }

    await expect(closed).resolves.toBe(1013);
    blockedRequest.resolve({});
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(8));
  });

  it("does not retain a Gateway subscription when the browser closes during connect", async () => {
    const gateway = new FakeGateway();
    const connectAccess = deferred<BrowserGatewayAccess>();
    let accessCalls = 0;
    const policy: PlatformClawBrowserGatewayPolicy = {
      resolveAccess: vi.fn(async () => {
        accessCalls += 1;
        return accessCalls === 1 ? access : connectAccess.promise;
      }),
      request: vi.fn(async () => ({})),
      filterEvent: vi.fn(async (_token, event) => event),
    };
    server = new PlatformClawWebIngressServer({
      publicOrigin: PUBLIC_ORIGIN,
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gatewayProxy: policy,
      gateway,
    });
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    websocket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
      origin: PUBLIC_ORIGIN,
      headers: { Cookie: `platformclaw_session=${TEST_SESSION}` },
    });
    const nextFrame = createFrameQueue(websocket);
    await new Promise<void>((resolve, reject) => {
      websocket?.once("open", resolve);
      websocket?.once("error", reject);
    });
    await nextFrame((frame) => isRecord(frame) && frame.event === "connect.challenge");
    websocket.send(
      JSON.stringify({
        type: "req",
        id: "connect-race",
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(accessCalls).toBe(2));
    const closed = new Promise<void>((resolve) => {
      websocket?.once("close", () => resolve());
    });
    websocket.terminate();
    await closed;
    connectAccess.resolve(access);
    await vi.waitFor(() => expect(gateway.listenerCount()).toBe(0));
  });
});
