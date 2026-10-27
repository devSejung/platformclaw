import { describe, expect, it } from "vitest";
import type { FishingBehavior, FishingInput } from "./fishing-contracts.js";
import { FISHING_SPECIES, resolveFishingDifficulty } from "./fishing-economy.js";
import {
  FISHING_FIGHT_DURATION_MS,
  FISHING_FINISH_WINDOW_MS,
  fishingHookQuality,
  fishingHookWindowMs,
  fishingFinishPosition,
  resolveFishingFinish,
  replayFishingFight,
} from "./fishing-simulation.js";

function skilledInputs(
  seed: number,
  difficulty: number,
  behavior: FishingBehavior,
): FishingInput[] {
  const inputs = [{ atMs: 0, held: true }];
  let held = true;
  for (let atMs = 100; atMs < FISHING_FIGHT_DURATION_MS; atMs += 100) {
    const state = replayFishingFight(seed, difficulty, inputs, atMs, behavior);
    if (state.status !== "fighting") break;
    if ((held && state.tension > 0.72) || (!held && state.tension < 0.28)) {
      held = !held;
      inputs.push({ atMs, held });
    }
  }
  return inputs;
}

describe("authoritative species fight and finish timing", () => {
  it("grades actual hook timing with one fixed window", () => {
    expect(fishingHookWindowMs()).toBe(1500);
    expect(fishingHookQuality(-101)).toBeNull();
    expect(fishingHookQuality(-100)).toBe("PERFECT");
    expect(fishingHookQuality(100)).toBe("PERFECT");
    expect(fishingHookQuality(101)).toBe("GOOD");
    expect(fishingHookQuality(1500)).toBe("GOOD");
    expect(fishingHookQuality(1501)).toBeNull();
  });

  it.each(FISHING_SPECIES)(
    "$nameKo permits skilled reeling but rejects hold-only and idle",
    (fish) => {
      for (const size of [0, 0.5, 1]) {
        const lengthCm = fish.lengthCm[0] + (fish.lengthCm[1] - fish.lengthCm[0]) * size;
        const difficulty = resolveFishingDifficulty(fish.id, lengthCm);
        const inputs = skilledInputs(307, difficulty, fish.behavior);
        expect(inputs.length).toBeLessThan(16);
        expect(replayFishingFight(307, difficulty, inputs, 7000, fish.behavior)).toMatchObject({
          status: "caught",
          escapeReason: null,
        });
        expect(
          replayFishingFight(307, difficulty, [{ atMs: 0, held: true }], 7000, fish.behavior),
        ).toMatchObject({ status: "escaped", escapeReason: "line_broken" });
        expect(replayFishingFight(307, difficulty, [], 7000, fish.behavior)).toMatchObject({
          status: "escaped",
          escapeReason: "slack",
        });
      }
    },
  );

  it("requires faster tension control for difficult species with the same behavior", () => {
    const inputs = [{ atMs: 0, held: true }];
    const easy = replayFishingFight(7, 1, inputs, 1000, "steady");
    const hard = replayFishingFight(7, 10, inputs, 1000, "steady");
    expect(hard.tension).toBeGreaterThan(easy.tension);
    expect(hard.progress).toBeLessThan(easy.progress);
    expect(replayFishingFight(7, 10, inputs, 7000, "steady").elapsedMs).toBeLessThan(
      replayFishingFight(7, 1, inputs, 7000, "steady").elapsedMs,
    );
  });

  it("records timeout only when a taut line fails to bring the fish in within seven seconds", () => {
    const inputs: FishingInput[] = [];
    let held = false;
    for (let atMs = 100; atMs < FISHING_FIGHT_DURATION_MS; atMs += 100) {
      const state = replayFishingFight(7, 3, inputs, atMs, "steady");
      expect(state.status).toBe("fighting");
      if ((held && state.tension > 0.14) || (!held && state.tension < 0.07)) {
        held = !held;
        inputs.push({ atMs, held });
      }
    }
    expect(replayFishingFight(7, 3, inputs, 7000, "steady")).toMatchObject({
      status: "escaped",
      escapeReason: "timeout",
    });
  });

  it("produces identical bounded outcomes across 15, 30, 60 and 144 display frames per second", () => {
    const inputs = skilledInputs(317, 7, "deep");
    const expected = replayFishingFight(317, 7, inputs, 7000, "deep");
    for (const fps of [15, 30, 60, 144]) {
      for (let atMs = 0; atMs < 7000; atMs += 1000 / fps) {
        const state = replayFishingFight(317, 7, inputs, atMs, "deep");
        expect(Number.isFinite(state.tension)).toBe(true);
        expect(state.tension).toBeGreaterThanOrEqual(0);
        expect(state.tension).toBeLessThanOrEqual(1);
      }
      expect(replayFishingFight(317, 7, inputs, 7000, "deep")).toEqual(expected);
    }
  });

  it("bounds replay work and rejects impossible timelines and difficulty", () => {
    expect(() =>
      replayFishingFight(
        1,
        1,
        [
          { atMs: 200, held: true },
          { atMs: 100, held: false },
        ],
        7000,
        "steady",
      ),
    ).toThrow();
    expect(() => replayFishingFight(1, 1, [{ atMs: 7001, held: true }], 7000, "steady")).toThrow();
    expect(() =>
      replayFishingFight(
        1,
        1,
        Array.from({ length: 49 }, (_, atMs) => ({ atMs, held: true })),
        7000,
        "steady",
      ),
    ).toThrow();
    expect(() => replayFishingFight(1, 1, [], -1, "steady")).toThrow();
    expect(() => replayFishingFight(1, 0, [], 7000, "steady")).toThrow();
    expect(() => replayFishingFight(1, 11, [], 7000, "steady")).toThrow();
    expect(replayFishingFight(1, 1, [], Number.MAX_SAFE_INTEGER, "steady")).toEqual(
      replayFishingFight(1, 1, [], 7000, "steady"),
    );
  });

  it("gives species five distinct pulling rhythms for the same difficulty and seed", () => {
    const behaviors: FishingBehavior[] = ["steady", "dart", "surge", "deep", "ancient"];
    const tensions = behaviors.map(
      (behavior) => replayFishingFight(307, 5, [{ atMs: 0, held: true }], 1000, behavior).tension,
    );
    expect(new Set(tensions).size).toBe(5);
  });

  it("moves the finish marker continuously through both turnarounds", () => {
    expect(fishingFinishPosition(0, 0)).toBe(0);
    expect(fishingFinishPosition(0, 600)).toBe(0.5);
    expect(fishingFinishPosition(0, 1200)).toBe(1);
    expect(fishingFinishPosition(0, 1800)).toBe(0.5);
    expect(fishingFinishPosition(0, 2400)).toBe(0);
    expect(Math.abs(fishingFinishPosition(0, 1199) - fishingFinishPosition(0, 1201))).toBeLessThan(
      0.002,
    );
    expect(fishingFinishPosition(731, 333)).toBeCloseTo(fishingFinishPosition(731, 2733), 10);
  });

  it("awards center accuracy once and gives a missed or expired finish the base multiplier", () => {
    expect(FISHING_FINISH_WINDOW_MS).toBe(4000);
    expect(resolveFishingFinish(0, 600)).toEqual({
      position: 0.5,
      accuracy: 1,
      bonusMultiplier: 2,
    });
    expect(resolveFishingFinish(0, 0)).toEqual({ position: 0, accuracy: 0, bonusMultiplier: 1 });
    expect(resolveFishingFinish(0, 300)).toEqual({
      position: 0.25,
      accuracy: 0.5,
      bonusMultiplier: 1.5,
    });
    expect(resolveFishingFinish(200, 4000)).toMatchObject({ accuracy: 0, bonusMultiplier: 1 });
    expect(resolveFishingFinish(0, -1)).toMatchObject({ accuracy: 0, bonusMultiplier: 1 });
    expect(() => resolveFishingFinish(0, Number.NaN)).toThrow();
  });
});
