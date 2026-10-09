import { once } from "node:events";
import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
  type GatewayClientRequestOptions,
} from "@openclaw/gateway-client";
import {
  validateRequestFrame,
  type EventFrame,
  type RequestFrame,
} from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { PlatformClawGatewayRuntimeClient } from "./gateway-runtime-client.js";
import { deferred, upstreamHello } from "./web-ingress-test-harness.js";

async function createPrivateGatewayFixture() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("private Gateway test address unavailable");
  }
  const requests: RequestFrame[] = [];
  const waiters = new Map<string, (frame: RequestFrame) => void>();
  let peer: WebSocket | undefined;
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data) => {
      const bytes = Buffer.isBuffer(data)
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : Buffer.concat(data);
      const frame: unknown = JSON.parse(bytes.toString("utf8"));
      if (!validateRequestFrame(frame)) {
        throw new Error("private Gateway received an invalid client request");
      }
      requests.push(frame);
      if (frame.method === "connect" || frame.method === "sessions.subscribe") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: frame.method === "connect" ? upstreamHello() : { subscribed: true },
          }),
        );
      }
      waiters.get(frame.method)?.(frame);
      waiters.delete(frame.method);
    });
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "private-gateway-compaction", ts: Date.now() },
      }),
    );
  });
  // Exercise the production private GatewayClient, including its real wire handshake,
  // request correlation and default deadline; only the remote handler is controlled.
  const backend = new PlatformClawGatewayRuntimeClient({
    client: {
      url: `ws://127.0.0.1:${address.port}`,
      token: "test-auth-token",
      deviceIdentity: null,
    },
  });
  const close = async () => {
    vi.useRealTimers();
    backend.stop();
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };
  backend.start();
  try {
    await vi.waitFor(() => expect(backend.getHello()).not.toBeNull());
  } catch (error) {
    await close();
    throw error;
  }
  return {
    backend,
    requests,
    close,
    nextRequest(method: string): Promise<RequestFrame> {
      const frame = requests.find((request) => request.method === method);
      return frame
        ? Promise.resolve(frame)
        : new Promise((resolve) => {
            waiters.set(method, resolve);
          });
    },
    send(frame: unknown) {
      if (!peer) {
        throw new Error("private Gateway test connection unavailable");
      }
      peer.send(JSON.stringify(frame));
    },
    disconnect() {
      if (!peer) {
        throw new Error("private Gateway test connection unavailable");
      }
      peer.close(1012, "compaction service restart");
    },
  };
}

describe("private Gateway compaction request lifecycle", () => {
  it.each(["completed", "failed", "disconnected"] as const)(
    "waits beyond the ordinary RPC deadline for compaction to become %s without replaying it",
    async (terminal) => {
      const f = await createPrivateGatewayFixture();
      try {
        const events: EventFrame[] = [];
        const started = deferred<void>();
        f.backend.subscribe((event) => {
          events.push(event);
          started.resolve();
        });
        const disconnected = vi.fn();
        f.backend.subscribeDisconnect(disconnected);
        // Start fake request timers after the real socket/hello/subscription are ready.
        // Advancing the RPC clock must not replace the actual transport or handler.
        vi.useFakeTimers();
        const response = f.backend.request("sessions.compact", { key: "agent:employee:main" });
        const settled = vi.fn();
        const outcome = response.then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        void outcome.then(settled);
        const request = await f.nextRequest("sessions.compact");
        const start: EventFrame = {
          type: "event",
          event: "agent",
          payload: {
            sessionKey: "agent:employee:main",
            runId: "compact-operation",
            stream: "compaction",
            data: { phase: "start", itemId: "compact-item" },
          },
        };
        f.send(start);
        await started.promise;
        await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS + 1);
        expect(settled).not.toHaveBeenCalled();
        expect(f.requests.filter((frame) => frame.method === "sessions.compact")).toEqual([
          request,
        ]);
        if (terminal === "disconnected") {
          f.disconnect();
          expect(await outcome).toMatchObject({
            status: "rejected",
            error: {
              message: "gateway closed (1012): compaction service restart",
              details: { requestDisposition: "outcome-unknown" },
            },
          });
          expect(disconnected).toHaveBeenCalledOnce();
          expect(f.backend.getHello()).toBeNull();
        } else {
          const end: EventFrame = {
            type: "event",
            event: "agent",
            payload: {
              sessionKey: "agent:employee:main",
              runId: "compact-operation",
              stream: "compaction",
              data: {
                phase: "end",
                itemId: "compact-item",
                completed: terminal === "completed",
                willRetry: false,
              },
            },
          };
          f.send(end);
          const error = {
            code: "UNAVAILABLE",
            message: "Compaction provider is unavailable",
            details: { stage: "compaction-runtime" },
          };
          const payload = {
            ok: true,
            key: "agent:employee:main",
            compacted: true,
            result: { tokensBefore: 90_000, tokensAfter: 10_000 },
          };
          f.send({
            type: "res",
            id: request.id,
            ok: terminal === "completed",
            ...(terminal === "completed" ? { payload } : { error }),
          });
          const result = await outcome;
          if (terminal === "completed") {
            expect(result).toEqual({ status: "fulfilled", value: payload });
          } else {
            expect(result.status).toBe("rejected");
            if (result.status !== "rejected") {
              throw new Error("expected the private Gateway failure to reject compaction");
            }
            expect(result.error).toBeInstanceOf(GatewayClientRequestError);
            expect(result.error).toMatchObject({
              gatewayCode: error.code,
              message: error.message,
              details: error.details,
            });
          }
          expect(events).toEqual([start, end]);
        }
        expect(f.requests.filter((frame) => frame.method === "sessions.compact")).toEqual([
          request,
        ]);
      } finally {
        await f.close();
      }
    },
  );

  it.each<{
    method: string;
    timeoutMs: number;
    options?: GatewayClientRequestOptions;
  }>([
    { method: "status", timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    { method: "sessions.compact", timeoutMs: 100, options: { timeoutMs: 100 } },
  ])("retains the $method request's finite deadline", async ({ method, timeoutMs, options }) => {
    const f = await createPrivateGatewayFixture();
    try {
      vi.useFakeTimers();
      const response = f.backend.request(method, {}, options);
      const rejection = expect(response).rejects.toMatchObject({
        method,
        timeoutMs,
        requestSent: true,
      });
      const request = await f.nextRequest(method);
      await vi.advanceTimersByTimeAsync(timeoutMs);
      await rejection;
      await expect(response).rejects.toBeInstanceOf(GatewayClientRequestTimeoutError);
      expect(f.requests.filter((frame) => frame.method === method)).toEqual([request]);
    } finally {
      await f.close();
    }
  });
});
