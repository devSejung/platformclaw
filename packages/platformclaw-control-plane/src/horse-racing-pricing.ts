import {
  HorseRacingError,
  HORSE_RACING_FEE_PERCENT,
  HORSE_RACING_MIN_BET_GOLD,
  HORSE_RACING_MAX_BET_GOLD,
  type HorseBetMarket,
  type RacingHorse,
} from "./horse-racing-contracts.js";
import { horseRaceScenarios } from "./horse-racing-profile.js";

type ProbabilityFraction = { numerator: bigint; denominator: bigint };

function reduceFraction(numerator: bigint, denominator: bigint): ProbabilityFraction {
  let divisor = denominator;
  let remainder = numerator;
  while (remainder !== 0n) {
    [divisor, remainder] = [remainder, divisor % remainder];
  }
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function addFractions(left: ProbabilityFraction, right: ProbabilityFraction): ProbabilityFraction {
  return reduceFraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function topThreePairProbability(
  horses: { id: string; weight: number }[],
  selection: string[],
  total: bigint,
): ProbabilityFraction {
  let probability = { numerator: 0n, denominator: 1n };
  // Enumerate the scenario's ordered top three, including every possible third horse.
  // These disjoint events can be summed exactly; adding top-two pair odds would omit valid places.
  for (const first of horses) {
    for (const second of horses) {
      if (second.id === first.id) {
        continue;
      }
      for (const third of horses) {
        if (
          third.id === first.id ||
          third.id === second.id ||
          !selection.every((id) => id === first.id || id === second.id || id === third.id)
        ) {
          continue;
        }
        const firstWeight = BigInt(first.weight);
        const secondWeight = BigInt(second.weight);
        const numerator = firstWeight * secondWeight * BigInt(third.weight);
        const denominator = total * (total - firstWeight) * (total - firstWeight - secondWeight);
        probability = addFractions(probability, { numerator, denominator });
      }
    }
  }
  return probability;
}

export function quoteHorsePayout(
  quote: { numerator: string; denominator: string },
  amount: number,
): number {
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new HorseRacingError("invalid_bet", "베팅금은 1G 이상의 안전한 정수여야 합니다.");
  }
  if (!/^[1-9]\d*$/u.test(quote.numerator) || !/^[1-9]\d*$/u.test(quote.denominator)) {
    throw new HorseRacingError("invalid_quote", "확정 배당 정보가 유효하지 않습니다.");
  }
  const payout = (BigInt(amount) * BigInt(quote.numerator)) / BigInt(quote.denominator);
  if (payout > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HorseRacingError("invalid_bet", "예상 지급액이 포인트 정수 범위를 초과합니다.");
  }
  return Number(payout);
}

export function quoteHorseBet(
  horses: RacingHorse[],
  market: HorseBetMarket,
  selection: string[],
  amount: number,
): {
  probability: number;
  odds: number;
  potentialPayout: number;
  numerator: string;
  denominator: string;
} {
  if (
    !Number.isSafeInteger(amount) ||
    amount < HORSE_RACING_MIN_BET_GOLD ||
    amount > HORSE_RACING_MAX_BET_GOLD
  ) {
    throw new HorseRacingError(
      "invalid_bet",
      `베팅금은 ${HORSE_RACING_MIN_BET_GOLD}~${HORSE_RACING_MAX_BET_GOLD}G 정수여야 합니다.`,
    );
  }
  if (
    horses.some((horse) => !Number.isSafeInteger(horse.weight) || horse.weight <= 0) ||
    new Set(horses.map((horse) => horse.id)).size !== horses.length
  ) {
    throw new HorseRacingError("invalid_roster", "출전마 확률 정보가 유효하지 않습니다.");
  }
  const selected = horses.filter((horse) => selection.includes(horse.id));
  if (
    (market !== "win" && market !== "quinella" && market !== "quinella-place") ||
    selection.length !== (market === "win" ? 1 : 2) ||
    selected.length !== selection.length
  ) {
    throw new HorseRacingError(
      "invalid_selection",
      "단승은 출전마 1마리, 복승·복연승은 서로 다른 출전마 2마리를 선택하세요.",
    );
  }
  if (market === "quinella-place" && horses.length < 3) {
    throw new HorseRacingError(
      "invalid_roster",
      "복연승은 출전마가 3마리 이상인 경주에서 선택하세요.",
    );
  }
  let probability = { numerator: 0n, denominator: 1n };
  for (const scenario of horseRaceScenarios(horses)) {
    const total = scenario.horses.reduce((sum, horse) => sum + BigInt(horse.weight), 0n);
    const scenarioSelection = scenario.horses.filter((horse) => selection.includes(horse.id));
    let branchNumerator = scenarioSelection.reduce(
      (product, horse) => product * BigInt(horse.weight),
      1n,
    );
    let branchDenominator = total;
    if (market === "quinella") {
      // Each scenario is weighted PL: sum both top-two orders, then mix exact probabilities.
      const selectedWeight = scenarioSelection.reduce(
        (sum, horse) => sum + BigInt(horse.weight),
        0n,
      );
      branchNumerator *= 2n * total - selectedWeight;
      branchDenominator *= scenarioSelection.reduce(
        (product, horse) => product * (total - BigInt(horse.weight)),
        1n,
      );
    }
    const branch =
      market === "quinella-place"
        ? topThreePairProbability(scenario.horses, selection, total)
        : { numerator: branchNumerator, denominator: branchDenominator };
    probability = addFractions(probability, {
      numerator: branch.numerator * scenario.numerator,
      denominator: branch.denominator * scenario.denominator,
    });
  }
  // Apply the fee to the full principal-included multiplier, then floor only once in quoteHorsePayout.
  const multiplier = reduceFraction(
    probability.denominator * BigInt(100 - HORSE_RACING_FEE_PERCENT),
    probability.numerator * 100n,
  );
  const quote = {
    numerator: String(multiplier.numerator),
    denominator: String(multiplier.denominator),
  };
  return {
    probability: Number(probability.numerator) / Number(probability.denominator),
    odds: Number(multiplier.numerator) / Number(multiplier.denominator),
    potentialPayout: quoteHorsePayout(quote, amount),
    ...quote,
  };
}
