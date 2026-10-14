const PERFECT_WINDOW_MS = 25;
const GOOD_WINDOW_MS = 50;
export const HIT_WINDOW_MS = 100;
type TimingOutcome = "PERFECT" | "GOOD" | "HIT" | "MISS";

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
