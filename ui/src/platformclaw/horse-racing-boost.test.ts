import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { HorseRacingSnapshot } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import { paintHorsePerimeter, renderHorsePerimeter } from "./horse-racing-perimeter-view.ts";
import { horsePerimeterPoint, horseRaceBoosts } from "./horse-racing-perimeter.ts";
import { snapshot } from "./horse-racing.test-fixtures.ts";

function running(): HorseRacingSnapshot {
  const value = snapshot();
  value.race!.status = "racing";
  value.serverNow = value.race!.startsAt + 20_000;
  return value;
}

describe("observed racing bursts", () => {
  afterEach(() => document.body.replaceChildren());

  it("highlights only a faster observed segment and clears on finish, replay, or a disconnected gap", () => {
    const before = running();
    const after = structuredClone(before);
    after.serverNow += 2_000;
    after.race!.positions = [
      { horseId: "1", position: 1.6 },
      { horseId: "2", position: 1.1 },
      { horseId: "3", position: 0.7 },
      { horseId: "4", position: 100 },
      { horseId: "5", position: 0 },
      { horseId: "6", position: 1.8 },
    ];
    expect([...horseRaceBoosts(before, after)]).toEqual(["1", "6"]);
    expect(horseRaceBoosts(null, after).size).toBe(0);
    expect(horseRaceBoosts(before, { ...after, serverNow: before.serverNow }).size).toBe(0);
    expect(horseRaceBoosts(before, { ...after, serverNow: before.serverNow + 6_000 }).size).toBe(0);
    for (const race of [
      { ...after.race!, id: "different-race" },
      { ...after.race!, status: "settled" as const },
    ]) {
      expect(horseRaceBoosts(before, { ...after, race }).size).toBe(0);
    }
    const slower = structuredClone(after);
    slower.serverNow += 2_000;
    expect(horseRaceBoosts(after, slower).size).toBe(0);
  });

  it("keeps burst trails behind all four facings without rotating horses or stealing clicks", () => {
    const race = running().race!;
    const container = document.createElement("div");
    document.body.append(container);
    const positions = new Map(race.positions.map((entry) => [entry.horseId, 0]));
    render(
      renderHorsePerimeter(race, 640, 400, positions, false, false, new Set(["1"])),
      container,
    );
    const runner = container.querySelector<SVGGElement>('[data-perimeter-horse="1"]')!;
    const observed = new Set<string>();
    for (const progress of [1, 8, 16, 27]) {
      positions.set("1", progress);
      paintHorsePerimeter(container, race, 640, 400, positions, new Set(["1"]));
      const point = horsePerimeterPoint(640, 400, progress, 0);
      expect(runner.getAttribute("transform")).toBe(`translate(${point.x} ${point.y})`);
      expect(runner.querySelector("[data-horse-boost]")!.getAttribute("transform")).toBe(
        `rotate(${point.angle})`,
      );
      expect(runner.dataset.boosting).toBe("true");
      observed.add(runner.dataset.facing!);
    }
    expect(observed).toEqual(new Set(["right", "front", "left", "back"]));
    paintHorsePerimeter(container, race, 640, 400, positions, new Set());
    expect(runner.dataset.boosting).toBe("false");
    for (const [stale, reduced] of [
      [true, false],
      [false, true],
    ]) {
      render(
        renderHorsePerimeter(race, 640, 400, positions, stale!, reduced!, new Set(["1"])),
        container,
      );
      expect(runner.dataset.boosting).toBe("false");
    }
    expect(container.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
  });
});
