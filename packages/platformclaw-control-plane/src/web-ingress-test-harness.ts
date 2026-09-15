import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { PlatformClawGatewayBackend } from "./gateway-runtime-client.js";

export function upstreamHello(): HelloOk {
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
      health: { ok: true, ts: 2 },
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 10,
    },
    auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "test-auth-token" },
    policy: { maxPayload: 1_024, maxBufferedBytes: 2_048, tickIntervalMs: 30_000 },
  };
}

export class FakeGateway implements PlatformClawGatewayBackend {
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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
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

export function createFrameQueue(websocket: WebSocket) {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
