import { afterEach, describe, expect, it } from "vitest";
import { peekSystemEventEntries as peekCoreSystemEventEntries } from "../infra/system-events.js";
import {
  consumeSelectedSystemEventEntries,
  drainSystemEvents,
  enqueueSystemEventEntry,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  resolveSystemEventDeliveryContext,
} from "./system-event-runtime.js";
import { resetSystemEventsForTest } from "./test-fixtures.js";

afterEach(resetSystemEventsForTest);

describe("focused system event runtime", () => {
  it("shares session-scoped producer and consumer state with the core queue", () => {
    const sessionKey = "agent:main:telegram:direct:owner";
    const otherSessionKey = "agent:work:telegram:direct:owner";
    const deliveryContext = { channel: "telegram", to: "123", accountId: "work" };
    const first = enqueueSystemEventEntry("original", {
      sessionKey,
      contextKey: "reaction",
      deliveryContext,
    });
    expect(first).not.toBeNull();
    const inspected = peekSystemEventEntries(sessionKey);
    expect(peekCoreSystemEventEntries(sessionKey)).toEqual(inspected);
    expect(resolveSystemEventDeliveryContext(inspected)).toEqual(deliveryContext);
    expect(isSystemEventContextChanged(sessionKey, "reaction")).toBe(false);

    enqueueSystemEventEntry("other agent", { sessionKey: otherSessionKey });
    enqueueSystemEventEntry("replacement", {
      sessionKey,
      contextKey: "reaction",
      deliveryContext,
      replace: true,
    });
    // A consumer must not acknowledge a newer event using its replaced snapshot.
    expect(consumeSelectedSystemEventEntries(sessionKey, inspected)).toEqual([]);
    expect(drainSystemEvents(sessionKey)).toEqual(["replacement"]);
    expect(hasSystemEvents(sessionKey)).toBe(false);
    expect(drainSystemEvents(otherSessionKey)).toEqual(["other agent"]);
  });
});
