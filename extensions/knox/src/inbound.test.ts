import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchKnoxInbound } from "./inbound.js";
import { sendKnoxOutbound } from "./outbound.js";
import { setKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const resolveRouting = vi.hoisted(() => vi.fn());

vi.mock("./routing-client.js", () => ({
  KnoxRoutingClient: class {
    resolve = resolveRouting;
  },
}));

vi.mock("./outbound.js", async () => {
  const actual = await vi.importActual<typeof import("./outbound.js")>("./outbound.js");
  return { ...actual, sendKnoxOutbound: vi.fn() };
});

const account: ResolvedKnoxAccount = {
  accountId: "default",
  enabled: true,
  configured: true,
  webhookPath: "/knox",
  webhookSecret: "w".repeat(32),
  outboundUrl: "http://cdep.example/outbound/send",
  serviceToken: "s".repeat(32),
  controlPlaneUrl: "http://control.example/route",
  progressDelayMs: 60_000,
};

const message: KnoxInboundMessage = {
  schemaVersion: 1,
  eventId: "evt-1",
  messageId: "msg-1",
  occurredAt: "2026-08-02T00:00:00.000Z",
  sender: { knoxUserId: "user.name", displayName: "User" },
  conversation: {
    type: "dm",
    providerType: "SINGLE",
    conversationId: "42",
  },
  message: { type: "text", text: "question" },
};

const lifecycle = {
  admission: "exclusive" as const,
  abortSignal: new AbortController().signal,
  onAdopted: vi.fn(),
  onDeferred: vi.fn(),
  onFailed: vi.fn(),
  onAbandoned: vi.fn(),
};

function installRuntime(run: ReturnType<typeof vi.fn>) {
  setKnoxRuntime({
    config: { current: () => ({}) },
    channel: {
      inbound: {
        buildContext: vi.fn(() => ({})),
        run,
      },
    },
  } as unknown as PluginRuntime);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveRouting.mockResolvedValue({
    status: "resolved",
    agentId: "personal-user",
    sessionKey: "agent:personal-user:main",
    senderLinked: true,
    executionTarget: "platform_server",
  });
});

describe("dispatchKnoxInbound", () => {
  it("returns Gateway draining to durable ingress instead of sending a terminal error", async () => {
    const draining = new Error("Gateway is draining; new tasks are not accepted");
    draining.name = "GatewayDrainingError";
    installRuntime(vi.fn().mockRejectedValue(draining));

    await expect(dispatchKnoxInbound({ account, message, lifecycle })).rejects.toBe(draining);
    expect(sendKnoxOutbound).not.toHaveBeenCalled();
  });

  it("recognizes a wrapped Gateway draining lifecycle error", async () => {
    const draining = new Error("Gateway is draining");
    draining.name = "GatewayDrainingError";
    const wrapped = new Error("agent run failed", { cause: draining });
    installRuntime(vi.fn().mockRejectedValue(wrapped));

    await expect(dispatchKnoxInbound({ account, message, lifecycle })).rejects.toBe(wrapped);
    expect(sendKnoxOutbound).not.toHaveBeenCalled();
  });
});
