import economyData from "./data/economy/fishing.json" with { type: "json" };
import type {
  FishingBehavior,
  FishingCatch,
  FishingQuality,
  FishingRarity,
} from "./fishing-contracts.js";

type FishingSpecies = {
  id: string;
  nameKo: string;
  rarity: FishingRarity;
  probabilityWeight: number;
  basePrice: number;
  difficulty: number;
  lengthCm: [number, number];
  weightKg: [number, number];
  behavior: FishingBehavior;
};
// Version-controlled product data is bundled identically for display and server settlement.
export const FISHING_SPECIES = economyData.fish as FishingSpecies[];
export const FISHING_TOTAL_WEIGHT = FISHING_SPECIES.reduce(
  (total, fish) => total + fish.probabilityWeight,
  0,
);
export const FISHING_MAX_INPUTS = 48;

export function getFishingSpecies(id: string): FishingSpecies {
  const species = FISHING_SPECIES.find((fish) => fish.id === id);
  if (!species) {
    throw new Error("Unknown fishing species");
  }
  return species;
}

/** Species sets the midpoint baseline; larger individuals require quicker tension control. */
export function resolveFishingDifficulty(fishId: string, lengthCm: number): number {
  if (!Number.isFinite(lengthCm)) {
    throw new Error("Fishing length must be finite");
  }
  const fish = getFishingSpecies(fishId);
  const size = Math.max(
    0,
    Math.min(1, (lengthCm - fish.lengthCm[0]) / (fish.lengthCm[1] - fish.lengthCm[0])),
  );
  return Math.max(1, Math.min(10, fish.difficulty - 2 + Math.round(size * 4)));
}

export function calculateFishingRewardGold(
  basePrice: number,
  size: number,
  quality: FishingQuality,
): number {
  if (!Number.isFinite(size) || size < 0 || size > 1) {
    throw new Error("Fishing size must be normalized to [0, 1]");
  }
  // Percentage coefficients avoid shifting exact half-G boundaries below the intended rounding threshold.
  // Fractional base values preserve species ordering, with at least 1 G for every successful catch.
  return Math.max(
    1,
    Math.round((basePrice * (85 + 30 * size) * (quality === "PERFECT" ? 110 : 100)) / 10_000),
  );
}

export function chooseFishingCatch(
  random: () => number,
  quality: FishingQuality,
): Omit<FishingCatch, "id" | "caughtAt" | "accuracy" | "bonusMultiplier"> {
  let draw = sampleFishingRandom(random) * FISHING_TOTAL_WEIGHT;
  for (const fish of FISHING_SPECIES) {
    draw -= fish.probabilityWeight;
    if (draw < 0) {
      const size = sampleFishingRandom(random);
      return {
        fishId: fish.id,
        lengthCm:
          Math.round((fish.lengthCm[0] + (fish.lengthCm[1] - fish.lengthCm[0]) * size) * 10) / 10,
        weightKg:
          Math.round(
            (fish.weightKg[0] + (fish.weightKg[1] - fish.weightKg[0]) * size ** 3) * 1_000,
          ) / 1_000,
        rewardGold: calculateFishingRewardGold(fish.basePrice, size, quality),
        quality,
      };
    }
  }
  throw new Error("Fishing probability weights must select a species");
}

/** The finish bonus applies once to the displayed base catch reward; timeout accuracy is zero. */
export function calculateFishingFinishRewardGold(baseGold: number, accuracy: number): number {
  if (
    !Number.isSafeInteger(baseGold) ||
    baseGold < 0 ||
    !Number.isFinite(accuracy) ||
    accuracy < 0 ||
    accuracy > 1
  ) {
    throw new Error("Invalid fishing base reward or finish accuracy");
  }
  const rewardGold = Math.round(baseGold * (1 + accuracy));
  if (!Number.isSafeInteger(rewardGold)) {
    throw new Error("Fishing reward exceeds the safe integer range");
  }
  return rewardGold;
}

function sampleFishingRandom(random: () => number): number {
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new Error("Fishing random samples must be in [0, 1)");
  }
  return sample;
}

/** Replay RNG only; reward seeds are generated and retained by the server. */
export function createFishingRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
