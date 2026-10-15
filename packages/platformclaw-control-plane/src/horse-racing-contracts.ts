export const HORSE_RACING_ALGORITHM_VERSION = "sha256-fixed-profile-joker-v4";
export const HORSE_RACING_JOKER_ID = "6";
export const HORSE_RACING_PRICING_VERSION = "probability-net-3pct-v2";
export const HORSE_RACING_MIN_BET_GOLD = 50;
export const HORSE_RACING_MAX_BET_GOLD = 1_000;
export const HORSE_RACING_FEE_PERCENT = 3;
export const HORSE_RACING_ANIMATION_VERSION = "seeded-pace-stumble-v2";
export const HORSE_RACING_RPC = {
  snapshot: "platformclaw.racing.snapshot",
  bet: "platformclaw.racing.bet",
  cancel: "platformclaw.racing.cancel",
} as const;
export const HORSE_RACING_RPC_METHODS = Object.values(HORSE_RACING_RPC);
export type HorseBetMarket = "win" | "quinella" | "quinella-place";
export type HorseRaceStatus =
  | "scheduled"
  | "betting"
  | "locked"
  | "racing"
  | "settled"
  | "cancelled";
export type RacingHorse = {
  id: string;
  name: string;
  color: string;
  speed: number;
  stamina: number;
  condition: number;
  weight: number;
  winProbability: number;
  rumor: string;
};
type HorseRaceEntrant = Omit<RacingHorse, "condition" | "weight" | "winProbability"> & {
  condition: number | null;
  weight: number | null;
  winProbability: number | null;
};
export type HorseRacePosition = {
  horseId: string;
  position: number;
  finishPlace?: number;
  motion?: "fallen" | "recovering";
};
export type HorseRaceQuote = {
  market: HorseBetMarket;
  selection: string[];
  odds: number;
  numerator: string;
  denominator: string;
};
export type HorseBetReceipt = {
  id: string;
  raceId: string;
  market: HorseBetMarket;
  selection: string[];
  amount: number;
  payout: number | null;
  refunded: boolean;
  quotedOdds: number | null;
  potentialPayout: number | null;
  cancelledAt: number | null;
};
export type HorseRaceSnapshot = {
  id: string;
  startsAt: number;
  opensAt: number;
  closesAt: number;
  endsAt: number;
  status: HorseRaceStatus;
  horses: HorseRaceEntrant[];
  commitment: string;
  algorithmVersion: string;
  animationVersion: string;
  revealedSeed: string | null;
  finishOrder: string[] | null;
  positions: HorseRacePosition[];
  pricingVersion: "probability-net-3pct-v2" | "probability-fair-v1" | "pool-v1";
  quotes: HorseRaceQuote[];
  totalStake: number;
  liveBets: {
    id: string;
    displayName: string;
    market: HorseBetMarket;
    selection: string[];
    amount: number;
    placedAt: number;
  }[];
  liveBetCount: number;
  participants: number;
  myBets: HorseBetReceipt[];
  cancellationReason: "insufficient_participants" | "engine_changed" | null;
};
export type HorseRacingSnapshot = {
  serverNow: number;
  gold: number;
  walletRevision: number;
  race: HorseRaceSnapshot | null;
  nextStartsAt: number;
  recentRaces: {
    id: string;
    startsAt: number;
    status: HorseRaceStatus;
    winnerName: string | null;
  }[];
};
export type HorseBetRequest = {
  requestId: string;
  raceId: string;
  market: HorseBetMarket;
  selection: string[];
  amount: number;
};
export type HorseBetResult = { receipt: HorseBetReceipt; snapshot: HorseRacingSnapshot };
export interface HorseRacingStore {
  snapshot(userId: string, now: number, raceId?: string): HorseRacingSnapshot;
  placeBet(userId: string, request: HorseBetRequest, now: number): HorseBetResult;
  cancelBet(userId: string, betId: string, now: number): HorseBetResult;
  advance(now: number): void;
}
export class HorseRacingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HorseRacingError";
  }
}
