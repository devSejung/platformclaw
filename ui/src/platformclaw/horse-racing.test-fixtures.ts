import type {
  HorseRaceSnapshot,
  HorseRacingSnapshot,
  HorseBetMarket,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import {
  HORSE_RACING_ALGORITHM_VERSION,
  HORSE_RACING_ANIMATION_VERSION,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import {
  createRacingHorses,
  horseRaceCommitment,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-engine.ts";
import { quoteHorseBet } from "../../../packages/platformclaw-control-plane/src/horse-racing-pricing.ts";
export const now = Date.UTC(2026, 9, 15, 1, 55);
export function snapshot(overrides: Partial<HorseRacingSnapshot> = {}): HorseRacingSnapshot {
  const horses = createRacingHorses("race-11", "test-seed");
  const makeQuote = (market: HorseBetMarket, selection: string[]) => {
    const { odds, numerator, denominator } = quoteHorseBet(horses, market, selection, 50);
    return { market, selection, odds, numerator, denominator };
  };
  const quotes: HorseRaceSnapshot["quotes"] = [];
  for (let index = 0; index < horses.length; index += 1) {
    const horse = horses[index]!;
    quotes.push(makeQuote("win", [horse.id]));
    for (let other = index + 1; other < horses.length; other += 1) {
      quotes.push(makeQuote("quinella", [horse.id, horses[other]!.id]));
      quotes.push(makeQuote("quinella-place", [horse.id, horses[other]!.id]));
    }
  }
  return {
    serverNow: now,
    gold: 100,
    walletRevision: 0,
    nextStartsAt: now + 65 * 60_000,
    recentRaces: [],
    race: {
      id: "race-11",
      startsAt: now + 5 * 60_000,
      opensAt: now - 5 * 60_000,
      closesAt: now + 5 * 60_000 - 60_000,
      endsAt: now + 8 * 60_000,
      status: "betting",
      horses: horses.map((horse) => ({
        ...horse,
        condition: null,
        weight: null,
        winProbability: null,
      })),
      commitment: horseRaceCommitment("race-11", horses, "test-seed"),
      algorithmVersion: HORSE_RACING_ALGORITHM_VERSION,
      animationVersion: HORSE_RACING_ANIMATION_VERSION,
      pricingVersion: "probability-net-3pct-v2",
      revealedSeed: null,
      finishOrder: null,
      positions: horses.map((horse) => ({ horseId: horse.id, position: 0 })),
      quotes,
      totalStake: 0,
      participants: 0,
      myBets: [],
      liveBets: [],
      liveBetCount: 0,
      cancellationReason: null,
    },
    ...overrides,
  };
}
