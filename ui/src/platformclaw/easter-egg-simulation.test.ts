import { describe, expect, it, vi } from "vitest";
import {
  BASEBALL_WORLD,
  advanceBattedBall,
  createBattedBall,
  createPitch,
  pitchPositionAt,
} from "./easter-egg-simulation.ts";
import { classifyTimingDelta } from "./easter-egg-timing.ts";

function playToResult(timingDeltaMs: number, batPower = 1, frameMs = 16) {
  const simulation = createBattedBall({ timingDeltaMs, batPower });
  for (let elapsed = 0; elapsed < 10_000 && !simulation.result; elapsed += frameMs) {
    advanceBattedBall(simulation, frameMs);
  }
  return simulation;
}

describe("PlatformClaw easter egg simulation", () => {
  it("samples one pitch speed and uses it for movement and contact time", () => {
    const random = vi.fn(() => 0.25);
    const pitch = createPitch(random);

    expect(random).toHaveBeenCalledOnce();
    expect(pitch.speedKph).toBe(125);
    expect(pitchPositionAt(pitch, 0).x).toBe(BASEBALL_WORLD.pitcherX);
    expect(pitchPositionAt(pitch, pitch.idealContactTimeMs).x).toBeCloseTo(
      BASEBALL_WORLD.contactX,
      10,
    );
    expect(createPitch(() => 0).idealContactTimeMs).toBeGreaterThan(
      createPitch(() => 1).idealContactTimeMs,
    );
  });

  it("applies bat power to launch physics without changing timing boundaries", () => {
    const wood = createBattedBall({ timingDeltaMs: 0, batPower: 1 });
    const upgraded = createBattedBall({ timingDeltaMs: 0, batPower: 1.15 });

    expect(upgraded.ball.vx).toBeCloseTo(wood.ball.vx * 1.15, 10);
    expect(upgraded.ball.vy).toBeCloseTo(wood.ball.vy * 1.15, 10);
    expect(playToResult(0, 1).result?.kind).toBe("HOME_RUN");
    expect(classifyTimingDelta(100)).toBe("HIT");
    expect(classifyTimingDelta(101)).toBe("MISS");
    expect(() => createBattedBall({ timingDeltaMs: 101, batPower: 10 })).toThrow(
      "requires successful contact",
    );
  });

  it("produces the same state after one long frame or many short frames", () => {
    const longFrame = createBattedBall({ timingDeltaMs: 70, batPower: 1 });
    const shortFrames = createBattedBall({ timingDeltaMs: 70, batPower: 1 });

    advanceBattedBall(longFrame, 1_000);
    for (let index = 0; index < 10; index += 1) {
      advanceBattedBall(shortFrames, 100);
    }

    expect(longFrame.ball.x).toBeCloseTo(shortFrames.ball.x, 10);
    expect(longFrame.ball.y).toBeCloseTo(shortFrames.ball.y, 10);
    expect(longFrame.outfielder.x).toBeCloseTo(shortFrames.outfielder.x, 10);
    expect(longFrame.result).toEqual(shortFrames.result);
  });

  it("moves the outfielder only after the reaction delay and can record a catch", () => {
    const simulation = createBattedBall({ timingDeltaMs: 100, batPower: 1 });
    const startingX = simulation.outfielder.x;

    advanceBattedBall(simulation, simulation.outfielder.reactionDelayMs - 5);
    expect(simulation.outfielder.x).toBe(startingX);
    advanceBattedBall(simulation, 10);
    expect(simulation.outfielder.x).toBeLessThan(startingX);

    const result = playToResult(100);
    expect(result.result?.kind).toBe("OUT");
    expect(result.result?.distanceM).toBeLessThan(BASEBALL_WORLD.fenceX);
  });

  it("records an ordinary landing inside the fence when no fielder can reach it", () => {
    const simulation = createBattedBall({ timingDeltaMs: 100, batPower: 1 });
    simulation.outfielder.reactionDelayMs = Number.POSITIVE_INFINITY;
    for (let elapsed = 0; elapsed < 10_000 && !simulation.result; elapsed += 16) {
      advanceBattedBall(simulation, 16);
    }

    expect(simulation.result?.kind).toBe("HIT");
    expect(simulation.result?.distanceM).toBeGreaterThan(0);
    expect(simulation.result?.distanceM).toBeLessThan(BASEBALL_WORLD.fenceX);
  });

  it("resolves the first physical event once and never treats a screen edge as a home run", () => {
    const caught = createBattedBall({ timingDeltaMs: 0, batPower: 1 });
    caught.ball.x = 50;
    caught.ball.y = caught.outfielder.catchHeightM;
    caught.ball.vx = 2;
    caught.ball.vy = -1;
    caught.outfielder.x = 50;
    caught.outfielder.reactionDelayMs = 0;
    advanceBattedBall(caught, 5);
    expect(caught.result?.kind).toBe("OUT");

    const landed = createBattedBall({ timingDeltaMs: 0, batPower: 1 });
    landed.ball.x = 99.99;
    landed.ball.y = 0.001;
    landed.ball.vx = 5;
    landed.ball.vy = -5;
    landed.outfielder.reactionDelayMs = Number.POSITIVE_INFINITY;
    advanceBattedBall(landed, 5);
    expect(landed.result?.kind).toBe("HIT");
    expect(landed.result?.distanceM).toBeLessThan(BASEBALL_WORLD.fenceX);

    const overFence = createBattedBall({ timingDeltaMs: 0, batPower: 1 });
    overFence.ball.x = 99.99;
    overFence.ball.y = BASEBALL_WORLD.fenceHeight + 0.5;
    overFence.ball.vx = 5;
    overFence.ball.vy = 0;
    overFence.outfielder.reactionDelayMs = Number.POSITIVE_INFINITY;
    advanceBattedBall(overFence, 5);
    expect(overFence.result?.kind).toBe("HOME_RUN");
    expect(overFence.result?.distanceM).toBeGreaterThan(BASEBALL_WORLD.fenceX);

    advanceBattedBall(overFence, 5_000);
    expect(overFence.result?.kind).toBe("HOME_RUN");
  });

  it("reports trajectory distance without the legacy 150m clamp", () => {
    const result = playToResult(0, 1.5);
    expect(result.result?.kind).toBe("HOME_RUN");
    expect(result.ball.y).toBeGreaterThan(BASEBALL_WORLD.fenceHeight);
    expect(result.result?.distanceM).toBeGreaterThan(150);
  });
});
