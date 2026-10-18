import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { describe, expect, it, vi } from "vitest";
import { createKnoxIngress } from "./ingress.js";

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
    const isPendingQuestionReply = vi.fn(async () => true);
    const ingress = createKnoxIngress({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
      isPendingQuestionReply,
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
    expect(monitor.admit).toHaveBeenCalledWith(message, {
      facts: { eventId: "answer-message", laneKey: "room-1:control" },
    });
    isPendingQuestionReply.mockResolvedValue(false);
    expect(
      options?.inspect(message, {
        phase: "claim",
        claimedId: "answer-message",
        claimedLaneKey: "room-1:control",
      }),
    ).toEqual({ eventId: "answer-message", laneKey: "room-1:control" });
  });
});
