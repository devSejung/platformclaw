import {
  HORSE_RACING_ALGORITHM_VERSION,
  type HorseRaceSnapshot,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";
import {
  horseRaceScenarios,
  selectHorseRaceScenario,
} from "../../../packages/platformclaw-control-plane/src/horse-racing-profile.ts";

async function digest(value: unknown): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  );
}

/** Recompute the published server draw, without trusting its claimed winner. */
export async function verifyHorseRace(race: HorseRaceSnapshot): Promise<boolean> {
  if (
    !race.revealedSeed ||
    !race.finishOrder ||
    race.algorithmVersion !== HORSE_RACING_ALGORITHM_VERSION ||
    (race.status !== "settled" && race.status !== "cancelled")
  ) {
    return false;
  }
  const horses = race.horses
    .flatMap((horse) => {
      if (horse.condition === null || horse.weight === null || horse.winProbability === null) {
        return [];
      }
      return [
        {
          id: horse.id,
          name: horse.name,
          color: horse.color,
          speed: horse.speed,
          stamina: horse.stamina,
          condition: horse.condition,
          weight: horse.weight,
          winProbability: horse.winProbability,
          rumor: horse.rumor,
        },
      ];
    })
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (horses.length !== race.horses.length) {
    return false;
  }
  const roster = horses.map((horse) => [
    horse.id,
    horse.name,
    horse.color,
    horse.speed,
    horse.stamina,
    horse.condition,
    horse.weight,
    horse.winProbability,
    horse.rumor,
  ]);
  const commitmentBytes = await digest([race.algorithmVersion, race.id, roster, race.revealedSeed]);
  const commitment = Array.from(commitmentBytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  if (commitment !== race.commitment) {
    return false;
  }
  const randomSample = (bytes: Uint8Array) =>
    bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0) / 281_474_976_710_656;
  const scenarioBytes = await digest([race.algorithmVersion, race.revealedSeed, 0]);
  const remaining = selectHorseRaceScenario(
    horseRaceScenarios(horses),
    randomSample(scenarioBytes),
  ).horses;
  const order: string[] = [];
  for (let counter = 1; remaining.length > 0; counter += 1) {
    const bytes = await digest([race.algorithmVersion, race.revealedSeed, counter]);
    const sample = randomSample(bytes);
    let draw = sample * remaining.reduce((sum, horse) => sum + horse.weight, 0);
    const index = remaining.findIndex((horse) => {
      draw -= horse.weight;
      return draw < 0;
    });
    order.push(...remaining.splice(index, 1).map((horse) => horse.id));
  }
  return (
    order.length === race.finishOrder.length &&
    order.every((id, index) => id === race.finishOrder?.[index])
  );
}
