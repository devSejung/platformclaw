import { GatewayClientRequestError, type GatewayClientOptions } from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { buildPairingConnectErrorDetails } from "@openclaw/gateway-protocol/connect-error-details";
import { describe, expect, it, vi } from "vitest";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import { PlatformClawGatewayRuntimeClient } from "./gateway-runtime-client.js";
import type { GatewayServiceIdentity } from "./gateway-service-identity.js";

const serviceScopes = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
  "operator.questions",
];

function hello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "test", connId: "private" },
    features: { methods: [], events: [] },
    snapshot: {
      presence: [],
      health: {},
      stateVersion: { presence: 1, health: 1 },
      uptimeMs: 10,
    },
    auth: {
      role: "operator",
      scopes: serviceScopes,
    },
    policy: { maxPayload: 1_024, maxBufferedBytes: 2_048, tickIntervalMs: 30_000 },
  };
}

describe("PlatformClawGatewayRuntimeClient", () => {
  it("shares one private client while projecting lifecycle and events", async () => {
    let configured: GatewayClientOptions | undefined;
    const start = vi.fn();
    const stop = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === "sessions.subscribe" ? { subscribed: true } : { ok: true },
    );
    const backend = new PlatformClawGatewayRuntimeClient({
      client: { url: "ws://127.0.0.1:18789", token: "test-auth-token" },
      createClient: (options) => {
        configured = options;
        return { start, stop, request };
      },
    });
    const listener = vi.fn();
    const disconnectListener = vi.fn();
    const unsubscribe = backend.subscribe(listener);
    const unsubscribeDisconnect = backend.subscribeDisconnect(disconnectListener);

    backend.start();
    expect(start).toHaveBeenCalledOnce();
    await expect(backend.request("status")).rejects.toThrow("unavailable");

    configured?.onHelloOk?.(hello());
    await vi.waitFor(() => expect(backend.getHello()).not.toBeNull());
    await expect(backend.request("status", { quiet: true })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.subscribe", {});
    expect(request).toHaveBeenNthCalledWith(2, "status", { quiet: true });

    const event: EventFrame = { type: "event", event: "tick", payload: { ts: 1 } };
    configured?.onEvent?.(event);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    configured?.onEvent?.(event);
    expect(listener).toHaveBeenCalledOnce();

    configured?.onClose?.(1006, "closed");
    expect(backend.getHello()).toBeNull();
    expect(disconnectListener).toHaveBeenCalledOnce();
    unsubscribeDisconnect();
    backend.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("waits for each session subscription and ignores stale reconnect acknowledgements", async () => {
    let configured: GatewayClientOptions | undefined;
    const acknowledgements: Array<(value: { subscribed: true }) => void> = [];
    const request = vi.fn(
      () =>
        new Promise<{ subscribed: true }>((resolve) => {
          acknowledgements.push(resolve);
        }),
    );
    const backend = new PlatformClawGatewayRuntimeClient({
      client: { url: "ws://127.0.0.1:18789" },
      createClient: (options) => {
        configured = options;
        return { start: vi.fn(), stop: vi.fn(), request };
      },
    });
    const firstHello = hello();
    const secondHello = hello();
    secondHello.server.connId = "replacement";

    configured?.onHelloOk?.(firstHello);
    expect(backend.getHello()).toBeNull();
    expect(request).toHaveBeenNthCalledWith(1, "sessions.subscribe", {});

    configured?.onClose?.(1006, "reconnecting");
    configured?.onHelloOk?.(secondHello);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.subscribe", {});

    acknowledgements[0]?.({ subscribed: true });
    await Promise.resolve();
    expect(backend.getHello()).toBeNull();

    acknowledgements[1]?.({ subscribed: true });
    await vi.waitFor(() => expect(backend.getHello()?.server.connId).toBe("replacement"));
  });

  it("recovers readiness after a transient session subscription failure", async () => {
    vi.useFakeTimers();
    try {
      let configured: GatewayClientOptions | undefined;
      const connectError = vi.fn();
      const request = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error("temporary subscription failure"))
        .mockResolvedValueOnce({ subscribed: true });
      const backend = new PlatformClawGatewayRuntimeClient({
        client: { url: "ws://127.0.0.1:18789", onConnectError: connectError },
        createClient: (options) => {
          configured = options;
          return { start: vi.fn(), stop: vi.fn(), request };
        },
      });

      configured?.onHelloOk?.(hello());
      await vi.waitFor(() => expect(connectError).toHaveBeenCalledOnce());
      expect(backend.getHello()).toBeNull();

      await vi.advanceTimersByTimeAsync(250);

      expect(request).toHaveBeenCalledTimes(2);
      expect(backend.getHello()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report readiness when the Gateway omits a required service scope", async () => {
    let configured: GatewayClientOptions | undefined;
    const request = vi.fn(async () => ({ ok: true }));
    const backend = new PlatformClawGatewayRuntimeClient({
      client: { url: "ws://127.0.0.1:18789" },
      createClient: (options) => {
        configured = options;
        return { start: vi.fn(), stop: vi.fn(), request };
      },
    });
    const insufficient = hello();
    insufficient.auth = { role: "operator", scopes: ["operator.read"] };

    configured?.onHelloOk?.(insufficient);

    expect(backend.getHello()).toBeNull();
    await expect(backend.request("status")).rejects.toThrow("unavailable");
    expect(request).not.toHaveBeenCalled();
  });

  it("approves only its exact first-enrollment request and reconnects", async () => {
    let configured: GatewayClientOptions | undefined;
    const start = vi.fn();
    const identity: GatewayServiceIdentity = {
      deviceId: "service-device",
      privateKeyPem: "private",
      publicKeyPem: "public",
      publicKeyRawBase64Url: "public-raw",
    };
    const call = vi.fn(async (method: string) => {
      if (method === "device.pair.list") {
        return {
          pending: [
            {
              requestId: "request-1",
              deviceId: identity.deviceId,
              publicKey: identity.publicKeyRawBase64Url,
              clientId: "gateway-client",
              clientMode: "backend",
              role: "operator",
              scopes: [...serviceScopes].reverse(),
            },
          ],
        };
      }
      return { ok: true };
    });
    const backend = new PlatformClawGatewayRuntimeClient({
      client: { url: "ws://127.0.0.1:18789" },
      pairing: { adminRpc: { call } as GatewayAdminRpc, identity },
      createClient: (options) => {
        configured = options;
        return { start, stop: vi.fn(), request: vi.fn() };
      },
    });
    expect(backend.getHello()).toBeNull();
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "pairing required",
      details: buildPairingConnectErrorDetails({
        reason: "not-paired",
        requestId: "request-1",
        deviceId: identity.deviceId,
        requestedRole: "operator",
        requestedScopes: serviceScopes,
      }),
    });

    configured?.onConnectError?.(error);
    configured?.onReconnectPaused?.({
      code: 1008,
      reason: "pairing required",
      detailCode: "PAIRING_REQUIRED",
    });

    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(configured?.hostDeps).toBeDefined();
    expect(call).toHaveBeenNthCalledWith(1, "device.pair.list", {});
    expect(call).toHaveBeenNthCalledWith(2, "device.pair.approve", {
      requestId: "request-1",
    });
  });

  it("auto-approves only the service identity's exact scope upgrade", async () => {
    let configured: GatewayClientOptions | undefined;
    const connectErrors: Error[] = [];
    const call = vi.fn(async (method: string) => {
      if (method === "device.pair.list") {
        return {
          pending: [
            {
              requestId: "request-2",
              deviceId: identity.deviceId,
              publicKey: identity.publicKeyRawBase64Url,
              clientId: "gateway-client",
              clientMode: "backend",
              role: "operator",
              scopes: [...serviceScopes].reverse(),
            },
          ],
        };
      }
      return { ok: true };
    });
    const identity: GatewayServiceIdentity = {
      deviceId: "service-device",
      privateKeyPem: "private",
      publicKeyPem: "public",
      publicKeyRawBase64Url: "public-raw",
    };
    const backend = new PlatformClawGatewayRuntimeClient({
      client: {
        url: "ws://127.0.0.1:18789",
        onConnectError: (error) => connectErrors.push(error),
      },
      pairing: { adminRpc: { call } as GatewayAdminRpc, identity },
      createClient: (options) => {
        configured = options;
        return { start: vi.fn(), stop: vi.fn(), request: vi.fn() };
      },
    });
    expect(backend.getHello()).toBeNull();
    const error = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "scope upgrade",
      details: buildPairingConnectErrorDetails({
        reason: "scope-upgrade",
        requestId: "request-2",
        deviceId: identity.deviceId,
        requestedRole: "operator",
        requestedScopes: serviceScopes,
      }),
    });

    configured?.onConnectError?.(error);
    await vi.waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("device.pair.approve", { requestId: "request-2" }),
    );
    expect(connectErrors).toContain(error);
  });

  it("clears failed pairing latches and caps automatic reconnects without HelloOk", async () => {
    let configured: GatewayClientOptions | undefined;
    const start = vi.fn();
    const connectErrors: Error[] = [];
    const identity: GatewayServiceIdentity = {
      deviceId: "service-device",
      privateKeyPem: "private",
      publicKeyPem: "public",
      publicKeyRawBase64Url: "public-raw",
    };
    let listAttempts = 0;
    let pendingRequestId = "request-2";
    const call = vi.fn(async (method: string) => {
      if (method === "device.pair.list") {
        listAttempts += 1;
        if (listAttempts === 1) {
          throw new Error("temporary admin RPC failure");
        }
        return {
          pending: [
            {
              requestId: pendingRequestId,
              deviceId: identity.deviceId,
              publicKey: identity.publicKeyRawBase64Url,
              clientId: "gateway-client",
              clientMode: "backend",
              role: "operator",
              scopes: serviceScopes,
            },
          ],
        };
      }
      return { ok: true };
    });
    const backend = new PlatformClawGatewayRuntimeClient({
      client: {
        url: "ws://127.0.0.1:18789",
        onConnectError: (error) => connectErrors.push(error),
      },
      pairing: { adminRpc: { call } as GatewayAdminRpc, identity },
      createClient: (options) => {
        configured = options;
        return { start, stop: vi.fn(), request: vi.fn() };
      },
    });
    expect(backend.getHello()).toBeNull();
    const pairingError = (requestId: string) =>
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "pairing required",
        details: buildPairingConnectErrorDetails({
          reason: "not-paired",
          requestId,
          deviceId: identity.deviceId,
          requestedRole: "operator",
          requestedScopes: serviceScopes,
        }),
      });
    const paused = {
      code: 1008,
      reason: "pairing required",
      detailCode: "PAIRING_REQUIRED" as const,
    };

    configured?.onConnectError?.(pairingError("request-1"));
    configured?.onReconnectPaused?.(paused);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    configured?.onConnectError?.(pairingError("request-2"));
    configured?.onReconnectPaused?.(paused);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));

    pendingRequestId = "request-3";
    configured?.onConnectError?.(pairingError("request-3"));
    configured?.onReconnectPaused?.(paused);
    await vi.waitFor(() =>
      expect(call).toHaveBeenLastCalledWith("device.pair.approve", { requestId: "request-3" }),
    );

    expect(connectErrors.some((error) => error.message === "temporary admin RPC failure")).toBe(
      true,
    );
    expect(start).toHaveBeenCalledTimes(2);
  });
});
