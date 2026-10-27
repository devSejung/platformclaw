import type { FishingSnapshot } from "./fishing-contracts.js";

export type SqliteFishingState = Pick<
  FishingSnapshot,
  "economyVersion" | "totalCaught" | "totalEarnedGold" | "bestCatch" | "attempt" | "revision"
> & {
  gameplayVersion: 2;
  rewardSeed: number;
  rewardQuote: { GOOD: number; PERFECT: number } | null;
  speciesRecords: Record<string, { count: number; bestLengthCm: number; bestWeightKg: number }>;
  /** False means historical per-species counts are only confirmed lower bounds. */
  speciesRecordsComplete: boolean;
  lastNowAt: number;
  goalDay: number;
  goalWeek: number;
  dailyCaught: number;
  weeklyCaught: number;
};

export function mergeFishingSpeciesRecord(
  records: SqliteFishingState["speciesRecords"],
  fish: NonNullable<FishingSnapshot["bestCatch"]>,
  count: number,
): void {
  const prior = records[fish.fishId];
  // Length and weight records can come from different catches. Neither maximum
  // may be discarded merely because the other catch is longer or heavier.
  records[fish.fishId] = {
    count: (prior?.count ?? 0) + count,
    bestLengthCm: Math.max(prior?.bestLengthCm ?? 0, fish.lengthCm),
    bestWeightKg: Math.max(prior?.bestWeightKg ?? 0, fish.weightKg),
  };
}

export function selectFishingBestCatch(
  current: FishingSnapshot["bestCatch"],
  candidate: NonNullable<FishingSnapshot["bestCatch"]>,
): NonNullable<FishingSnapshot["bestCatch"]> {
  if (
    current &&
    (candidate.lengthCm < current.lengthCm ||
      (candidate.lengthCm === current.lengthCm && candidate.weightKg <= current.weightKg))
  ) {
    return current;
  }
  return { fishId: candidate.fishId, lengthCm: candidate.lengthCm, weightKg: candidate.weightKg };
}
