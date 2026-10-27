import type { FishingSnapshot } from "./fishing-contracts.js";

export type SqliteFishingState = Pick<
  FishingSnapshot,
  "economyVersion" | "totalCaught" | "totalEarnedGold" | "bestCatch" | "attempt" | "revision"
> & {
  gameplayVersion: 2;
  rewardSeed: number;
  rewardQuote: { GOOD: number; PERFECT: number } | null;
  lastNowAt: number;
  goalDay: number;
  goalWeek: number;
  dailyCaught: number;
  weeklyCaught: number;
};

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
