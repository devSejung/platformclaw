import type { GatewayClientOptions } from "@openclaw/gateway-client";
import type { EventFrame, HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import { PlatformClawGatewayRuntimeClient } from "./gateway-runtime-client.js";

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
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { maxPayload: 1_024, maxBufferedBytes: 2_048, tickIntervalMs: 30_000 },
  };
}

describe("PlatformClawGatewayRuntimeClient", () => {
  it("shares one private client while projecting lifecycle and events", async () => {
    let configured: GatewayClientOptions | undefined;
    const start = vi.fn();
    const stop = vi.fn();
    const request = vi.fn(async () => ({ ok: true }));
    const backend = new PlatformClawGatewayRuntimeClient({
      client: { url: "ws://127.0.0.1:18789", token: "test-auth-token" },
      createClient: (options) => {
        configured = options;
        return { start, stop, request };
      },
    });
    const listener = vi.fn();
    const unsubscribe = backend.subscribe(listener);

    backend.start();
    expect(start).toHaveBeenCalledOnce();
    await expect(backend.request("status")).rejects.toThrow("unavailable");

    configured?.onHelloOk?.(hello());
    await expect(backend.request("status", { quiet: true })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith("status", { quiet: true });

    const event: EventFrame = { type: "event", event: "tick", payload: { ts: 1 } };
    configured?.onEvent?.(event);
    expect(listener).toHaveBeenCalledWith(event);
    unsubscribe();
    configured?.onEvent?.(event);
    expect(listener).toHaveBeenCalledOnce();

    configured?.onClose?.(1006, "closed");
    expect(backend.getHello()).toBeNull();
    backend.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
