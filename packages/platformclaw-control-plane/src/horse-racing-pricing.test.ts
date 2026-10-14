import { describe, expect, it } from "vitest";
import {
  HORSE_RACING_MIN_BET_GOLD,
  HORSE_RACING_MAX_BET_GOLD,
  type HorseBetMarket,
  type RacingHorse,
} from "./horse-racing-contracts.js";
import { createRacingHorses, drawHorseFinishOrder } from "./horse-racing-engine.js";
import { quoteHorseBet, quoteHorsePayout } from "./horse-racing-pricing.js";

const MARKETS = ["win", "quinella", "quinella-place"] as const;

function roster(weights: number[]): RacingHorse[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight, index) => ({
    id: `horse-${index + 1}`,
    name: `Horse ${index + 1}`,
    color: "#fff",
    speed: 75,
    stamina: 75,
    condition: 100,
    weight,
    winProbability: weight / total,
    rumor: "마구간에서는 오늘도 당근 이야기가 한창입니다.",
  }));
}

function selections(horses: RacingHorse[], market: HorseBetMarket): string[][] {
  return market === "win"
    ? horses.map((horse) => [horse.id])
    : horses.flatMap((first) =>
        horses.filter((second) => second.id > first.id).map((second) => [first.id, second.id]),
      );
}

