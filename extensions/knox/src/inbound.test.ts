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
  const buildContext = vi.fn(() => ({}));
  setKnoxRuntime({
    config: { current: () => ({}) },
    channel: {
      inbound: {
        buildContext,
        run,
      },
    },
  } as unknown as PluginRuntime);
  return { buildContext, run };
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
  it("routes a final-line mentioned slash command without changing Agent-visible text", async () => {
    const commandMessage: KnoxInboundMessage = {
      ...message,
      message: { type: "text", text: "Knox envelope\n@PlatformClaw /compact\n" },
    };
    const runtime = installRuntime(vi.fn().mockResolvedValue(undefined));

    await dispatchKnoxInbound({ account, message: commandMessage, lifecycle });

    expect(runtime.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          rawBody: commandMessage.message.text,
          commandBody: "/compact",
          bodyForAgent: commandMessage.message.text,
        },
      }),
    );
    const runCall = runtime.run.mock.calls[0]?.[0];
    expect(runCall?.adapter.ingest(commandMessage)).toMatchObject({
      rawText: commandMessage.message.text,
      textForAgent: commandMessage.message.text,
      textForCommands: "/compact",
    });
  });

  it("grants owner authority to linked DMs and every isolated-room participant", async () => {
    const dmRuntime = installRuntime(vi.fn().mockResolvedValue(undefined));
    await dispatchKnoxInbound({ account, message, lifecycle });

    expect(dmRuntime.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          commands: { authorized: true },
          owner: { authorized: true },
        }),
      }),
    );

    const roomRuntime = installRuntime(vi.fn().mockResolvedValue(undefined));
    const roomMessage: KnoxInboundMessage = {
      ...message,
      conversation: {
        ...message.conversation,
        type: "room",
        providerType: "GROUP",
      },
    };
    resolveRouting.mockResolvedValueOnce({
      status: "resolved",
      agentId: "room-agent",
      sessionKey: "agent:room-agent:main",
      senderLinked: false,
      executionTarget: null,
    });
    await dispatchKnoxInbound({ account, message: roomMessage, lifecycle });

    expect(roomRuntime.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          commands: { authorized: false },
          owner: { authorized: true },
        }),
      }),
    );
  });

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
