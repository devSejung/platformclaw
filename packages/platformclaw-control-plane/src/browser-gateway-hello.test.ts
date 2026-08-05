import type { HelloOk } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import { projectPlatformClawBrowserHello } from "./browser-gateway-hello.js";
import type { BrowserGatewayAccess } from "./browser-gateway-proxy.js";

function upstreamHello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.7.20", connId: "operator-connection" },
    features: {
      methods: [
        "agents.list",
        "chat.send",
        "plugins.list",
        "sessions.companion.ask",
        "sessions.companion.reset",
        "sessions.companion.state",
        "sessions.fork",
        "sessions.observer.visibility",
        "sessions.rewind",
        "users.self",
      ],
      events: ["chat", "tick", "presence", "session.observer"],
      capabilities: ["approvals"],
    },
    snapshot: {
      presence: [{ host: "private-host", ts: 1 }],
      health: { ok: true, ts: 2 },
      stateVersion: { presence: 7, health: 8 },
      uptimeMs: 9,
      configPath: "/private/openclaw.json",
      stateDir: "/private/state",
      sessionDefaults: {
        defaultAgentId: "operator-agent",
        mainKey: "main",
        mainSessionKey: "agent:operator-agent:main",
      },
      authMode: "token",
    },
    auth: {
      role: "operator",
      scopes: ["operator.admin"],
      deviceToken: "test-auth-token",
    },
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

describe("projectPlatformClawBrowserHello", () => {
  it("advertises only browser policy and removes private Gateway metadata", () => {
    const projected = projectPlatformClawBrowserHello({
      upstream: upstreamHello(),
      access,
      connectionId: "browser-1",
      maxPayloadBytes: 512,
    });

    expect(projected.server).toEqual({ version: "2026.7.20", connId: "browser-1" });
    expect(projected.features).toEqual({
      methods: [
        "agents.list",
        "chat.send",
        "commands.list",
        "sessions.companion.ask",
        "sessions.companion.reset",
        "sessions.companion.state",
        "sessions.fork",
        "sessions.observer.visibility",
        "users.self",
      ],
      events: ["tick", "chat", "session.observer"],
      capabilities: [],
    });
    expect(projected.snapshot).toEqual({
      presence: [
        {
          instanceId: "browser-1",
          mode: "webchat",
          ts: 1,
          user: { id: "user-1", name: "person.one" },
        },
      ],
      health: {},
      stateVersion: { presence: 0, health: 0 },
      uptimeMs: 9,
      sessionDefaults: {
        defaultAgentId: "person_one",
        mainKey: "main",
        mainSessionKey: "agent:person_one:main",
      },
    });
    expect(projected.auth).toEqual({
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    });
    expect(projected.policy).toMatchObject({
      allowedSessionVisibilities: [],
      hasMultipleSessionSharingIdentities: false,
      maxPayload: 512,
    });
  });

  it("advertises plugin administration only to PlatformClaw administrators", () => {
    const projected = projectPlatformClawBrowserHello({
      upstream: upstreamHello(),
      access: { ...access, user: { ...access.user, globalRole: "admin" } },
      connectionId: "browser-admin",
      clientInstanceId: "browser-instance",
    });

    expect(projected.features.methods).toContain("plugins.list");
    expect(projected.features.methods).toContain("sessions.rewind");
    expect(projected.auth.scopes).toEqual(["operator.read", "operator.write", "operator.admin"]);
    expect(projected.snapshot.presence[0]).toMatchObject({ instanceId: "browser-instance" });
  });
});
