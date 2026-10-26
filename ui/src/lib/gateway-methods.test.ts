import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

function snapshot(params: {
  connected?: boolean;
  methods?: string[];
  scopes?: string[];
  includeAuth?: boolean;
  includeScopes?: boolean;
  capabilities?: string[];
}): ApplicationGatewaySnapshot {
  const connected = params.connected ?? true;
  return {
    client: connected ? ({} as ApplicationGatewaySnapshot["client"]) : null,
    phase: connected ? "connected" : "offline",
    offlineStable: !connected,
    hello: {
      auth:
        params.includeAuth === false
          ? undefined
          : {
              role: "operator",
              scopes:
                params.includeScopes === false ? undefined : (params.scopes ?? ["operator.admin"]),
            },
      features: { methods: params.methods, capabilities: params.capabilities },
    } as ApplicationGatewaySnapshot["hello"],
    canvasPluginSurfaceRoute: { mode: "direct" },
    assistantAgentId: null,
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  };
}

describe("canCallGatewayMethod", () => {
  it.each([
    ["disconnected", { connected: false }],
    ["method unavailable", { methods: [], scopes: ["operator.admin"] }],
    ["scope insufficient", { methods: ["skills.update"], scopes: ["operator.write"] }],
  ])("blocks %s calls", (_name, params) => {
    expect(canCallGatewayMethod(snapshot(params), "skills.update", "operator.admin")).toBe(false);
  });

  it("preserves legacy behavior when methods or auth scopes are omitted", () => {
    expect(
      canCallGatewayMethod(snapshot({ includeAuth: false }), "skills.update", "operator.admin"),
    ).toBe(true);
    expect(
      canCallGatewayMethod(
        snapshot({ methods: ["skills.update"], includeScopes: false }),
        "skills.update",
        "operator.admin",
      ),
    ).toBe(true);
  });

  it("supports registered methods that are intentionally not advertised", () => {
    expect(
      canCallGatewayMethod(
        snapshot({ methods: [], scopes: ["operator.admin"] }),
        "config.openFile",
        "operator.admin",
        { requireAdvertisement: false },
      ),
    ).toBe(true);
  });
  it("uses the server-owned catalog for personal writes without granting global admin", () => {
    const current = snapshot({
      methods: ["agents.files.set"],
      scopes: ["operator.write"],
      capabilities: ["control-ui.server-authorized-methods"],
    });
    expect(canCallGatewayMethod(current, "agents.files.set", "operator.admin")).toBe(true);
    expect(canCallGatewayMethod(current, "config.patch", "operator.admin")).toBe(false);
    expect(
      canCallGatewayMethod(current, "config.openFile", "operator.admin", {
        requireAdvertisement: false,
      }),
    ).toBe(false);
  });

  it("requires explicit method metadata when the server owns authorization", () => {
    expect(
      canCallGatewayMethod(
        snapshot({
          scopes: ["operator.admin"],
          capabilities: ["control-ui.server-authorized-methods"],
        }),
        "agents.files.set",
        "operator.admin",
      ),
    ).toBe(false);
  });
});
