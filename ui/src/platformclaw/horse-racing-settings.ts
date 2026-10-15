import { getSafeLocalStorage } from "../local-storage.ts";

export function isHorseRacingOpacity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 30 &&
    value <= 100 &&
    value % 5 === 0
  );
}

function settingsKey(scope: string): string {
  return `platformclaw.racing.opacity.v1:${scope}`;
}

export function loadHorseRacingOpacity(scope: string | null): number {
  if (!scope) {
    return 100;
  }
  try {
    const value: unknown = JSON.parse(getSafeLocalStorage()?.getItem(settingsKey(scope)) ?? "null");
    return isHorseRacingOpacity(value) ? value : 100;
  } catch {
    return 100;
  }
}

export function saveHorseRacingOpacity(scope: string | null, opacity: number): boolean {
  if (!scope || !isHorseRacingOpacity(opacity)) {
    return false;
  }
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return false;
    }
    storage.setItem(settingsKey(scope), JSON.stringify(opacity));
    return true;
  } catch {
    return false;
  }
}
