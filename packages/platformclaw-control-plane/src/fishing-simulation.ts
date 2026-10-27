import type {
  FishingBehavior,
  FishingFight,
  FishingInput,
  FishingQuality,
} from "./fishing-contracts.js";
import { FISHING_MAX_INPUTS } from "./fishing-economy.ts";

export const FISHING_FIGHT_DURATION_MS = 7_000;
export const FISHING_FIXED_STEP_MS = 1_000 / 60;
export const FISHING_FINISH_WINDOW_MS = 4_000;
const FISHING_BEHAVIOR_PULL: Record<
  FishingBehavior,
  (time: number, phase: number, resistance: number) => number
> = {
  steady: (time, phase, resistance) => 0.025 * Math.sin(time / (0.31 + resistance * 0.05) + phase),
  dart: (time, phase) => 0.065 * Math.sin(time / 0.18 + phase),
  surge: (time, phase) => 0.06 * Math.max(0, Math.sin(time / 0.45 + phase)) - 0.02,
  deep: (time, phase) => 0.012 + 0.02 * Math.sin(time / 0.7 + phase),
  ancient: (time, phase) =>
    0.065 * Math.sin(time / 0.55 + phase) + 0.01 * Math.sin(time / 1.3 + phase),
};

export function fishingHookWindowMs(): number {
  return 1500;
}

export function fishingHookQuality(deltaMs: number): FishingQuality | null {
  if (!Number.isFinite(deltaMs) || deltaMs < -100 || deltaMs > fishingHookWindowMs()) {
    return null;
  }
  return Math.abs(deltaMs) <= 100 ? "PERFECT" : "GOOD";
}

/** Fixed-step replay consumes server-timestamped transitions, never client elapsed time. */
export function replayFishingFight(
  seed: number,
  difficulty: number,
  inputs: readonly FishingInput[],
  elapsedMs: number,
  behavior: FishingBehavior,
): FishingFight {
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    !Number.isInteger(difficulty) ||
    difficulty < 1 ||
    difficulty > 10
  ) {
    throw new Error("Invalid fishing replay duration or species difficulty");
  }
  if (inputs.length > FISHING_MAX_INPUTS) {
    throw new Error("Fishing replay input budget exceeded");
  }
  let previousAt = -1;
  for (const input of inputs) {
    if (
      !Number.isFinite(input.atMs) ||
      input.atMs < 0 ||
      input.atMs < previousAt ||
      input.atMs > FISHING_FIGHT_DURATION_MS
    ) {
      throw new Error("Fishing inputs must be chronological within the fight window");
    }
    previousAt = input.atMs;
  }
  const state: FishingFight = {
    elapsedMs: 0,
    tension: 0.32,
    progress: 0,
    status: "fighting",
    escapeReason: null,
  };
  const steps = Math.floor(
    Math.min(elapsedMs, FISHING_FIGHT_DURATION_MS) / FISHING_FIXED_STEP_MS + 1e-9,
  );
  const resistance = (difficulty - 1) / 2;
  const phase = ((seed >>> 0) % 6283) / 1_000;
  let inputIndex = 0;
  let held = false;
  let slackMs = 0;
  for (let tick = 0; tick < steps; tick += 1) {
    const atMs = tick * FISHING_FIXED_STEP_MS;
    while (inputIndex < inputs.length && inputs[inputIndex]!.atMs <= atMs + 1e-9) {
      held = inputs[inputIndex]!.held;
      inputIndex += 1;
    }
    // A visible tension band makes holding forever break the line and releasing forever lose the fish.
    const time = atMs / 1_000;
    const pull = FISHING_BEHAVIOR_PULL[behavior](time, phase, resistance) * (1 + difficulty * 0.05);
    const tensionRate = held ? 0.27 + difficulty * 0.009 + pull : -0.4 + pull;
    state.tension = Math.max(0, Math.min(1, state.tension + tensionRate / 60));
    if (held && state.tension >= 0.12 && state.tension <= 0.9) {
      state.progress = Math.min(1, state.progress + (0.335 - difficulty * 0.003) / 60);
    }
    slackMs = state.tension <= 0.02 ? slackMs + FISHING_FIXED_STEP_MS : 0;
    state.elapsedMs = (tick + 1) * FISHING_FIXED_STEP_MS;
    if (state.tension >= 1 || slackMs >= 500 - difficulty * 15) {
      state.status = "escaped";
      state.escapeReason = state.tension >= 1 ? "line_broken" : "slack";
      break;
    }
    if (state.progress >= 1) {
      state.status = "caught";
      break;
    }
  }
  if (state.status === "fighting" && elapsedMs >= FISHING_FIGHT_DURATION_MS) {
    state.status = "escaped";
    state.escapeReason = "timeout";
  }
  return state;
}

/** A continuous round trip gives the server and renderer the same position without frame counting. */
export function fishingFinishPosition(seed: number, elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) {
    throw new Error("Invalid fishing finish elapsed time");
  }
  const phase = ((seed >>> 0) % 1_200) / 1_200;
  const travel = (Math.max(0, elapsedMs) / 1_200 + phase) % 2;
  return travel <= 1 ? travel : 2 - travel;
}

export function resolveFishingFinish(
  seed: number,
  elapsedMs: number,
): {
  position: number;
  accuracy: number;
  bonusMultiplier: number;
} {
  const position = fishingFinishPosition(seed, elapsedMs);
  const accuracy =
    elapsedMs < 0 || elapsedMs >= FISHING_FINISH_WINDOW_MS ? 0 : 1 - Math.abs(position - 0.5) * 2;
  return { position, accuracy, bonusMultiplier: 1 + accuracy };
}
