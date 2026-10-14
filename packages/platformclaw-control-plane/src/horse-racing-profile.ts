import { HORSE_RACING_JOKER_ID } from "./horse-racing-contracts.js";

type ProfileWeight = { id: string; weight: number };
export type HorseRaceScenario = {
  numerator: bigint;
  denominator: bigint;
  horses: ProfileWeight[];
  jokerForm: "cold" | "hot" | null;
};

/** One shared rule for drawing, exact pricing and browser replay of the joker's hidden form. */
export function horseRaceScenarios(horses: readonly ProfileWeight[]): HorseRaceScenario[] {
  if (!horses.some((horse) => horse.id === HORSE_RACING_JOKER_ID)) {
    return [{ numerator: 1n, denominator: 1n, horses: [...horses], jokerForm: null }];
  }
  // With the fixed regular weights summing to 96, this mixture gives Juki exactly 4% wins
  // and every regular horse its weight/100. Both branches allow every finishing position.
  return (
    [
      { numerator: 2231n, denominator: 2375n, jokerForm: "cold", jokerWeight: 1 },
      { numerator: 144n, denominator: 2375n, jokerForm: "hot", jokerWeight: 96 },
    ] as const
  ).map((scenario) => ({
    numerator: scenario.numerator,
    denominator: scenario.denominator,
    jokerForm: scenario.jokerForm,
    horses: horses.map((horse) => ({
      id: horse.id,
      weight: horse.id === HORSE_RACING_JOKER_ID ? scenario.jokerWeight : horse.weight,
    })),
  }));
}

export function selectHorseRaceScenario(
  scenarios: HorseRaceScenario[],
  sample: number,
): HorseRaceScenario {
  let draw = sample;
  for (const scenario of scenarios) {
    draw -= Number(scenario.numerator) / Number(scenario.denominator);
    if (draw < 0) {
      return scenario;
    }
  }
  return scenarios[scenarios.length - 1]!;
}
