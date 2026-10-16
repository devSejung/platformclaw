import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballPlateAppearanceResult,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import type { Pitch } from "./easter-egg-simulation.ts";
import "./easter-egg-game.ts";
import { PLATFORMCLAW_EASTER_EGG_EVENT } from "./easter-egg.ts";

type AnimationGame = HTMLElement & {
  client: { request<T>(method: string, params?: unknown): Promise<T> };
  now: () => number;
  random: () => number;
  preferenceScope: string;
  updateComplete: Promise<unknown>;
  animationFrame: number;
  phase: string;
  pitch: Pitch;
  pitchElapsedMs: number;
  pendingMutation: unknown;
  resumeGameTime: () => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(game: AnimationGame): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await game.updateComplete;
  }
}

const progress: BaseballProgress = {
  gold: 0,
  ownedBatIds: ["wood"],
  equippedBatId: "wood",
  enhancement: { level: 0, status: "ready", equipped: true, version: 1 },
  totalHomers: 0,
  bestDistanceM: 0,
  currentHomeRunStreak: 0,
  bestHomeRunStreak: 0,
  revision: 0,
};

describe("baseball animation frame ownership", () => {
  let frames: Map<number, FrameRequestCallback>;
  let peakFrames: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    frames = new Map();
    peakFrames = 0;
    let nextHandle = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const handle = ++nextHandle;
      frames.set(handle, callback);
      peakFrames = Math.max(peakFrames, frames.size);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => frames.delete(handle));
    vi.stubGlobal("localStorage", createStorageMock());
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function openGame() {
    const game = document.createElement("platformclaw-easter-egg") as AnimationGame;
    const receipts: ReturnType<typeof deferred<BaseballPlateAppearanceResult>>[] = [];
    let issued = 0;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === BASEBALL_RPC.progress) {
        return progress;
      }
      if (method === BASEBALL_RPC.leaderboard) {
        return { distance: [], homeRunStreak: [] };
      }
      if (method === BASEBALL_RPC.beginAtBat) {
        return {
          id: `synthetic-animation-round-${++issued}`,
          pitchSample: 0.1171875,
          batId: "wood",
          enhancementLevel: 0,
          powerRuleVersion: "sweetspot-v1",
          issuedAt: Date.now(),
          expiresAt: Number.MAX_SAFE_INTEGER,
        };
      }
      if (method === BASEBALL_RPC.plateAppearance) {
        const receipt = deferred<BaseballPlateAppearanceResult>();
        receipts.push(receipt);
        return receipt.promise;
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    game.client = {
      request: async <T>(method: string, params?: unknown) => (await request(method, params)) as T,
    };
    game.now = () => Date.now();
    game.random = () => 0;
    game.preferenceScope = "synthetic-animation-account";
    document.body.append(game);
    await flush(game);
    window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
    await flush(game);
    game.querySelector<HTMLButtonElement>('[data-game-choice="baseball"]')!.click();
    await flush(game);

    const frame = async (deltaMs: number) => {
      await vi.advanceTimersByTimeAsync(deltaMs);
      // WHATWG removes each consumed callback before invoking it; new frames wait for the next turn.
      const currentFrameHandles = [...frames.keys()];
      for (const handle of currentFrameHandles) {
        const callback = frames.get(handle);
        if (callback) {
          frames.delete(handle);
          callback(Date.now());
        }
      }
      await flush(game);
    };
    return { game, request, receipts, frame };
  }

  it.each(["unswung miss", "completed batted ball"] as const)(
    "restarts exactly one frame after an asynchronous receipt for %s",
    async (ending) => {
      const { game, request, receipts, frame } = await openGame();
      expect(frames.size).toBe(1);
      await frame(710);
      expect(game.phase).toBe("pitch");
      if (ending === "unswung miss") {
        await frame(game.pitch.idealContactTimeMs + 101);
      } else {
        await frame(game.pitch.idealContactTimeMs);
        window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", cancelable: true }));
        expect(game.phase).toBe("in-play");
        for (let elapsed = 0; elapsed < 10_000 && game.phase === "in-play"; elapsed += 100) {
          await frame(100);
        }
      }
      expect(game.phase).toBe("result");
      expect(receipts).toHaveLength(1);
      expect(game.pendingMutation).not.toBeNull();
      expect(frames.size).toBe(0);
      expect(game.animationFrame).toBe(0);
      game.resumeGameTime();
      expect(frames.size).toBe(0);

      receipts[0]!.resolve({ awardedGold: 0, progress: { ...progress, revision: 1 } });
      await flush(game);
      expect(game.pendingMutation).toBeNull();
      expect(frames.size).toBe(1);
      for (let index = 0; index < 3; index += 1) {
        game.resumeGameTime();
      }
      expect(frames.size).toBe(1);
      await frame(650);
      await frame(710);
      expect(game.phase).toBe("pitch");
      const ball = game.querySelector<HTMLElement>(".platformclaw-easter-egg__projectile")!;
      const launchTransform = ball.style.transform;
      await frame(120);
      expect(game.pitchElapsedMs).toBeGreaterThan(0);
      expect(ball.style.transform).not.toBe(launchTransform);
      expect(
        request.mock.calls.filter(([method]) => method === BASEBALL_RPC.beginAtBat),
      ).toHaveLength(2);
      expect(
        request.mock.calls.filter(([method]) => method === BASEBALL_RPC.plateAppearance),
      ).toHaveLength(1);
      expect(peakFrames).toBe(1);
      game.remove();
      expect(frames.size).toBe(0);
      await frame(10_000);
      expect(frames.size).toBe(0);
    },
  );

  it("does not restart frames or round timers when a receipt arrives after disconnect", async () => {
    const { game, request, receipts, frame } = await openGame();
    await frame(710);
    await frame(game.pitch.idealContactTimeMs + 101);
    expect(receipts).toHaveLength(1);
    game.remove();
    expect(frames.size).toBe(0);
    receipts[0]!.resolve({ awardedGold: 0, progress: { ...progress, revision: 1 } });
    await flush(game);
    await frame(10_000);
    expect(frames.size).toBe(0);
    expect(game.animationFrame).toBe(0);
    expect(
      request.mock.calls.filter(([method]) => method === BASEBALL_RPC.beginAtBat),
    ).toHaveLength(1);
    expect(peakFrames).toBe(1);
  });
});
