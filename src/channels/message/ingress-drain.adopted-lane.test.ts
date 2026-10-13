import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";
type Lifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("adopted ingress lane occupancy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it.each(["release", "hold"] as const)(
    "tombstones at adoption with %s lane occupancy",
    async (occupancy) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        const gate = createDeferred<void>();
        const started: string[] = [];
        await queue.enqueue("first", { text: "first" }, { laneKey: "room" });
        const drain = createChannelIngressDrain<Payload>({
          queue,
          ...(occupancy === "hold" ? { adoptedLaneOccupancy: occupancy } : {}),
          dispatchClaimedEvent: async (event, lifecycle) => {
            started.push(event.id);
            await lifecycle.onAdopted();
            if (event.id === "first") {
              await gate.promise;
            }
          },
        });
        try {
          await drain.drainOnce();
          await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
          expect((await queue.enqueue("first", { text: "duplicate" })).kind).toBe("completed");
          expect(drain.activeLaneKeys().has("room")).toBe(occupancy === "hold");
          await queue.enqueue("second", { text: "second" }, { laneKey: "room" });
          await queue.enqueue("stop", { text: "/stop" }, { laneKey: "room:control" });
          await queue.enqueue("other", { text: "other" }, { laneKey: "other-room" });
          expect((await drain.drainOnce()).started).toBe(occupancy === "hold" ? 2 : 3);
          expect(started).toContain("stop");
          expect(started).toContain("other");
          expect(started.includes("second")).toBe(occupancy === "release");
          gate.resolve();
          await drain.waitForIdle();
          if (occupancy === "hold") {
            await drain.drainOnce();
          }
          await drain.waitForIdle();
          expect(started.filter((id) => id === "first")).toHaveLength(1);
          expect(started.filter((id) => id === "second")).toHaveLength(1);
          expect(drain.activeLaneKeys().size).toBe(0);
        } finally {
          gate.resolve();
          drain.dispose();
        }
      });
    },
  );

  it.each(["throw", "timeout", "abort"])(
    "releases an adopted lane after delivery %s",
    async (outcome) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        const started: string[] = [];
        const drain = createChannelIngressDrain<Payload>({
          queue,
          adoptedLaneOccupancy: "hold",
          dispatchClaimedEvent: async (event, lifecycle) => {
            started.push(event.id);
            await lifecycle.onAdopted();
            if (event.id === "first") {
              throw Object.assign(new Error(outcome), {
                name:
                  outcome === "timeout"
                    ? "TimeoutError"
                    : outcome === "abort"
                      ? "AbortError"
                      : "Error",
              });
            }
          },
        });
        try {
          await queue.enqueue("first", { text: "first" }, { laneKey: "room" });
          await queue.enqueue("second", { text: "second" }, { laneKey: "room" });
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(drain.activeLaneKeys().size).toBe(0);
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(started).toEqual(["first", "second"]);
          expect(await queue.listClaims()).toEqual([]);
        } finally {
          drain.dispose();
        }
      });
    },
  );

  it("keeps a wedged tombstone owned after delivery returns", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("first", { text: "first" }, { laneKey: "room" });
      queue.complete = async () => {
        throw new Error("synthetic storage failure");
      };
      const dispatch = vi.fn(async (_event: unknown, lifecycle: Lifecycle) => {
        await lifecycle.onAdopted();
      });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        adoptedLaneOccupancy: "hold",
        dispatchClaimedEvent: dispatch,
      });
      try {
        await drain.drainOnce();
        for (let attempt = 0; attempt < 8; attempt++) {
          await vi.advanceTimersByTimeAsync(180_000);
        }
        await drain.waitForIdle();
        expect(drain.activeLaneKeys().has("room")).toBe(true);
        expect(await queue.listClaims()).toHaveLength(1);
        await drain.drainOnce();
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        drain.dispose();
      }
    });
  });

  it("releases a pre-adoption timeout and fences late cleanup from the next owner", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const firstGate = createDeferred<void>();
      const secondGate = createDeferred<void>();
      const started: string[] = [];
      let firstReturned = false;
      await queue.enqueue("first", { text: "first" }, { laneKey: "room" });
      await queue.enqueue("second", { text: "second" }, { laneKey: "room" });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        adoptedLaneOccupancy: "hold",
        adoptionStallTimeoutMs: 100,
        dispatchClaimedEvent: async (event, lifecycle) => {
          started.push(event.id);
          if (event.id === "first") {
            // Uncooperative handler returns after its watchdog retired the claim.
            await firstGate.promise;
            firstReturned = true;
            await lifecycle.onAdopted();
          } else {
            await lifecycle.onAdopted();
            await secondGate.promise;
          }
        },
      });
      try {
        await drain.drainOnce();
        await vi.advanceTimersByTimeAsync(100);
        expect(drain.activeLaneKeys().size).toBe(0);
        expect((await queue.listFailed?.())?.map(({ reason }) => reason)).toEqual([
          "handler-timeout",
        ]);
        expect((await drain.drainOnce()).started).toBe(1);
        expect(started).toEqual(["first", "second"]);
        firstGate.resolve();
        await vi.waitFor(() => expect(firstReturned).toBe(true));
        expect(drain.activeLaneKeys().has("room")).toBe(true);
        secondGate.resolve();
        await drain.waitForIdle();
        expect(drain.activeLaneKeys().size).toBe(0);
      } finally {
        firstGate.resolve();
        secondGate.resolve();
        drain.dispose();
      }
    });
  });

  it("cleans late adoption after a deferred dispatch has already returned", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const adopted = createDeferred<() => void | Promise<void>>();
      await queue.enqueue("first", { text: "first" }, { laneKey: "room" });
      const drain = createChannelIngressDrain<Payload>({
        queue,
        adoptedLaneOccupancy: "hold",
        dispatchClaimedEvent: (_event, lifecycle) => {
          adopted.resolve(lifecycle.onAdopted);
          return { kind: "deferred" };
        },
      });
      try {
        await drain.drainOnce();
        await drain.waitForIdle();
        expect(drain.activeLaneKeys().has("room")).toBe(true);
        await (
          await adopted.promise
        )();
        expect(drain.activeLaneKeys().size).toBe(0);
      } finally {
        drain.dispose();
      }
    });
  });

  it("recovers pending originals after restart without replaying an adopted run", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      const gate = createDeferred<void>();
      const started: string[] = [];
      await queue.enqueue("first", { text: "first" }, { laneKey: "room" });
      await queue.enqueue("second", { text: "second" }, { laneKey: "room" });
      const first = createChannelIngressDrain<Payload>({
        queue,
        adoptedLaneOccupancy: "hold",
        dispatchClaimedEvent: async (event, lifecycle) => {
          started.push(event.id);
          await lifecycle.onAdopted();
          await gate.promise;
        },
      });
      await first.drainOnce();
      await vi.waitFor(async () => expect(await queue.listClaims()).toEqual([]));
      first.dispose();
      const second = createChannelIngressDrain<Payload>({
        queue,
        adoptedLaneOccupancy: "hold",
        dispatchClaimedEvent: async (event, lifecycle) => {
          started.push(event.id);
          await lifecycle.onAdopted();
        },
      });
      try {
        await second.drainOnce();
        await second.waitForIdle();
        expect(started).toEqual(["first", "second"]);
        expect((await queue.enqueue("first", { text: "duplicate" })).kind).toBe("completed");
      } finally {
        gate.resolve();
        first.dispose();
        second.dispose();
      }
    });
  });
});
