// Capacity is admission control: accepted events must survive later bursts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeSelectedSystemEventEntries,
  drainSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  resetSystemEventsForTest,
  SystemEventQueueFullError,
} from "./system-events.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => ({ ...actual.createSubsystemLogger(name), warn }),
  };
});

const sessionKey = "agent:main:burst";
function fillQueue() {
  for (let index = 0; index < 20; index += 1) {
    enqueueSystemEventEntry(`event ${index}`, { sessionKey, contextKey: `source:${index}` });
  }
  return peekSystemEventEntries(sessionKey);
}

beforeEach(() => {
  resetSystemEventsForTest();
  warn.mockClear();
});
afterEach(resetSystemEventsForTest);

describe("system event admission", () => {
  it.each([20, 23, 1_000])("accounts for every event in a %i-event same-session burst", (count) => {
    const admitted = Array.from({ length: count }, (_, index) =>
      enqueueSystemEvent(`event ${index}`, { sessionKey }),
    );
    expect(admitted.filter(Boolean)).toHaveLength(20);
    expect(admitted.filter((accepted) => !accepted)).toHaveLength(count - 20);
    expect(drainSystemEventEntries(sessionKey).map((event) => event.text)).toEqual(
      Array.from({ length: 20 }, (_, index) => `event ${index}`),
    );
    expect(warn).toHaveBeenCalledTimes(count > 20 ? 1 : 0);
  });

  it("rejects strictly without changing pending events or their routing context, then permits retry", () => {
    const pending = fillQueue();
    const options = {
      sessionKey,
      contextKey: "private:overflow",
      deliveryContext: { channel: "telegram", to: "private-recipient" },
    };
    expect(() => enqueueSystemEventEntry("private payload", options)).toThrow(
      SystemEventQueueFullError,
    );
    expect(peekSystemEventEntries(sessionKey)).toEqual(pending);
    expect(isSystemEventContextChanged(sessionKey, "source:19")).toBe(false);
    expect(warn).toHaveBeenCalledWith(new SystemEventQueueFullError().message);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|agent:main/);
    consumeSelectedSystemEventEntries(sessionKey, [{ text: "stale snapshot", ts: 0 }]);
    expect(enqueueSystemEvent("still full", { sessionKey })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      enqueueSystemEventEntry("other session", { sessionKey: "agent:other:main" }),
    ).not.toBeNull();

    consumeSelectedSystemEventEntries(sessionKey, pending.slice(0, 1));
    expect(enqueueSystemEventEntry("private payload", options)?.text).toBe("private payload");
    expect(peekSystemEventEntries(sessionKey).slice(0, 19)).toEqual(pending.slice(1));
    expect(() => enqueueSystemEventEntry("next overflow", { sessionKey })).toThrow(
      SystemEventQueueFullError,
    );
    expect(warn).toHaveBeenCalledTimes(2);
    drainSystemEventEntries(sessionKey);
    expect(enqueueSystemEventEntry("next overflow", { sessionKey })).not.toBeNull();
  });

  it("dedupes and replaces an owned slot at capacity but rejects a new source or route", () => {
    const pending = fillQueue();
    const options = { sessionKey, contextKey: "source:0" };
    expect(enqueueSystemEventEntry("event 0", options)).toBeNull();
    expect(enqueueSystemEventEntry("updated", { ...options, replace: true })?.text).toBe("updated");
    expect(peekSystemEventEntries(sessionKey).slice(0, 19)).toEqual(pending.slice(1));
    for (const rejected of [
      { sessionKey, contextKey: "new-source", replace: true },
      { ...options, replace: true, deliveryContext: { channel: "telegram", to: "another-route" } },
    ]) {
      expect(() => enqueueSystemEventEntry("new event", rejected)).toThrow(
        SystemEventQueueFullError,
      );
    }
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(20);
    expect(isSystemEventContextChanged(sessionKey, "source:0")).toBe(false);
  });
});
