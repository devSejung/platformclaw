import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { BrowserGatewayAccess } from "./browser-gateway-contracts.js";
import { createBrowserExecutionChangeForwarder } from "./browser-gateway-event-forwarder.js";
import { decodeTextFrame } from "./browser-gateway-frames.js";
import {
  PLATFORMCLAW_EXECUTION_CHANGED,
  type VmCredentialStateChange,
} from "./execution-contracts.js";
import { PlatformClawWebIngressServer } from "./web-ingress-server.js";
import { createFrameQueue, deferred, FakeGateway, isRecord } from "./web-ingress-test-harness.js";

function accessFor(agentId: string): BrowserGatewayAccess {
  return {
    user: {
      id: `user-${agentId}`,
      accountId: agentId,
      employeeId: agentId,
      status: "active",
      globalRole: "member",
      groups: [],
      createdAt: 1,
      updatedAt: 1,
    },
    binding: {
      id: `binding-${agentId}`,
      kind: "personal",
      userId: `user-${agentId}`,
      agentId,
      state: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    mainSessionKey: `agent:${agentId}:main`,
  };
}

describe("browser VM authentication recovery events", () => {
  it.each(["disconnected", "rebound"])(
    "drops a queued notice after access becomes %s",
    async (state) => {
      const authority = deferred<BrowserGatewayAccess>();
      let connected = true;
      const sendEvent = vi.fn();
      const forward = createBrowserExecutionChangeForwarder({
        token: "alice",
        proxy: { resolveAccess: () => authority.promise },
        isConnected: () => connected,
        sendEvent,
        closeUnauthorized: vi.fn(),
      });
      const delivery = forward({
        agentId: "alice",
        allocationId: "allocation-alice",
        targetRevision: 4,
        credentialRevision: 2,
        status: "update_required",
      });
      connected = state !== "disconnected";
      authority.resolve(accessFor(state === "rebound" ? "bob" : "alice"));
      await delivery;
      expect(sendEvent).not.toHaveBeenCalled();
    },
  );

  it("delivers only to the current owner, revalidates sessions, and unsubscribes closed browsers", async () => {
    const gateway = new FakeGateway();
    const listeners = new Set<(change: VmCredentialStateChange) => void>();
    const accesses = new Map([
      ["alice", accessFor("alice")],
      ["bob", accessFor("bob")],
    ]);
    const resolveAccess = vi.fn(async (token: string) => {
      const access = accesses.get(token);
      if (!access) {
        throw new Error("session revoked");
      }
      return access;
    });
    const server = new PlatformClawWebIngressServer({
      publicOrigin: "https://platformclaw.example",
      authService: {} as BrowserAuthService,
      loginRateLimiter: {
        check: () => ({ allowed: true, retryAfterMs: 0 }),
        recordFailure: vi.fn(),
      },
      gateway,
      gatewayProxy: {
        resolveAccess,
        request: vi.fn(),
        filterEvent: vi.fn(async (_token, event) => event),
      },
      subscribeExecutionChanges: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const sockets: WebSocket[] = [];
    await server.listen({ host: "127.0.0.1", port: 0 });
    const port = (server.address() as AddressInfo).port;
    const connect = async (token: string) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/platformclaw/gateway`, {
        origin: "https://platformclaw.example",
        headers: { Cookie: `platformclaw_session=${token}` },
      });
      sockets.push(socket);
      const frames: unknown[] = [];
      socket.on("message", (bytes) => frames.push(JSON.parse(decodeTextFrame(bytes))));
      const next = createFrameQueue(socket);
      await next((frame) => isRecord(frame) && frame.event === "connect.challenge");
      socket.send(
        JSON.stringify({
          type: "req",
          id: "connect",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "openclaw-control-ui",
              version: "test",
              platform: "web",
              mode: "webchat",
            },
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
        }),
      );
      await next((frame) => isRecord(frame) && frame.id === "connect");
      return { socket, next, frames };
    };
    try {
      const alice = await connect("alice");
      const bob = await connect("bob");
      expect(listeners.size).toBe(2);
      const change = {
        agentId: "alice",
        allocationId: "allocation-alice",
        targetRevision: 4,
        credentialRevision: 2,
        status: "update_required" as const,
        password: "synthetic-extra-must-not-cross",
      };
      for (const listener of listeners) {
        listener(change);
      }
      gateway.emit({ type: "event", event: "tick", payload: { ts: 1 } });
      const recovery = await alice.next(
        (frame) => isRecord(frame) && frame.event === PLATFORMCLAW_EXECUTION_CHANGED,
      );
      expect(recovery).toEqual({
        type: "event",
        event: PLATFORMCLAW_EXECUTION_CHANGED,
        seq: 1,
        payload: {
          agentId: "alice",
          allocationId: "allocation-alice",
          targetRevision: 4,
          credentialRevision: 2,
          status: "update_required",
        },
      });
      await bob.next((frame) => isRecord(frame) && frame.event === "tick");
      expect(
        bob.frames.some(
          (frame) => isRecord(frame) && frame.event === PLATFORMCLAW_EXECUTION_CHANGED,
        ),
      ).toBe(false);
      expect(resolveAccess).toHaveBeenCalledWith("alice", false);
      expect(resolveAccess).toHaveBeenCalledWith("bob", false);

      // The original handshake remains valid-looking after revocation; delivery
      // must check current authentication rather than trusting that old snapshot.
      accesses.delete("alice");
      const revoked = new Promise<number>((resolve) => {
        alice.socket.once("close", resolve);
      });
      for (const listener of listeners) {
        listener(change);
      }
      await expect(revoked).resolves.toBe(1008);
      await vi.waitFor(() => expect(listeners.size).toBe(1));
      const bobClosed = new Promise<void>((resolve) => {
        bob.socket.once("close", () => resolve());
      });
      bob.socket.close();
      await bobClosed;
      await vi.waitFor(() => expect(listeners.size).toBe(0));
    } finally {
      for (const socket of sockets) {
        socket.terminate();
      }
      await server.close();
    }
  });
});
