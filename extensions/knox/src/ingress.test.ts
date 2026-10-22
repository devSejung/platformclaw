import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { describe, expect, it, vi } from "vitest";
import { createKnoxIngress } from "./ingress.js";
import * as knoxRuntime from "./runtime.js";

vi.mock("openclaw/plugin-sdk/channel-outbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-outbound")>(
    "openclaw/plugin-sdk/channel-outbound",
  );
  return {
    ...actual,
    createChannelIngressMonitor: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      admit: vi.fn(async () => ({ kind: "durable", queueResult: { duplicate: false } })),
    })),
  };
});

describe("createKnoxIngress", () => {
  it.each([undefined, "self_in_space"] as const)(
    "keeps the real account ID with execution mode %s",
    async (executionMode) => {
      const openChannelIngressQueue = vi.fn(() => ({ has: async () => false }));
      const runtime = vi.spyOn(knoxRuntime, "getKnoxRuntime").mockReturnValue({
        state: { openChannelIngressQueue },
      } as never);
      try {
        const ingress = createKnoxIngress({
          accountId: "default",
          executionMode,
          dispatch: vi.fn(),
        });
        await expect(ingress.has("message-1")).resolves.toBe(false);
        expect(openChannelIngressQueue).toHaveBeenCalledWith({
          accountId: "default",
          sequencedAdmission: true,
          ...(executionMode ? { queueNamespace: "self-in-space-v2" } : {}),
        });
      } finally {
        runtime.mockRestore();
      }
    },
  );

  it("fails closed when the native queue cannot inspect legacy identities", async () => {
    const ingress = createKnoxIngress({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
    });
    await expect(ingress.has("old-message")).rejects.toThrow(
      "requires native ingress identity lookup",
    );
  });

  it("keeps v2 on its pinned personal lane and rejects cross-version replay", async () => {
    const route = {
      status: "resolved" as const,
      agentId: "personal-user",
      sessionKey: "agent:personal-user:space-private",
      senderLinked: true,
      executionTarget: "platform_server" as const,
      selfInSpace: {
        admissionId: "admit-1",
        requestId: "message-1",
        userId: "user-1",
        spaceId: "space-1",
        pageId: "page-1",
        bindingId: "binding-1",
        bindingGeneration: 1,
        conversationId: "conversation-1",
        targetRevision: 1,
        senderAttribution: { id: "person.one", profileId: "user-1", agentId: "personal-user" },
      },
    };
    const message = {
      schemaVersion: 2,
      executionMode: "self_in_space",
      eventId: "event-1",
      messageId: "message-1",
      occurredAt: "2026-10-22T00:00:00.000Z",
      sender: { knoxUserId: "person.one", displayName: "Person" },
      conversation: { type: "room", providerType: "GROUP", conversationId: "room-1" },
      message: { type: "text", text: "Explain\n/stop" },
    } as const;
    const resolveQuestionAnswerBinding = vi.fn();
    const personal = createKnoxIngress({
      accountId: "default",
      executionMode: "self_in_space",
      queue: {} as never,
      dispatch: vi.fn(),
      resolveQuestionAnswerBinding,
      resolveSelfInSpaceRoute: async () => route,
    });
    await personal.admit(message);
    const personalOptions = vi.mocked(createChannelIngressMonitor).mock.calls.at(-1)?.[0];
    const admitted = { ...message, selfInSpaceRoute: route };
    expect(personalOptions?.payload.version).toBe(2);
    expect(personalOptions?.inspect(admitted, { phase: "admission" })).toMatchObject({
      laneKey: route.sessionKey,
    });
    expect(resolveQuestionAnswerBinding).not.toHaveBeenCalled();
    expect(
      personalOptions?.payload.deserialize(JSON.stringify(admitted), {
        claim: { id: message.messageId },
      } as never),
    ).toMatchObject(admitted);
    createKnoxIngress({ accountId: "default", queue: {} as never, dispatch: vi.fn() });
    const legacyOptions = vi.mocked(createChannelIngressMonitor).mock.calls.at(-1)?.[0];
    expect(() =>
      legacyOptions?.payload.deserialize(JSON.stringify(admitted), {
        claim: { id: message.messageId },
      } as never),
    ).toThrow("JSON is invalid");
    expect(() =>
      personalOptions?.payload.deserialize(JSON.stringify(message), {
        claim: { id: message.messageId },
      } as never),
    ).toThrow("JSON is invalid");
  });

  it("keeps detached admission while allowing control commands to repump", () => {
    createKnoxIngress({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
    });

    expect(createChannelIngressMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        runPumpTask: runDetachedWebhookWork,
        waitForDeliveryIdleBeforeRepump: false,
      }),
    );
  });

  it.each(["/stop", "/approve approval-1 allow-once"])(
    "places final-line %s on the control lane",
    (command) => {
      createKnoxIngress({
        accountId: "default",
        queue: {} as never,
        dispatch: vi.fn(),
      });
      const options = vi.mocked(createChannelIngressMonitor).mock.calls.at(-1)?.[0];
      const message = {
        schemaVersion: 1,
        eventId: "event-1",
        messageId: "message-1",
        occurredAt: new Date(0).toISOString(),
        sender: { knoxUserId: "person.one", displayName: "Person One" },
        conversation: { type: "room", providerType: "GROUP", conversationId: "room-1" },
        message: { type: "text", text: `metadata\n@bot ${command}` },
      } as const;
      expect(options?.inspect(message, { phase: "admission" })).toEqual({
        eventId: "message-1",
        laneKey: "room-1:control",
      });
    },
  );

  it("persists a pending question reply's control lane across claim-time resolution", async () => {
    const questionAnswerBinding = {
      sessionKey: "agent:room:main",
      questionId: "ask_one",
      text: "1",
    };
    const resolveQuestionAnswerBinding = vi.fn(async () => questionAnswerBinding);
    const ingress = createKnoxIngress({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
      resolveQuestionAnswerBinding,
    });
    const message = {
      schemaVersion: 1,
      eventId: "answer-event",
      messageId: "answer-message",
      occurredAt: new Date(0).toISOString(),
      sender: { knoxUserId: "person.one", displayName: "Person One" },
      conversation: { type: "room", providerType: "GROUP", conversationId: "room-1" },
      message: { type: "text", text: "1" },
    } as const;
    await ingress.admit(message);
    const options = vi.mocked(createChannelIngressMonitor).mock.calls.at(-1)?.[0];
    const monitor = vi.mocked(createChannelIngressMonitor).mock.results.at(-1)?.value;
    const admitted = { ...message, questionAnswerBinding };
    expect(monitor.admit).toHaveBeenCalledWith(admitted, {
      facts: { eventId: "answer-message", laneKey: "room-1:control" },
    });
    expect(
      options?.inspect(admitted, {
        phase: "claim",
        claimedId: "answer-message",
        claimedLaneKey: "room-1:control",
      }),
    ).toEqual({ eventId: "answer-message", laneKey: "room-1:control" });
    const stored = options?.payload.serialize(admitted, {} as never);
    expect(JSON.parse(stored as string).questionAnswerBinding).toEqual(questionAnswerBinding);
  });
});
