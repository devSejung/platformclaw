import type { HorseRaceSnapshot } from "../../../packages/platformclaw-control-plane/src/horse-racing-contracts.ts";

export function horseLabel(race: HorseRaceSnapshot, id: string): string {
  const index = race.horses.findIndex((horse) => horse.id === id);
  return `${index + 1} ${race.horses[index]?.name ?? ""}`;
}

/** A confirmed finish place outranks equal 100% progress; unfinished horses use observed progress. */
export function horseRaceOrder(race: HorseRaceSnapshot): string[] {
  return (
    race.finishOrder ??
    race.positions
      .toSorted(
        (a, b) =>
          (a.finishPlace ?? Infinity) - (b.finishPlace ?? Infinity) || b.position - a.position,
      )
      .map((entry) => entry.horseId)
  );
}
