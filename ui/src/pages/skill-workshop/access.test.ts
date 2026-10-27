import { describe, expect, it } from "vitest";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { resolveWorkshopAccess } from "./access.ts";

const methods = [
  "skills.proposals.apply",
  "skills.proposals.evaluate",
  "skills.proposals.historyScan",
  "skills.proposals.reject",
  "skills.proposals.requestRevision",
];

function snapshot(scoped: boolean, scopes = ["operator.write"]): ApplicationGatewaySnapshot {
  return {
    client: {} as ApplicationGatewaySnapshot["client"],
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
      protocol: 4,
      features: { methods, capabilities: scoped ? ["control-ui.server-authorized-methods"] : [] },
      auth: {
        role: "operator",
        scopes,
      },
    },
    canvasPluginSurfaceRoute: { mode: "direct" },
    assistantAgentId: "personal",
    sessionKey: "agent:personal:main",
    lastError: null,
    lastErrorCode: null,
  };
}

describe("Skill Workshop endpoint authorization", () => {
  it("enables personal proposal actions without global admin", () => {
    expect(Object.values(resolveWorkshopAccess(snapshot(true))).every(Boolean)).toBe(true);
  });

  it("preserves the shared operator admin requirement", () => {
    expect(Object.values(resolveWorkshopAccess(snapshot(false))).some(Boolean)).toBe(false);
  });

  it("does not enable disconnected personal actions", () => {
    const current = snapshot(true);
    current.phase = "offline";
    current.client = null;
    expect(Object.values(resolveWorkshopAccess(current)).some(Boolean)).toBe(false);
  });
});
