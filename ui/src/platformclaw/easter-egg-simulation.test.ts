import { describe, expect, it, vi } from "vitest";
import {
  getBaseballEnhancementAppearance,
  resolveBaseballAtBatPower,
} from "../../../packages/platformclaw-control-plane/src/baseball-enhancement.ts";
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

const enhancementLevels = Array.from({ length: 21 }, (_, level) => level);

function enhancedPower(level: number, timingDeltaMs: number): number {
  return resolveBaseballAtBatPower(
    {
      batId: getBaseballEnhancementAppearance(level).batId,
      enhancementLevel: level,
      powerRuleVersion: "sweetspot-v1",
    },
    timingDeltaMs,
  );
}

const pitchCases = [
  { kind: "fastball", sample: 0.1171875, min: 145, max: 155 },
  { kind: "changeup", sample: 0.3515625, min: 115, max: 125 },
  { kind: "underhand", sample: 0.5859375, min: 130, max: 140 },
  { kind: "curve", sample: 0.8203125, min: 105, max: 115 },
  { kind: "knuckleball", sample: 0.9765625, min: 100, max: 110 },
] as const;

describe("PlatformClaw easter egg simulation", () => {
  it.each(pitchCases)(
    "replays one $kind sample and reaches the same contact point at its judged time",
    ({ kind, sample, min, max }) => {
      const random = vi.fn(() => sample);
      const pitch = createPitch(random);
      expect(random).toHaveBeenCalledOnce();
      expect(pitch.kind).toBe(kind);
      expect(pitch.speedKph).toBe((min + max) / 2);
      expect(createPitch(() => sample)).toEqual(pitch);
      expect(pitch.idealContactTimeMs).toBeCloseTo((18.44 / (pitch.speedKph / 3.6)) * 1000, 10);
      const releaseY = kind === "underhand" ? 0.35 : 1.05;
      expect(pitchPositionAt(pitch, -1)).toEqual({ x: 18.44, y: releaseY });
      expect(pitchPositionAt(pitch, 0)).toEqual({ x: 18.44, y: releaseY });
      expect(pitchPositionAt(pitch, pitch.idealContactTimeMs)).toEqual({ x: 0, y: 1.05 });
      expect(pitchPositionAt(pitch, pitch.idealContactTimeMs + 100)).toEqual({ x: 0, y: 1.05 });
      for (let step = 1; step <= 10; step += 1) {
        const before = pitchPositionAt(pitch, (pitch.idealContactTimeMs * (step - 1)) / 10);
        const after = pitchPositionAt(pitch, (pitch.idealContactTimeMs * step) / 10);
        expect(before.x - after.x).toBeCloseTo(1.844, 10);
      }
    },
  );

  it("makes knuckleballs rare while preserving the independent speed distribution inside every pattern", () => {
    for (const [kindIndex, band] of [0, 15, 30, 45, 60].entries()) {
      const expected = pitchCases[kindIndex]!;
      for (const fraction of [0.125, 0.375, 0.625, 0.875]) {
        const pitch = createPitch(() => (band + fraction) / 64);
        expect(pitch.kind).toBe(expected.kind);
        expect((pitch.speedKph - expected.min) / (expected.max - expected.min)).toBeCloseTo(
          fraction,
          10,
        );
      }
    }
    const bins = pitchCases.map(() => [0, 0, 0, 0]);
    for (let index = 0; index < 1024; index += 1) {
      const pitch = createPitch(() => (index + 0.5) / 1024);
      const kindIndex = pitchCases.findIndex(({ kind }) => kind === pitch.kind);
      const { min, max } = pitchCases[kindIndex]!;
      const speedBin = Math.floor(((pitch.speedKph - min) / (max - min)) * 4);
      bins[kindIndex]![speedBin]! += 1;
    }
    expect(bins).toEqual([
      [60, 60, 60, 60],
      [60, 60, 60, 60],
      [60, 60, 60, 60],
      [60, 60, 60, 60],
      [16, 16, 16, 16],
    ]);
    expect(
      createPitch(() => 0.3515625).idealContactTimeMs -
        createPitch(() => 0.1171875).idealContactTimeMs,
    ).toBeGreaterThan(100);
  });

  it("handles profile boundaries and finite out-of-range samples without selecting a missing kind", () => {
    for (const [sample, kind, speed] of [
      [-1, "fastball", 145],
      [0, "fastball", 145],
      [15 / 64 - Number.EPSILON, "fastball", 155],
      [15 / 64, "changeup", 115],
      [30 / 64 - Number.EPSILON, "changeup", 125],
      [30 / 64, "underhand", 130],
      [45 / 64 - Number.EPSILON, "underhand", 140],
      [45 / 64, "curve", 105],
      [60 / 64 - Number.EPSILON, "curve", 115],
      [60 / 64, "knuckleball", 100],
      [1, "knuckleball", 110],
      [2, "knuckleball", 110],
    ] as const) {
      const pitch = createPitch(() => sample);
      expect(pitch.kind).toBe(kind);
      expect(pitch.speedKph).toBeCloseTo(speed, 10);
    }
    for (const sample of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(() => createPitch(() => sample)).toThrow("finite number");
    }
  });

  it("keeps straight pitches flat, makes the low-release underhand rise steadily, and gives the curve a continuous arc", () => {
    const at = (sample: number, progress: number) => {
      const pitch = createPitch(() => sample);
      return pitchPositionAt(pitch, pitch.idealContactTimeMs * progress);
    };
    for (const progress of [0.25, 0.5, 0.75]) {
      expect(at(0.1171875, progress).y).toBe(1.05);
      expect(at(0.3515625, progress).y).toBe(1.05);
    }
    for (let step = 1; step <= 4; step += 1) {
      const before = at(0.5859375, (step - 1) / 4);
      const after = at(0.5859375, step / 4);
      expect(after.y - before.y).toBeCloseTo(0.175, 10);
    }
    expect(at(0.8203125, 0.5).y - 1.05).toBe(2.5);
    expect(at(0.8203125, 0.75).y).toBeGreaterThan(at(0.5859375, 0.75).y);
    for (const { sample } of pitchCases) {
      expect(Math.abs(at(sample, 0.750001).y - at(sample, 0.749999).y)).toBeLessThan(0.001);
    }
  });

  it("keeps knuckleball wobble deterministic, small, continuous, and smoothly zero at contact without new random draws", () => {
    const pitch = createPitch(() => 0.9765625);
    const at = (progress: number) => pitchPositionAt(pitch, pitch.idealContactTimeMs * progress);
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("unexpected frame randomness");
    });
    try {
      expect(at(0.25).y).toBeGreaterThan(1.05);
      expect(at(0.75).y).toBeLessThan(1.05);
      let previous = at(0);
      for (let step = 1; step <= 1000; step += 1) {
        const point = at(step / 1000);
        expect(Math.abs(point.y - 1.05)).toBeLessThanOrEqual(0.16);
        expect(Math.abs(point.y - previous.y)).toBeLessThan(0.01);
        expect(point.x).toBeLessThan(previous.x);
        expect(at(step / 1000)).toEqual(point);
        previous = point;
      }
      expect(Math.abs(at(0.999).y - 1.05)).toBeLessThan(0.00001);
      expect(at(1)).toEqual({ x: 0, y: 1.05 });
    } finally {
      random.mockRestore();
    }
  });

  it("keeps center contact strong without guaranteeing the whole Perfect window at any enhancement", () => {
    for (const level of enhancementLevels) {
      expect(playToResult(0, enhancedPower(level, 0)).result?.kind).toBe("HOME_RUN");
      for (const timingDeltaMs of [-25, 25]) {
        expect(classifyTimingDelta(timingDeltaMs)).toBe("PERFECT");
        expect(
          playToResult(timingDeltaMs, enhancedPower(level, timingDeltaMs)).result?.kind,
        ).not.toBe("HOME_RUN");
      }
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

  it("improves central contact across enhancement levels without changing off-center outcomes", () => {
    const outcomes = enhancementLevels.map((level) =>
      Array.from({ length: 41 }, (_, index) => {
        const timingDeltaMs = index * 5 - 100;
        return playToResult(timingDeltaMs, enhancedPower(level, timingDeltaMs)).result?.kind;
      }),
    );
    for (const levelOutcomes of outcomes) {
      expect(levelOutcomes).not.toContain(undefined);
      expect(levelOutcomes).toContain("HIT");
      expect(levelOutcomes).toContain("OUT");
      for (let index = 0; index < levelOutcomes.length; index += 1) {
        if (Math.abs(index * 5 - 100) >= 25) {
          expect(levelOutcomes[index]).toBe(outcomes[0]![index]);
        }
      }
    }
    const homeRuns = outcomes.map(
      (levelOutcomes) => levelOutcomes.filter((result) => result === "HOME_RUN").length,
    );
    expect(homeRuns).toEqual(homeRuns.toSorted((left, right) => left - right));
    expect(homeRuns.at(-1)).toBeGreaterThan(homeRuns[0]!);
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
