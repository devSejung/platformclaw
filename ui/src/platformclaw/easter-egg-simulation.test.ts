import { describe, expect, it, vi } from "vitest";
import { BASEBALL_BATS } from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import {
  BASEBALL_WORLD,
  advanceBattedBall,
  createBattedBall,
  createPitch,
  pitchPositionAt,
} from "./easter-egg-simulation.ts";
import { classifyTimingDelta } from "./easter-egg-timing.ts";

function playToResult(timingDeltaMs: number, batPower = 1, frameMs = 16, fielded = true) {
  const simulation = createBattedBall({ timingDeltaMs, batPower });
  if (!fielded) {
    simulation.outfielder.reactionDelayMs = Number.POSITIVE_INFINITY;
  }
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
    expect(pitch.speedKph).toBe(120);
    expect(pitchPositionAt(pitch, 0).x).toBe(BASEBALL_WORLD.pitcherX);
    expect(pitchPositionAt(pitch, pitch.idealContactTimeMs).x).toBeCloseTo(
      BASEBALL_WORLD.contactX,
      10,
    );
    const slow = createPitch(() => 0);
    const fast = createPitch(() => 0.5);
    expect(slow.speedKph).toBe(115);
    expect(createPitch(() => 0.499_999).speedKph).toBeCloseTo(125, 4);
    expect(fast.speedKph).toBe(145);
    expect(createPitch(() => 1).speedKph).toBe(155);
    expect(slow.idealContactTimeMs - fast.idealContactTimeMs).toBeGreaterThan(100);
    for (let index = 0; index <= 100; index += 1) {
      const speed = createPitch(() => index / 100).speedKph;
      expect(speed <= 125 || speed >= 145).toBe(true);
    }
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

  it("moves the outfielder toward the projected landing point after reacting", () => {
    const simulation = createBattedBall({ timingDeltaMs: 50, batPower: 1 });
    const startingX = simulation.outfielder.x;

    advanceBattedBall(simulation, simulation.outfielder.reactionDelayMs - 5);
    expect(simulation.outfielder.x).toBe(startingX);
    advanceBattedBall(simulation, 10);
    expect(simulation.outfielder.x).toBeLessThan(startingX);

    const result = playToResult(50);
    expect(result.result?.kind).toBe("OUT");
    expect(result.result?.distanceM).toBeLessThan(BASEBALL_WORLD.fenceX);
  });

  it("keeps the perfect window fair while late contact loses distance monotonically", () => {
    const distance = (timingDeltaMs: number) =>
      playToResult(timingDeltaMs, 1, 16, false).result?.distanceM ?? 0;

    expect(distance(-25)).toBeCloseTo(distance(25), 10);
    expect(distance(0)).toBeGreaterThan(105);
    expect(distance(0)).toBeLessThan(120);
    expect(distance(40)).toBeLessThan(65);
    expect(distance(50)).toBeLessThan(distance(40));
    expect(distance(60)).toBeLessThan(distance(50));
    expect(distance(100)).toBeLessThan(20);
  });

  it("produces balanced deterministic outcomes across every bat", () => {
    const results = BASEBALL_BATS.flatMap((bat) =>
      Array.from(
        { length: 41 },
        (_, index) => playToResult(index * 5 - 100, bat.exitVelocityMultiplier).result?.kind,
      ),
    );
    const homeRuns = results.filter((result) => result === "HOME_RUN").length;
    const outs = results.filter((result) => result === "OUT").length;
    const hits = results.filter((result) => result === "HIT").length;

    expect(homeRuns / results.length).toBeGreaterThan(0.22);
    expect(homeRuns / results.length).toBeLessThan(0.29);
    expect(outs / results.length).toBeGreaterThan(0.4);
    expect(outs / results.length).toBeLessThan(0.49);
    expect(hits / results.length).toBeGreaterThan(0.27);
    expect(hits / results.length).toBeLessThan(0.36);
    expect(outs / (outs + hits)).toBeGreaterThan(0.55);
    expect(outs / (outs + hits)).toBeLessThan(0.65);

    const homeRunRates = BASEBALL_BATS.map((bat) => {
      const batResults = Array.from(
        { length: 41 },
        (_, index) => playToResult(index * 5 - 100, bat.exitVelocityMultiplier).result?.kind,
      );
      return batResults.filter((result) => result === "HOME_RUN").length / batResults.length;
    });
    expect(homeRunRates[0]).toBeGreaterThan(0.05);
    expect(homeRunRates[0]).toBeLessThan(0.12);
    expect(homeRunRates.at(-1)).toBeGreaterThan(0.35);
    expect(homeRunRates.at(-1)).toBeLessThan(0.47);
    expect(homeRunRates).toEqual(homeRunRates.toSorted((left, right) => left - right));
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
