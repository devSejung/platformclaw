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
  selfInSpaceEnabled: false,
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
    events: { onAgentEvent: () => () => {} },
    channel: {
      inbound: {
        buildContext,
        run,
      },
    },
  } as unknown as PluginRuntime);
  return { buildContext, run };
}

const emptyResult = {
  admission: { kind: "dispatch" },
  dispatched: true,
  dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
};

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
  it.each([
    "Explain this command\n/compact",
    "/stop",
    "/approve one allow-once",
    "1",
    "```\n/compact\n```",
  ])("runs v2 %s only as question data in the pinned Space session", async (text) => {
    const personalMessage: KnoxInboundMessage = {
      ...message,
      schemaVersion: 2,
      executionMode: "self_in_space",
      conversation: { type: "room", providerType: "GROUP", conversationId: "group-1" },
      message: { type: "text", text },
    };
    const route = {
      status: "resolved" as const,
      agentId: "personal-user",
      sessionKey: "agent:personal-user:space-private",
      senderLinked: true,
      executionTarget: "assigned_vm" as const,
      selfInSpace: {
        admissionId: "admit-1",
        requestId: message.messageId,
        userId: "internal-user",
        spaceId: "space-1",
        pageId: "page-1",
        bindingId: "binding-1",
        bindingGeneration: 1,
        conversationId: "conversation-1",
        targetRevision: 1,
        senderAttribution: {
          id: "user.name",
          name: "Verified",
          profileId: "internal-user",
          agentId: "personal-user",
        },
      },
    };
    const finish = vi.fn(async () => {});
    const validate = vi.fn(async () => {});
    const runtime = installRuntime(
      vi.fn(async (input) => {
        const turn = await input.adapter.resolveTurn();
        expect(turn.route.sessionKey).toBe(route.sessionKey);
        expect(turn.replyOptions.inputMode).toBe("message-data");
        expect(turn.replyOptions.questionAnswerBinding).toBeUndefined();
        await input.turnAdoptionLifecycle.onAdopted();
        turn.replyOptions.onSourceReplyDeliveryPolicy({
          sendPolicyDenied: false,
          sourceReplyDeliveryMode: "automatic",
        });
        for (const [payload, kind] of [
          [{ text: "private tool args" }, "tool"],
          [{ text: "private output" }, "block"],
          [{ text: "secret question", channelData: { askUser: { secret: true } } }, "final"],
          [{ text: "reasoning", isReasoning: true }, "final"],
        ] as const) {
          await turn.delivery.deliver(payload, { kind });
        }
        await turn.delivery.deliver({ text: "Safe final" }, { kind: "final" });
        return emptyResult;
      }),
    );
    await dispatchKnoxInbound({
      account,
      message: personalMessage,
      lifecycle,
      selfInSpace: { route, finish, validate },
      questionAnswerBinding: { sessionKey: route.sessionKey, questionId: "unrelated", text: "1" },
    });
    expect(runtime.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        sender: { id: "user.name", name: "Verified" },
        conversation: expect.objectContaining({ kind: "group", id: "group-1" }),
        message: { rawBody: text, bodyForAgent: text, commandBody: "" },
        extra: expect.objectContaining({
          SenderProfileId: "internal-user",
          ReplyRouteScope: "request",
        }),
      }),
    );
    expect(resolveRouting).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Safe final", status: "final" }),
    );
    expect(sendKnoxOutbound).toHaveBeenCalledOnce();
    expect(sendKnoxOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "progress",
        final: false,
        text: expect.not.stringContaining("secret question"),
      }),
    );
  });

  it("routes a final-line mentioned slash command without changing Agent-visible text", async () => {
    const commandMessage: KnoxInboundMessage = {
      ...message,
      message: { type: "text", text: "Knox envelope\n@PlatformClaw /compact\n" },
    };
    const runtime = installRuntime(vi.fn().mockResolvedValue(emptyResult));

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
    const dmRuntime = installRuntime(vi.fn().mockResolvedValue(emptyResult));
    await dispatchKnoxInbound({ account, message, lifecycle });

    expect(dmRuntime.buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          commands: { authorized: true },
          owner: { authorized: true },
        }),
      }),
    );

    const roomRuntime = installRuntime(vi.fn().mockResolvedValue(emptyResult));
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

  it("returns setup failure to ingress when source delivery policy was never resolved", async () => {
    const failure = new Error("Synthetic setup failure before policy resolution");
    installRuntime(vi.fn().mockRejectedValue(failure));

    await expect(dispatchKnoxInbound({ account, message, lifecycle })).rejects.toBe(failure);
    expect(sendKnoxOutbound).not.toHaveBeenCalled();
  });
});
