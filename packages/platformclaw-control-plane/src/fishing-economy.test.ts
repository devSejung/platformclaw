import { describe, expect, it } from "vitest";
import { FISHING_ECONOMY_VERSION } from "./fishing-contracts.js";
import {
  FISHING_SPECIES,
  FISHING_TOTAL_WEIGHT,
  chooseFishingCatch,
  createFishingRandom,
  calculateFishingRewardGold,
  calculateFishingFinishRewardGold,
  getFishingSpecies,
  resolveFishingDifficulty,
} from "./fishing-economy.js";
import { resolveFishingFinish } from "./fishing-simulation.js";

describe("single-pool fishing economy", () => {
  it("keeps forty species and normalized integer weights after reducing rewards", () => {
    expect(FISHING_ECONOMY_VERSION).toBe(1);
    expect(FISHING_SPECIES).toHaveLength(40);
    expect(new Set(FISHING_SPECIES.map((fish) => fish.id)).size).toBe(40);
    expect(FISHING_TOTAL_WEIGHT).toBe(40_000);
    const mean = FISHING_SPECIES.reduce(
      (sum, fish) => sum + (fish.basePrice * fish.probabilityWeight) / FISHING_TOTAL_WEIGHT,
      0,
    );
    expect(mean).toBeCloseTo(15.4905, 8);
    for (const fish of FISHING_SPECIES) {
      expect(fish.probabilityWeight).toBeGreaterThan(0);
      expect(Number.isInteger(fish.probabilityWeight)).toBe(true);
      expect(fish.basePrice).toBeGreaterThan(0);
      expect(Number.isInteger(fish.difficulty)).toBe(true);
      expect(fish.difficulty).toBeGreaterThanOrEqual(1);
      expect(fish.difficulty).toBeLessThanOrEqual(10);
      expect(fish.lengthCm[1]).toBeGreaterThan(fish.lengthCm[0]);
      expect(fish.weightKg[1]).toBeGreaterThan(fish.weightKg[0]);
    }
    expect(getFishingSpecies("crucian").probabilityWeight / FISHING_TOTAL_WEIGHT).toBe(0.06);
    expect(getFishingSpecies("legendary-carp").probabilityWeight / FISHING_TOTAL_WEIGHT).toBe(
      0.0005,
    );
  });

  it("keeps the base catch reward tied to size and hook quality", () => {
    const basePrice = getFishingSpecies("legendary-carp").basePrice;
    expect(calculateFishingRewardGold(basePrice, 0, "GOOD")).toBe(187);
    expect(calculateFishingRewardGold(basePrice, 1, "GOOD")).toBe(253);
    expect(calculateFishingRewardGold(basePrice, 0.5, "PERFECT")).toBe(242);
    expect(calculateFishingRewardGold(110, 1, "GOOD")).toBe(127);
    expect(calculateFishingRewardGold(getFishingSpecies("minnow").basePrice, 0, "GOOD")).toBe(1);
    const largest = calculateFishingRewardGold(
      getFishingSpecies("ancient-leviathan").basePrice,
      1,
      "PERFECT",
    );
    expect(calculateFishingFinishRewardGold(largest, 1)).toBe(4554);
    expect(() => calculateFishingRewardGold(12, Number.NaN, "GOOD")).toThrow();
    expect(() => calculateFishingRewardGold(12, 1.01, "GOOD")).toThrow();
  });

  it("makes a larger individual no easier and gives every species a meaningful size increase", () => {
    for (const fish of FISHING_SPECIES) {
      const levels = Array.from({ length: 11 }, (_, index) => {
        const length = fish.lengthCm[0] + ((fish.lengthCm[1] - fish.lengthCm[0]) * index) / 10;
        return resolveFishingDifficulty(fish.id, length);
      });
      expect(levels).toEqual(levels.toSorted((left, right) => left - right));
      expect(levels.at(-1)).toBeGreaterThan(levels[0]!);
      expect(levels[5]).toBe(fish.difficulty);
      expect(levels.every((level) => Number.isInteger(level) && level >= 1 && level <= 10)).toBe(
        true,
      );
    }
    expect(() => resolveFishingDifficulty("crucian", Number.NaN)).toThrow();
  });

  it.each([
    ["crucian", 1, 1, 2],
    ["minnow", 1, 1, 2],
    ["bass", 4, 5, 10],
    ["catfish", 9, 9, 18],
    ["tuna", 35, 39, 78],
    ["legendary-carp", 220, 242, 484],
    ["ancient-leviathan", 1800, 1980, 3960],
  ] as const)(
    "quotes midpoint %s rewards at the current balance",
    (fishId, good, perfect, maximum) => {
      const fish = getFishingSpecies(fishId);
      expect(calculateFishingRewardGold(fish.basePrice, 0.5, "GOOD")).toBe(good);
      expect(calculateFishingRewardGold(fish.basePrice, 0.5, "PERFECT")).toBe(perfect);
      expect(calculateFishingFinishRewardGold(perfect, 1)).toBe(maximum);
    },
  );

  it("keeps valuable fish harder than cheaper common fish and price progression monotone within a rarity", () => {
    for (const fish of FISHING_SPECIES) {
      for (const other of FISHING_SPECIES.filter(
        (candidate) => candidate.basePrice < fish.basePrice,
      )) {
        if (fish.rarity === other.rarity) {
          expect(fish.difficulty).toBeGreaterThanOrEqual(other.difficulty);
        }
        if (fish.rarity !== "common" && other.rarity === "common") {
          expect(fish.difficulty).toBeGreaterThan(other.difficulty);
        }
      }
    }
  });

  it("draws every species from its own interval without rounding away rare weights", () => {
    let boundary = 0;
    for (const fish of FISHING_SPECIES) {
      const samples = [(boundary + fish.probabilityWeight / 2) / FISHING_TOTAL_WEIGHT, 0.5];
      const caught = chooseFishingCatch(() => samples.shift()!, "PERFECT");
      expect(caught.fishId).toBe(fish.id);
      expect(caught.rewardGold).toBe(Math.max(1, Math.round((fish.basePrice * 110) / 100)));
      expect(caught.lengthCm).toBe(
        Math.round(((fish.lengthCm[0] + fish.lengthCm[1]) / 2) * 10) / 10,
      );
      boundary += fish.probabilityWeight;
    }
    expect(chooseFishingCatch(() => 0, "GOOD").fishId).toBe("crucian");
    expect(chooseFishingCatch(() => 1 - Number.EPSILON, "GOOD").fishId).toBe("ancient-leviathan");
    expect(() => chooseFishingCatch(() => 1, "GOOD")).toThrow();
    expect(() => chooseFishingCatch(() => -0.1, "GOOD")).toThrow();
  });

  it("replays private draws identically while hook quality only changes the base reward", () => {
    const good = chooseFishingCatch(createFishingRandom(307), "GOOD");
    const perfect = chooseFishingCatch(createFishingRandom(307), "PERFECT");
    expect({ ...good, rewardGold: 0, quality: "GOOD" }).toEqual({
      ...perfect,
      rewardGold: 0,
      quality: "GOOD",
    });
    expect(chooseFishingCatch(createFishingRandom(307), "GOOD")).toEqual(good);
  });

  it("pays between one and two times the displayed base reward, including timeout", () => {
    expect(
      [0, 0.25, 0.5, 0.75, 1].map((accuracy) => calculateFishingFinishRewardGold(120, accuracy)),
    ).toEqual([120, 150, 180, 210, 240]);
    expect(calculateFishingFinishRewardGold(13, 0.5)).toBe(20);
    expect(calculateFishingFinishRewardGold(12, resolveFishingFinish(200, 4000).accuracy)).toBe(12);
    expect(() => calculateFishingFinishRewardGold(12, 1.01)).toThrow();
    expect(() => calculateFishingFinishRewardGold(12, Number.NaN)).toThrow();
    expect(() => calculateFishingFinishRewardGold(-1, 0)).toThrow();
  });

  it("matches the unified expected price within three percent over 400000 seeded catches", () => {
    const random = createFishingRandom(20261027);
    let gold = 0;
    for (let index = 0; index < 400_000; index += 1) {
      const caught = chooseFishingCatch(random, "GOOD");
      gold += getFishingSpecies(caught.fishId).basePrice;
    }
    expect(Math.abs(gold / 400_000 / 15.4905 - 1)).toBeLessThan(0.03);
  });
});
