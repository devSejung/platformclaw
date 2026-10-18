import { describe, expect, it } from "vitest";
import { captureReplyDispatchDeliveryOutcome, createReplyDispatcher } from "./reply-dispatcher.js";

describe("channel-attested reply visibility", () => {
  it.each([undefined, { visibleReplySent: true }, { visibleReplySent: false }])(
    "preserves the adapter visibility result %j",
    async (result) => {
      const payload = { text: "reply" };
      const outcome = captureReplyDispatchDeliveryOutcome(payload);
      const dispatcher = createReplyDispatcher({ deliver: async () => result });
      expect(dispatcher.sendFinalReply(payload)).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      const invisible = result?.visibleReplySent === false;
      expect(await outcome.promise).toBe(invisible ? "not-visible" : "delivered");
      expect(dispatcher.getCancelledCounts?.().final).toBe(0);
      expect(dispatcher.getFailedCounts().final).toBe(0);
    },
  );

  it.each([
    "cancelled_by_message_sending_hook",
    "empty_after_message_sending_hook",
    "no_visible_payload",
    "no_visible_result",
  ])("preserves intentional native suppression %s as cancellation", async (reason) => {
    const payload = { text: "reply" };
    const outcome = captureReplyDispatchDeliveryOutcome(payload);
    const dispatcher = createReplyDispatcher({
      deliver: async () => ({ visibleReplySent: false, suppression: { reason } }),
    });
    expect(dispatcher.sendFinalReply(payload)).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(await outcome.promise).toBe("cancelled");
    expect(dispatcher.getCancelledCounts?.().final).toBe(1);
    expect(dispatcher.getFailedCounts().final).toBe(0);
  });
});
