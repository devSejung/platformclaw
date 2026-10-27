export const FISHING_ECONOMY_VERSION = 1;
export const FISHING_RPC = {
  snapshot: "platformclaw.fishing.snapshot",
  begin: "platformclaw.fishing.begin",
  hook: "platformclaw.fishing.hook",
  reel: "platformclaw.fishing.reel",
  settle: "platformclaw.fishing.settle",
  finish: "platformclaw.fishing.finish",
  leaderboard: "platformclaw.fishing.leaderboard",
} as const;
export const FISHING_RPC_METHODS = Object.values(FISHING_RPC);
export type FishingRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type FishingBehavior = "steady" | "dart" | "surge" | "deep" | "ancient";
export type FishingQuality = "GOOD" | "PERFECT";
export type FishingInput = { atMs: number; held: boolean };
export type FishingFight = {
  elapsedMs: number;
  tension: number;
  progress: number;
  status: "fighting" | "caught" | "escaped";
  escapeReason: "line_broken" | "slack" | "timeout" | null;
};
export type FishingCatch = {
  id: string;
  fishId: string;
  lengthCm: number;
  weightKg: number;
  rewardGold: number;
  quality: FishingQuality;
  accuracy: number;
  bonusMultiplier: number;
  caughtAt: number;
};
export type FishingAttempt = {
  id: string;
  issuedAt: number;
  biteAt: number;
  hookDeadlineAt: number;
  seed: number;
  phase: "waiting" | "fighting" | "finishing" | "caught" | "escaped" | "missed";
  quality: FishingQuality | null;
  behavior: FishingBehavior | null;
  difficulty: number | null;
  nibbles: { at: number; durationMs: number }[];
  hookedAt: number | null;
  finishStartedAt: number | null;
  finishDeadlineAt: number | null;
  inputs: FishingInput[];
  fight: FishingFight | null;
  result: FishingCatch | null;
};
export type FishingSnapshot = {
  serverNow: number;
  economyVersion: number;
  gold: number;
  walletRevision: number;
  revision: number;
  totalCaught: number;
  totalEarnedGold: number;
  bestCatch: Pick<FishingCatch, "fishId" | "lengthCm" | "weightKg"> | null;
  goals: { dailyCaught: number; weeklyCaught: number };
  attempt: FishingAttempt | null;
};
type FishingMutation = { requestId: string };
export type FishingRequest = FishingMutation &
  (
    | { action: "begin" }
    | { action: "hook"; attemptId: string }
    | { action: "settle"; attemptId: string }
    | { action: "finish"; attemptId: string }
    | { action: "reel"; attemptId: string; held: boolean }
  );
export type FishingLeaderboard = {
  catches: { displayName: string; value: number; isCurrentUser: boolean }[];
  earnedGold: { displayName: string; value: number; isCurrentUser: boolean }[];
};
export interface FishingStore {
  executeFishing(userId: string, request: FishingRequest, now: number): FishingSnapshot;
  loadFishingSnapshot(userId: string, now: number): FishingSnapshot;
  loadFishingLeaderboard(userId: string): FishingLeaderboard;
}
export class FishingError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "idempotency_conflict"
      | "attempt_unavailable"
      | "attempt_active",
    message: string,
  ) {
    super(message);
    this.name = "FishingError";
  }
}
