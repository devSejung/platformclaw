import type { AddressInfo } from "node:net";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
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

  emit(event: EventFrame): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
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
  const policy: PlatformClawBrowserGatewayPolicy = {
    resolveAccess: vi.fn(async () => {
      if (!active) {
        throw new Error("revoked");
      }
      return access;
    }),
    request: vi.fn(async (_token, method, params) => ({ method, params })),
    filterEvent: vi.fn(async (_token, event) => event),
  };
  return { policy, revoke: () => (active = false) };
}

function createFrameQueue(websocket: WebSocket) {
  const frames: unknown[] = [];
  const waiters: Array<{
    predicate: (frame: unknown) => boolean;
    resolve: (frame: unknown) => void;
  }> = [];
  websocket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as unknown;
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
    const { policy, revoke } = createPolicy();
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
        features: { methods: ["agents.list", "chat.send"] },
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
    expect(policy.request).toHaveBeenCalledWith(TEST_SESSION, "agents.list", {});

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
    expect(policy.resolveAccess).not.toHaveBeenCalled();
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
    await vi.waitFor(() => expect(policy.resolveAccess).toHaveBeenCalledTimes(2));
    const closed = new Promise<void>((resolve) => {
      websocket?.once("close", () => resolve());
    });
    websocket.terminate();
    await closed;
    connectAccess.resolve(access);
    await vi.waitFor(() => expect(gateway.listenerCount()).toBe(0));
  });
});
