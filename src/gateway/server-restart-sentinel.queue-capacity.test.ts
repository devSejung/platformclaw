// Real transient admission and SQLite recovery must agree before retiring durable work.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
  type QueuedSessionDeliveryPayload,
} from "../infra/session-delivery-queue.js";
import {
  drainSystemEvents,
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
  SystemEventQueueFullError,
} from "../infra/system-events.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { deliverQueuedSessionDelivery } from "./server-restart-sentinel.js";

const sessionKey = "agent:main:recovery";
const { requestHeartbeat } = vi.hoisted(() => ({ requestHeartbeat: vi.fn() }));
vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat,
}));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: (key: string) => ({
    cfg: {},
    entry: { sessionId: "current-session" },
    canonicalKey: key,
  }),
}));
afterEach(() => {
  resetSystemEventsForTest();
  requestHeartbeat.mockClear();
});

const payloads: QueuedSessionDeliveryPayload[] = [
  { kind: "systemEvent", sessionKey, text: "recover me" },
  { kind: "agentTurn", sessionKey, message: "recover me", messageId: "no-route" },
  {
    kind: "agentTurn",
    sessionKey,
    message: "recover me",
    messageId: "stale-session",
    expectedSessionId: "previous-session",
  },
];

describe("restart recovery queue admission", () => {
  it.each(payloads)("retains $kind/$messageId until admission succeeds", async (payload) => {
    await withTempDir({ prefix: "openclaw-recovery-capacity-" }, async (stateDir) => {
      for (let index = 0; index < 20; index += 1) {
        enqueueSystemEventEntry(`pending ${index}`, { sessionKey });
      }
      const id = await enqueueSessionDelivery(payload, stateDir);
      const onSettled = vi.fn();
      const drain = () =>
        drainPendingSessionDeliveries({
          drainKey: id,
          logLabel: "capacity-test",
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          deliver: (entry) =>
            deliverQueuedSessionDelivery({ deps: {} as CliDeps, entry, stateDir }),
          onSettled,
          selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
        });
      await drain();
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([
        expect.objectContaining({
          id,
          retryCount: 1,
          lastError: new SystemEventQueueFullError().message,
        }),
      ]);
      expect(onSettled).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(drainSystemEvents(sessionKey)).toEqual(
        Array.from({ length: 20 }, (_, index) => `pending ${index}`),
      );

      await drain();
      expect(await loadPendingSessionDeliveries(stateDir)).toEqual([]);
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "recovered");
      expect(peekSystemEvents(sessionKey)).toEqual(["recover me"]);
      expect(requestHeartbeat).toHaveBeenCalledOnce();
    });
  });
  it("records failure after the default five attempts instead of acknowledging undelivered work", async () => {
    await withTempDir({ prefix: "openclaw-recovery-capacity-limit-" }, async (stateDir) => {
      for (let index = 0; index < 20; index += 1) {
        enqueueSystemEventEntry(`pending ${index}`, { sessionKey });
      }
      const id = await enqueueSessionDelivery(
        { kind: "systemEvent", sessionKey, text: "blocked follow-up" },
        stateDir,
      );
      const onSettled = vi.fn();
      const drain = () =>
        drainPendingSessionDeliveries({
          drainKey: id,
          logLabel: "capacity-limit-test",
          stateDir,
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          deliver: (entry) =>
            deliverQueuedSessionDelivery({ deps: {} as CliDeps, entry, stateDir }),
          onSettled,
          selectEntry: (entry) => ({ match: entry.id === id, bypassBackoff: true }),
        });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await drain();
      }
      expect((await loadPendingSessionDeliveries(stateDir))[0]?.retryCount).toBe(5);
      expect(onSettled).not.toHaveBeenCalled();
      await drain();
      expect(getDeliveryQueueEntryStatus("session", id, stateDir)).toBe("failed");
      expect(onSettled).toHaveBeenCalledWith(expect.objectContaining({ id }), "moved-to-failed");
      expect(peekSystemEvents(sessionKey)).toHaveLength(20);
      expect(requestHeartbeat).not.toHaveBeenCalled();
    });
  });
});
