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
      admit: vi.fn(),
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

  it("places a final-line stop command on the control lane", () => {
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
      message: { type: "text", text: "metadata\n@bot /stop" },
    } as const;
    expect(options?.inspect(message, { phase: "admission" })).toEqual({
      eventId: "message-1",
      laneKey: "room-1:control",
    });
  });
});
