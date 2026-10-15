import { describe, expect, it } from "vitest";
import { HORSE_RACING_JOKER_ID, type RacingHorse } from "./horse-racing-contracts.js";
import {
  createRacingHorses,
  drawHorseFinishOrder,
  getHorseRaceDayStarts,
  horseRaceCommitment,
  horseRacePositions,
  nextHorseRaceStartsAt,
  HORSE_RACE_DURATION_MS,
  HORSE_RACE_LOCK_BEFORE_MS,
  horseRaceOpensAt,
} from "./horse-racing-engine.js";

const time = (value: string) => Date.parse(value);

function observeStumble(horses: RacingHorse[], order: string[], seed: string) {
  for (let observedAt = 20_000; observedAt <= 113_000; observedAt += 1_000) {
    const horse = horseRacePositions(horses, order, seed, observedAt).find(
      (entry) => entry.motion === "fallen",
    );
    if (!horse) {
      continue;
    }
    let before = observedAt - 1_000;
    let startsAt = observedAt;
    while (before + 1 < startsAt) {
      const middle = Math.floor((before + startsAt) / 2);
      const falling =
        horseRacePositions(horses, order, seed, middle).find(
          (entry) => entry.horseId === horse.horseId,
        )?.motion === "fallen";
      if (falling) {
        startsAt = middle;
      } else {
        before = middle;
      }
    }
    return { horseId: horse.horseId, startsAt };
  }
  throw new Error("The recorded race did not contain a fall");
}

describe("horse racing schedule", () => {
  it.each([
    ["2026-10-15T09:00:00+09:00", "2026-10-15T08:50:00+09:00", "2026-10-15T08:59:00+09:00"],
    ["2026-10-15T09:30:00+09:00", "2026-10-15T09:03:10+09:00", "2026-10-15T09:29:00+09:00"],
    ["2026-10-15T11:00:00+09:00", "2026-10-15T10:33:10+09:00", "2026-10-15T10:59:00+09:00"],
    ["2026-10-15T19:00:00+09:00", "2026-10-15T18:33:10+09:00", "2026-10-15T18:59:00+09:00"],
    ["2026-10-15T19:30:00+09:00", "2026-10-15T19:03:10+09:00", "2026-10-15T19:29:00+09:00"],
    ["2026-10-15T20:00:00+09:00", "2026-10-15T19:33:10+09:00", "2026-10-15T19:59:00+09:00"],
    ["2026-10-19T09:00:00+09:00", "2026-10-19T08:50:00+09:00", "2026-10-19T08:59:00+09:00"],
  ])("opens and closes the canonical race window for %s", (start, open, close) => {
    expect(horseRaceOpensAt(time(start))).toBe(time(open));
    expect(time(start) - HORSE_RACE_LOCK_BEFORE_MS).toBe(time(close));
  });

  it("opens every later weekday race after the previous scheduled duration and ten-second rest", () => {
    const starts = getHorseRaceDayStarts(time("2026-10-15T00:00:00+09:00"));
    for (const [index, startsAt] of starts.entries()) {
      if (index === 0) {
        continue;
      }
      const previous = starts[index - 1]!;
      expect(horseRaceOpensAt(startsAt)).toBe(previous + HORSE_RACE_DURATION_MS + 10_000);
      expect(horseRaceOpensAt(startsAt)).toBeLessThan(startsAt - HORSE_RACE_LOCK_BEFORE_MS);
    }
  });

  it.each([
    ["2026-10-15T00:00:00+09:00", "2026-10-15"],
    ["2026-10-14T15:00:00Z", "2026-10-15"],
    ["2026-10-15T23:59:59+09:00", "2026-10-15"],
  ])("uses the KST calendar day at %s", (now, day) => {
    expect(getHorseRaceDayStarts(time(now))).toEqual(
      Array.from({ length: 23 }, (_, index) => time(`${day}T09:00:00+09:00`) + index * 30 * 60_000),
    );
  });

  it.each(["2026-10-17T00:00:00+09:00", "2026-10-18T23:59:59+09:00"])(
    "has no weekend starts at %s",
    (now) => expect(getHorseRaceDayStarts(time(now))).toEqual([]),
  );

  it.each([
    ["2026-10-15T10:59:59+09:00", "2026-10-15T11:00:00+09:00"],
    ["2026-10-15T08:49:59+09:00", "2026-10-15T09:00:00+09:00"],
    ["2026-10-15T09:00:00+09:00", "2026-10-15T09:30:00+09:00"],
    ["2026-10-15T11:00:00+09:00", "2026-10-15T11:30:00+09:00"],
    ["2026-10-15T19:00:00+09:00", "2026-10-15T19:30:00+09:00"],
    ["2026-10-15T19:30:00+09:00", "2026-10-15T20:00:00+09:00"],
    ["2026-10-15T19:59:59+09:00", "2026-10-15T20:00:00+09:00"],
    ["2026-10-15T20:00:00+09:00", "2026-10-16T09:00:00+09:00"],
    ["2026-10-16T20:00:00+09:00", "2026-10-19T09:00:00+09:00"],
    ["2026-10-17T00:00:00+09:00", "2026-10-19T09:00:00+09:00"],
    ["2026-10-18T23:59:59+09:00", "2026-10-19T09:00:00+09:00"],
    ["2026-12-31T20:00:00+09:00", "2027-01-01T09:00:00+09:00"],
  ])("finds a strictly future weekday race from %s", (now, next) => {
    expect(nextHorseRaceStartsAt(time(now))).toBe(time(next));
  });
});

