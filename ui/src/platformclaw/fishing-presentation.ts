import type {
  FishingFight,
  FishingSnapshot,
} from "../../../packages/platformclaw-control-plane/src/fishing-contracts.ts";
import { replayFishingFight } from "../../../packages/platformclaw-control-plane/src/fishing-simulation.ts";
import type { FishingSceneState } from "./fishing-scene.ts";

/** One projection keeps the canvas, controls and gauges on the same server timeline. */
export function resolveFishingPresentation(
  snapshot: FishingSnapshot | null,
  now: number,
  holding: boolean,
  reducedMotion: boolean,
): { scene: FishingSceneState; fight: FishingFight | null } {
  const attempt = snapshot?.attempt;
  const elapsed = attempt ? now - attempt.issuedAt : 0;
  const base = {
    time: now,
    phaseTime: elapsed,
    tension: 0.1,
    progress: 0,
    holding,
    reducedMotion,
    fishLengthCm: attempt?.result?.lengthCm ?? null,
    escapeReason: null,
  };
  if (!attempt) return { scene: { ...base, phase: "idle" }, fight: null };
  if (
    attempt.phase === "fighting" &&
    attempt.hookedAt !== null &&
    attempt.difficulty !== null &&
    attempt.behavior
  ) {
    const phaseTime = Math.max(0, now - attempt.hookedAt);
    const fight = replayFishingFight(
      attempt.seed,
      attempt.difficulty,
      attempt.inputs,
      phaseTime,
      attempt.behavior,
    );
    return {
      scene: {
        ...base,
        phase: fight.status === "escaped" ? "miss" : phaseTime < 180 ? "hook" : "fighting",
        phaseTime:
          fight.status === "escaped" ? Math.max(0, phaseTime - fight.elapsedMs) : phaseTime,
        escapeReason: fight.escapeReason,
        tension: fight.tension,
        progress: fight.progress,
      },
      fight,
    };
  }
  if (attempt.phase === "finishing" && attempt.finishStartedAt !== null) {
    return {
      scene: {
        ...base,
        phase: "finishing",
        phaseTime: Math.max(0, now - attempt.finishStartedAt),
        progress: 1,
      },
      fight: null,
    };
  }
  if (attempt.phase === "caught") {
    const phaseTime = attempt.result ? now - attempt.result.caughtAt : 0;
    return {
      scene: { ...base, phase: phaseTime < 800 ? "landing" : "success", phaseTime, progress: 1 },
      fight: null,
    };
  }
  if (attempt.phase === "escaped" || attempt.phase === "missed") {
    return {
      scene: {
        ...base,
        phase: "miss",
        escapeReason: attempt.fight?.escapeReason ?? null,
        phaseTime: Math.max(
          0,
          now - (attempt.hookedAt ?? attempt.hookDeadlineAt) - (attempt.fight?.elapsedMs ?? 0),
        ),
      },
      fight: null,
    };
  }
  // The bite signal ends with the server's hook window, even between snapshot polls.
  if (now > attempt.hookDeadlineAt) return { scene: { ...base, phase: "miss" }, fight: null };
  if (elapsed < 550) return { scene: { ...base, phase: "prepare" }, fight: null };
  if (elapsed < 1950)
    return { scene: { ...base, phase: "casting", phaseTime: elapsed - 550 }, fight: null };
  if (elapsed < 2500)
    return { scene: { ...base, phase: "splash", phaseTime: elapsed - 1950 }, fight: null };
  const nibble = attempt.nibbles.find(
    (event) => now >= event.at && now < event.at + event.durationMs,
  );
  return {
    scene: {
      ...base,
      phase: now >= attempt.biteAt ? "bite" : nibble ? "nibble" : "waiting",
      phaseTime: nibble ? now - nibble.at : elapsed,
    },
    fight: null,
  };
}
