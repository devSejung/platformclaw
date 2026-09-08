const PERFECT_WINDOW_MS = 25;
const GOOD_WINDOW_MS = 50;
export const HIT_WINDOW_MS = 100;
const HOME_RUN_DISTANCE_M = 120;

export type TimingOutcome = "PERFECT" | "GOOD" | "HIT" | "MISS";
export type HitResult = "HIT" | "HOME_RUN";

export function classifyHitResult(distanceM: number): HitResult {
  return Number.isFinite(distanceM) && distanceM >= HOME_RUN_DISTANCE_M ? "HOME_RUN" : "HIT";
}

export function formatHitResult(result: HitResult): string {
  return result === "HOME_RUN" ? "홈런" : "안타";
}

export function classifyTimingDelta(deltaMs: number): TimingOutcome {
  const absolute = Math.abs(deltaMs);
  if (absolute <= PERFECT_WINDOW_MS) {
    return "PERFECT";
  }
  if (absolute <= GOOD_WINDOW_MS) {
    return "GOOD";
  }
  if (absolute <= HIT_WINDOW_MS) {
    return "HIT";
  }
  return "MISS";
}

export function formatTimingFeedback(deltaMs: number, outcome: TimingOutcome): string {
  if (outcome === "PERFECT") {
    return "PERFECT";
  }
  if (outcome === "MISS") {
    return "MISS";
  }
  if (!Number.isFinite(deltaMs)) {
    return "MISS";
  }
  const amount = Math.max(1, Math.round(Math.abs(deltaMs)));
  return `${amount}ms ${deltaMs < 0 ? "빠름" : "느림"}`;
}

export function distanceForTiming(
  deltaMs: number,
  potentialDistanceM: number,
  minimumDistanceM: number,
): number {
  const accuracy = Math.min(1, Math.max(0, 1 - Math.abs(deltaMs) / HIT_WINDOW_MS));
  return Math.round(minimumDistanceM + accuracy * (potentialDistanceM - minimumDistanceM));
}