describe("fixed horse bet pricing with a three-percent payout fee", () => {
  it.each([
    ["win", ["horse-1"], 1 / 6, 5.82, 582, "291", "50"],
    ["quinella", ["horse-1", "horse-2"], 1 / 15, 14.55, 1455, "291", "20"],
    ["quinella-place", ["horse-1", "horse-2"], 1 / 5, 4.85, 485, "97", "20"],
  ] satisfies [HorseBetMarket, string[], number, number, number, string, string][])(
    "quotes equal-weight %s from the true probability, with principal and fee included",
    (market, selection, probability, odds, potentialPayout, numerator, denominator) => {
      expect(quoteHorseBet(roster([1, 1, 1, 1, 1, 1]), market, selection, 100)).toEqual({
        probability,
        odds,
        potentialPayout,
        numerator,
        denominator,
      });
    },
  );

  it("sums both top-two orders and floors only after applying the exact fee", () => {
    const horses = roster([1, 2, 3]);
    const quote = quoteHorseBet(horses, "quinella", ["horse-1", "horse-2"], 52);
    const probability = ((1 / 6) * 2) / 5 + ((2 / 6) * 1) / 4;
    expect(quote.probability).toBeCloseTo(probability, 14);
    expect(quote.odds).toBeCloseTo(97 / 15, 14);
    expect(quote.potentialPayout).toBe(336);
    expect(Math.floor(Math.floor(52 / probability) * 0.97)).toBe(335);
    expect({ numerator: quote.numerator, denominator: quote.denominator }).toEqual({
      numerator: "97",
      denominator: "15",
    });
    expect(quoteHorseBet(horses, "quinella", ["horse-2", "horse-1"], 52)).toEqual(quote);
    expect(quoteHorseBet(horses.toReversed(), "quinella", ["horse-1", "horse-2"], 52)).toEqual(
      quote,
    );
  });

  it.each(MARKETS)(
    "covers %s probabilities and a 97%% expected payout before integer rounding",
    (market) => {
      const horses = createRacingHorses("coverage-race", "private-form");
      const quotes = selections(horses, market).map((selection) =>
        quoteHorseBet(horses, market, selection, 1_000),
      );
      // A top-three outcome contains three winning pair selections; those events overlap.
      expect(quotes.reduce((sum, quote) => sum + quote.probability, 0)).toBeCloseTo(
        market === "quinella-place" ? 3 : 1,
        13,
      );
      for (const quote of quotes) {
        expect(quote.probability * quote.odds).toBeCloseTo(0.97, 14);
        const expectedReturn = quote.probability * quote.potentialPayout;
        expect(expectedReturn).toBeLessThanOrEqual(970 + 1e-10);
        expect(970 - expectedReturn).toBeLessThan(quote.probability + 1e-10);
        expect(quoteHorsePayout(quote, 1_000)).toBe(quote.potentialPayout);
      }
    },
  );

  it("includes the third horse and all top-three orders in an unequal place pair", () => {
    const horses = roster([1, 2, 3]);
    for (const selection of selections(horses, "quinella-place")) {
      expect(quoteHorseBet(horses, "quinella-place", selection, 100)).toEqual({
        probability: 1,
        odds: 0.97,
        potentialPayout: 97,
        numerator: "97",
        denominator: "100",
      });
    }
    expect(() =>
      quoteHorseBet(roster([1, 2]), "quinella-place", ["horse-1", "horse-2"], 50),
    ).toThrow(/3마리/);
  });

  it("keeps profile win odds fixed while condition changes and prices the joker mixture exactly", () => {
    const horses = createRacingHorses("fixed-profile-race", "private-form");
    const other = createRacingHorses("other-race", "other-private-form");
    for (const horse of horses) {
      const quote = quoteHorseBet(horses, "win", [horse.id], 100);
      expect(quote.probability).toBeCloseTo(horse.weight / 100, 14);
      expect(quote.odds).toBeCloseTo(97 / horse.weight, 14);
      expect(quote.potentialPayout).toBe(Math.floor(9_700 / horse.weight));
      expect(quoteHorseBet(other, "win", [horse.id], 100)).toEqual(quote);
    }
    const quote = quoteHorseBet(horses, "quinella", ["1", "6"], 100);
    const cold = ((32 / 97) * 1) / 65 + ((1 / 97) * 32) / 96;
    const hot = ((32 / 192) * 96) / 160 + ((96 / 192) * 32) / 96;
    expect(quote.probability).toBeCloseTo((2231 / 2375) * cold + (144 / 2375) * hot, 14);
    expect(quoteHorseBet(horses, "quinella", ["6", "1"], 100)).toEqual(quote);
  });

  it("calibrates all markets against 20,000 actual joker-mixture race draws", () => {
    const horses = createRacingHorses("pricing-race", "pricing-private-form");
    const counts = new Map<string, number>();
    const trials = 20_000;
    const record = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
    for (let index = 0; index < trials; index++) {
      const order = drawHorseFinishOrder(horses, `pricing-calibration-${index}`);
      record(`win:${order[0]}`);
      record(
        `quinella:${order
          .slice(0, 2)
          .toSorted((a, b) => a.localeCompare(b))
          .join(",")}`,
      );
      const topThree = order.slice(0, 3);
      for (const first of topThree) {
        for (const second of topThree.filter((id) => id > first)) {
          record(`quinella-place:${first},${second}`);
        }
      }
    }
    for (const market of MARKETS) {
      for (const selection of selections(horses, market)) {
        const quote = quoteHorseBet(horses, market, selection, 100);
        expect(
          Math.abs(
            (counts.get(`${market}:${selection.join(",")}`) ?? 0) / trials - quote.probability,
          ),
        ).toBeLessThan(0.013);
      }
    }
  });

  it.each([
    ["win", []],
    ["win", ["horse-1", "horse-2"]],
    ["win", ["unknown"]],
    ["quinella", ["horse-1"]],
    ["quinella", ["horse-1", "horse-1"]],
    ["quinella-place", ["horse-1", "unknown"]],
    ["quinella-place", ["horse-1", "horse-1"]],
  ] satisfies [HorseBetMarket, string[]][])(
    "rejects invalid %s selections %j",
    (market, selection) => {
      expect(() => quoteHorseBet(roster([1, 2, 3]), market, selection, 50)).toThrow(/출전마/);
    },
  );

  it.each([
    0,
    -1,
    49,
    50.5,
    1_001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects a stake outside the 50..1000 integer range: %s", (amount) => {
    expect(() => quoteHorseBet(roster([1, 2, 3]), "win", ["horse-1"], amount)).toThrow(/베팅금/);
  });

  it("accepts both shared limits and rejects invalid published weights", () => {
    expect(
      quoteHorseBet(roster([1, 2, 3]), "win", ["horse-1"], HORSE_RACING_MIN_BET_GOLD)
        .potentialPayout,
    ).toBe(291);
    expect(
      quoteHorseBet(roster([1, 2, 3]), "win", ["horse-1"], HORSE_RACING_MAX_BET_GOLD)
        .potentialPayout,
    ).toBe(5_820);
    expect(() => quoteHorseBet(roster([0, 2, 3]), "win", ["horse-1"], 50)).toThrow(/확률/);
    expect(() => quoteHorseBet(roster([1.5, 2, 3]), "win", ["horse-1"], 50)).toThrow(/확률/);
  });

  it("settles the frozen public ratio with exact integer arithmetic without applying fees a second time", () => {
    const quote = quoteHorseBet(roster([100, 200, 300]), "win", ["horse-2"], 100);
    expect({ numerator: quote.numerator, denominator: quote.denominator }).toEqual({
      numerator: "291",
      denominator: "100",
    });
    expect(quoteHorsePayout(quote, 100)).toBe(291);
    const frozenExperimentalQuote = { numerator: "7", denominator: "6" };
    const amount = 6_000_000_000_000_003;
    expect(quoteHorsePayout(frozenExperimentalQuote, amount)).toBe(
      Number((BigInt(amount) * 7n) / 6n),
    );
    expect(Math.floor((amount * 7) / 6)).not.toBe(
      quoteHorsePayout(frozenExperimentalQuote, amount),
    );
    expect(() => quoteHorsePayout({ numerator: "20", denominator: "0" }, 100)).toThrow(/배당/);
    expect(() => quoteHorsePayout({ numerator: "-20", denominator: "3" }, 100)).toThrow(/배당/);
    expect(() =>
      quoteHorsePayout({ numerator: "6", denominator: "1" }, Number.MAX_SAFE_INTEGER),
    ).toThrow(/범위/);
  });
});
