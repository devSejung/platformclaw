import { webcrypto } from "node:crypto";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HorseRaceSnapshot } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import {
  createRacingHorses,
  drawHorseFinishOrder,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-engine.ts";
import { renderHorsePerimeter } from "./horse-racing-perimeter-view.ts";
import {
  horsePerimeterFacing,
  horsePerimeterPoint,
  horsePerimeterLabel,
} from "./horse-racing-perimeter.ts";
import { verifyHorseRace } from "./horse-racing-verification.ts";
import { snapshot } from "./horse-racing.test-fixtures.ts";

describe("responsive three-lap viewport circuit", () => {
  it.each([
    [1440, 900],
    [390, 740],
    [900, 390],
  ])("stays inside %ix%i and finishes at its starting line", (width, height) => {
    for (let lane = 0; lane < 6; lane += 1) {
      const start = horsePerimeterPoint(width, height, 0, lane);
      expect(horsePerimeterPoint(width, height, 100, lane)).toEqual(start);
      for (let position = 0; position <= 100; position += 0.25) {
        const point = horsePerimeterPoint(width, height, position, lane);
        expect(point.x).toBeGreaterThan(0);
        expect(point.x).toBeLessThan(width);
        expect(point.y).toBeGreaterThan(0);
        expect(point.y).toBeLessThan(height);
        expect([0, 90, 180, 270]).toContain(point.angle);
        const label = horsePerimeterLabel(width, height, point, lane);
        expect(label.x).toBeGreaterThanOrEqual(4);
        expect(label.x + 58).toBeLessThanOrEqual(width - 4);
        expect(label.y).toBeGreaterThanOrEqual(14);
        expect(label.y).toBeLessThanOrEqual(height - 6);
      }
    }
  });

  it("moves along both edges around a corner instead of a diagonal and rescales without changing progress", () => {
    const width = 1000;
    const height = 600;
    const perimeter = (width - 40 + height - 40) * 2;
    const cornerProgress = ((width - 40) / 2 / perimeter / 3) * 100;
    const before = horsePerimeterPoint(width, height, cornerProgress - 0.01, 0);
    const after = horsePerimeterPoint(width, height, cornerProgress + 0.01, 0);
    expect(before.y).toBe(20);
    expect(before.x).toBeLessThan(980);
    expect(after.x).toBe(980);
    expect(after.y).toBeGreaterThan(20);
    const resized = horsePerimeterPoint(390, 740, 10, 0);
    expect(resized).not.toEqual(horsePerimeterPoint(width, height, 10, 0));
    expect(resized.x).toBeLessThan(390);
    expect(resized.y).toBeLessThan(740);
  });

  it("maps top/right/bottom/left legs to upright right/front/left/back sprites", () => {
    const width = 640;
    const height = 400;
    const trackWidth = width - 40;
    const trackHeight = height - 40;
    const perimeter = (trackWidth + trackHeight) * 2;
    const segments = [
      { distance: trackWidth / 4, facing: "right" },
      { distance: trackWidth / 2 + trackHeight / 2, facing: "front" },
      { distance: trackWidth + trackHeight, facing: "left" },
      { distance: trackWidth * 1.5 + trackHeight * 1.5, facing: "back" },
    ];
    for (const segment of segments) {
      const point = horsePerimeterPoint(width, height, (segment.distance / perimeter / 3) * 100, 0);
      expect(horsePerimeterFacing(point.angle)).toBe(segment.facing);
      expect(point.x).toBeGreaterThanOrEqual(20);
      expect(point.x).toBeLessThanOrEqual(width - 20);
      expect(point.y).toBeGreaterThanOrEqual(20);
      expect(point.y).toBeLessThanOrEqual(height - 20);
    }
  });
});

describe("upright runner rendering", () => {
  afterEach(() => document.body.replaceChildren());
  it("renders distinct upright front and rear artwork on the vertical track segments", () => {
    const width = 640;
    const height = 400;
    const positions = new Map<string, number>();
    const expected = ["right", "front", "left", "back"] as const;
    const race = { ...snapshot().race!, status: "racing" as const };
    for (let lane = 0; lane < race.horses.length; lane += 1) {
      const inset = 20 + lane * 7;
      const trackWidth = width - inset * 2;
      const trackHeight = height - inset * 2;
      let distance: number;
      switch (lane % 4) {
        case 0:
          distance = trackWidth / 4;
          break;
        case 1:
          distance = trackWidth / 2 + trackHeight / 2;
          break;
        case 2:
          distance = trackWidth + trackHeight;
          break;
        default:
          distance = (trackWidth + trackHeight) * 1.5;
          break;
      }
      positions.set(race.horses[lane]!.id, (distance / ((trackWidth + trackHeight) * 2) / 3) * 100);
    }
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderHorsePerimeter(race, width, height, positions, false, false, new Set()),
      container,
    );
    for (let lane = 0; lane < race.horses.length; lane += 1) {
      const runner = race.horses[lane]!;
      const horse = container.querySelector(`[data-perimeter-horse="${runner.id}"]`)!;
      expect(horse.getAttribute("data-facing")).toBe(expected[lane % 4]);
      expect(horse.getAttribute("transform")).not.toContain("rotate");
      const label = container.querySelector(`[data-horse-label="${runner.id}"]`)!;
      expect(label.textContent).toContain(runner.name);
      expect(label.getAttribute("transform")).toBeNull();
      expect(label.getAttribute("fill")).toBeNull();
      expect(horse.querySelectorAll("[data-horse-facing]")).toHaveLength(4);
      expect(horse.querySelector('[data-horse-facing="front"]')?.innerHTML).not.toBe(
        horse.querySelector('[data-horse-facing="back"]')?.innerHTML,
      );
    }
  });
});

describe("browser fairness verification", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("matches the real server draw and detects changed seed, order and published horse weights", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const race: HorseRaceSnapshot = {
      ...snapshot().race!,
      status: "settled",
      revealedSeed: "test-seed",
      horses: createRacingHorses("race-11", "test-seed"),
      finishOrder: drawHorseFinishOrder(createRacingHorses("race-11", "test-seed"), "test-seed"),
    };
    expect(await verifyHorseRace(race)).toBe(true);
    expect(await verifyHorseRace({ ...race, revealedSeed: "changed" })).toBe(false);
    expect(await verifyHorseRace({ ...race, finishOrder: race.finishOrder!.toReversed() })).toBe(
      false,
    );
    expect(
      await verifyHorseRace({
        ...race,
        horses: [
          Object.assign({}, race.horses[0]!, { weight: race.horses[0]!.weight! + 1 }),
          ...race.horses.slice(1),
        ],
      }),
    ).toBe(false);
  });
});