describe("horse racing fairness", () => {
  const horses = createRacingHorses("race-2026-10-15-11", "private-condition");

  it("keeps the named profiles and base win rates fixed across dates and hidden form", () => {
    expect(createRacingHorses("race-2026-10-15-11", "private-condition")).toEqual(horses);
    expect(createRacingHorses("race-2026-10-15-12", "private-condition")).not.toEqual(horses);
    expect(horses).toHaveLength(6);
    expect(horses.map((horse) => [horse.name, horse.speed, horse.stamina, horse.weight])).toEqual([
      ["모리", 94, 80, 32],
      ["파리", 76, 94, 19],
      ["포운", 82, 72, 12],
      ["로시", 70, 77, 8],
      ["하니", 90, 78, 25],
      ["쥬기", 55, 50, 4],
    ]);
    expect(
      createRacingHorses("another-day", "another-form").map((horse) => [
        horse.id,
        horse.speed,
        horse.stamina,
        horse.weight,
        horse.winProbability,
      ]),
    ).toEqual(
      horses.map((horse) => [
        horse.id,
        horse.speed,
        horse.stamina,
        horse.weight,
        horse.winProbability,
      ]),
    );
    expect(horses.reduce((sum, horse) => sum + horse.winProbability, 0)).toBeCloseTo(1, 12);
    for (const horse of horses) {
      expect(horse.condition).toBeGreaterThanOrEqual(15);
      expect(horse.condition).toBeLessThanOrEqual(100);
      expect(horse.rumor.length).toBeGreaterThan(15);
      expect(horse.rumor).not.toMatch(/\d|%/);
      expect(horse.winProbability).toBe(
        horse.weight / horses.reduce((sum, h) => sum + h.weight, 0),
      );
    }
  });

  it("keeps public speed and stamina stable while the hidden seed changes race-day condition", () => {
    const other = createRacingHorses("race-2026-10-15-11", "other-condition");
    expect(other.map((horse) => [horse.id, horse.speed, horse.stamina])).toEqual(
      horses.map((horse) => [horse.id, horse.speed, horse.stamina]),
    );
    expect(other.map((horse) => horse.condition)).not.toEqual(
      horses.map((horse) => horse.condition),
    );
  });

  it("binds the commitment to the race, complete public roster and secret seed", () => {
    const commitment = horseRaceCommitment("race", horses, "secret");
    expect(commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(horseRaceCommitment("race", horses.toReversed(), "secret")).toBe(commitment);
    expect(horseRaceCommitment("other-race", horses, "secret")).not.toBe(commitment);
    expect(horseRaceCommitment("race", horses, "other-secret")).not.toBe(commitment);
    const changedWeights = createRacingHorses("race-2026-10-15-11", "private-condition");
    const changedRumor = createRacingHorses("race-2026-10-15-11", "private-condition");
    for (const horse of changedWeights) {
      horse.weight += 1;
    }
    for (const horse of changedRumor) {
      horse.rumor += " 추가 소문";
    }
    expect(horseRaceCommitment("race", changedWeights, "secret")).not.toBe(commitment);
    expect(horseRaceCommitment("race", changedRumor, "secret")).not.toBe(commitment);
  });

  it("replays each draw as a permutation independently of roster ordering", () => {
    const order = drawHorseFinishOrder(horses, "draw-seed");
    expect(drawHorseFinishOrder(horses.toReversed(), "draw-seed")).toEqual(order);
    expect(order.toSorted((a, b) => a.localeCompare(b))).toEqual(
      horses.map((horse) => horse.id).toSorted((a, b) => a.localeCompare(b)),
    );
  });

  it("calibrates every fixed marginal win rate while the joker can occupy every rank", () => {
    const trials = 50_000;
    const wins = new Map<string, number>();
    const jokerRanks = [0, 0, 0, 0, 0, 0];
    for (let index = 0; index < trials; index++) {
      const order = drawHorseFinishOrder(horses, `calibration-${index}`);
      for (const [rank, id] of order.entries()) {
        if (rank === 0) {
          wins.set(id, (wins.get(id) ?? 0) + 1);
        }
        if (id === HORSE_RACING_JOKER_ID) {
          jokerRanks[rank] = (jokerRanks[rank] ?? 0) + 1;
        }
      }
    }
    for (const horse of horses) {
      expect(Math.abs((wins.get(horse.id) ?? 0) / trials - horse.winProbability)).toBeLessThan(
        0.008,
      );
    }
    expect(jokerRanks.every((count) => count > 0)).toBe(true);
    expect(jokerRanks.slice(3).reduce((sum, count) => sum + count, 0) / trials).toBeGreaterThan(
      0.8,
    );
    expect(jokerRanks.slice(0, 3).reduce((sum, count) => sum + count, 0) / trials).toBeLessThan(
      0.15,
    );
  });

  it("makes rookie form variable, steady form narrow and joker rumors uninformative about hot form", () => {
    const values = new Map<string, number[]>();
    const rumors = new Set<string>();
    const jokerRumorsByForm = { hot: new Set<string>(), cold: new Set<string>() };
    for (let index = 0; index < 600; index++) {
      for (const horse of createRacingHorses("same-race", `form-${index}`)) {
        const conditions = values.get(horse.id);
        if (conditions) {
          conditions.push(horse.condition);
        } else {
          values.set(horse.id, [horse.condition]);
        }
        rumors.add(horse.rumor);
        if (horse.id === HORSE_RACING_JOKER_ID) {
          jokerRumorsByForm[horse.condition >= 90 ? "hot" : "cold"].add(horse.rumor);
        }
      }
    }
    const rookie = values.get("3")!;
    const steady = values.get("4")!;
    expect(Math.max(...rookie) - Math.min(...rookie)).toBeGreaterThan(40);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(16);
    expect(rumors.size).toBeGreaterThan(300);
    expect(jokerRumorsByForm.hot.size).toBeGreaterThan(5);
    expect(
      [...jokerRumorsByForm.hot].filter((rumor) => jokerRumorsByForm.cold.has(rumor)).length /
        jokerRumorsByForm.hot.size,
    ).toBeGreaterThan(0.8);
  });

  it("replays monotonic animated positions and crosses the line in exactly the drawn order", () => {
    const seed = "photo-finish";
    const order = drawHorseFinishOrder(horses, seed);
    let previous = horseRacePositions(horses, order, seed, -1);
    expect(previous.every((horse) => horse.position === 0)).toBe(true);
    const crossed: string[] = [];
    expect(HORSE_RACE_DURATION_MS).toBe(180_000);
    for (let elapsed = 0; elapsed <= HORSE_RACE_DURATION_MS; elapsed += 250) {
      const positions = horseRacePositions(horses, order, seed, elapsed);
      expect(horseRacePositions(horses, order, seed, elapsed)).toEqual(positions);
      for (const horse of positions) {
        const earlier = previous.find((candidate) => candidate.horseId === horse.horseId);
        if (!earlier) {
          throw new Error("Horse disappeared during race replay");
        }
        expect(horse.position).toBeGreaterThanOrEqual(earlier.position);
        expect(horse.position).toBeLessThanOrEqual(100);
        if (horse.position === 100 && earlier.position < 100) {
          crossed.push(horse.horseId);
        }
      }
      previous = positions;
    }
    expect(crossed).toEqual(order);
    expect(previous.every((horse) => horse.position === 100)).toBe(true);
    expect(horseRacePositions(horses, order, seed, HORSE_RACE_DURATION_MS * 2)).toEqual(previous);
    expect(horseRacePositions(horses, order, seed, HORSE_RACE_DURATION_MS / 2)).not.toEqual(
      horseRacePositions(horses, order, "other-seed", HORSE_RACE_DURATION_MS / 2),
    );
  });

  it("holds actual progress for three fallen seconds and one recovery second without announcing future motion", () => {
    const seed = "stumble-replay";
    const order = drawHorseFinishOrder(horses, seed);
    const stumble = observeStumble(horses, order, seed);
    expect(stumble.startsAt).toBeGreaterThanOrEqual(20_000);
    expect(stumble.startsAt).toBeLessThanOrEqual(110_000);
    const positionAt = (elapsed: number) =>
      horseRacePositions(horses, order, seed, elapsed).find(
        (entry) => entry.horseId === stumble.horseId,
      )!;
    expect(
      horseRacePositions(horses, order, seed, stumble.startsAt - 1).every(
        (entry) => !("motion" in entry),
      ),
    ).toBe(true);
    const fallen = positionAt(stumble.startsAt);
    expect(fallen.motion).toBe("fallen");
    for (const elapsed of [1, 1_000, 2_999]) {
      expect(positionAt(stumble.startsAt + elapsed)).toEqual(fallen);
    }
    for (const elapsed of [3_000, 3_999]) {
      expect(positionAt(stumble.startsAt + elapsed)).toEqual({ ...fallen, motion: "recovering" });
    }
    expect(positionAt(stumble.startsAt + 4_000)).toEqual({
      horseId: fallen.horseId,
      position: fallen.position,
    });
    expect(positionAt(stumble.startsAt + 4_001).position).toBeGreaterThan(fallen.position);
    expect(
      horseRacePositions(horses, order, seed, 150_000).every((entry) => !("motion" in entry)),
    ).toBe(true);
    expect(
      horseRacePositions(horses, order, seed, HORSE_RACE_DURATION_MS).every(
        (entry) => entry.position === 100 && !("motion" in entry),
      ),
    ).toBe(true);
  });

  it("selects exactly one deterministic fall independently of form, stats, roster order or committed rank", () => {
    const changed = horses
      .toReversed()
      .map((horse) =>
        Object.assign({}, horse, { speed: 30, stamina: 20, condition: 15, weight: 1 }),
      );
    const fallingHorses = new Set<string>();
    const startTimes = new Set<number>();
    for (let index = 0; index < 12; index++) {
      const seed = `stumble-independent-${index}`;
      const order = drawHorseFinishOrder(horses, seed);
      const stumble = observeStumble(horses, order, seed);
      expect(observeStumble(horses, order, seed)).toEqual(stumble);
      expect(observeStumble(changed, order.toReversed(), seed)).toEqual(stumble);
      const observed = new Set<string>();
      for (let elapsed = 20_000; elapsed <= 114_000; elapsed += 500) {
        const active = horseRacePositions(horses, order, seed, elapsed).filter(
          (entry) => entry.motion,
        );
        expect(active.length).toBeLessThanOrEqual(1);
        for (const horse of active) {
          observed.add(horse.horseId);
        }
      }
      expect([...observed]).toEqual([stumble.horseId]);
      fallingHorses.add(stumble.horseId);
      startTimes.add(stumble.startsAt);
    }
    expect(fallingHorses.size).toBeGreaterThan(1);
    expect(startTimes.size).toBeGreaterThan(1);
  });
});
