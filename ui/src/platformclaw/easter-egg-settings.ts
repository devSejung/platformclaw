import { getSafeLocalStorage } from "../local-storage.ts";

// Team names verified against KBO's official club directory. Colors are cosmetic only.
export const BASEBALL_TEAMS = [
  { id: "neutral", name: "기본", color: "" },
  { id: "kia", name: "KIA 타이거즈", color: "#d63e48" },
  { id: "kt", name: "KT 위즈", color: "#d94651" },
  { id: "lg", name: "LG 트윈스", color: "#db4273" },
  { id: "nc", name: "NC 다이노스", color: "#579bce" },
  { id: "ssg", name: "SSG 랜더스", color: "#da4852" },
  { id: "doosan", name: "두산 베어스", color: "#6587c6" },
  { id: "lotte", name: "롯데 자이언츠", color: "#5ca7cf" },
  { id: "samsung", name: "삼성 라이온즈", color: "#488bdb" },
  { id: "kiwoom", name: "키움 히어로즈", color: "#ba5c86" },
  { id: "hanwha", name: "한화 이글스", color: "#e87932" },
] as const;

export type BaseballTeamId = (typeof BASEBALL_TEAMS)[number]["id"];
export type BaseballSettings = { teamId: BaseballTeamId; opacity: number };
export const BASEBALL_DEFAULT_SETTINGS: BaseballSettings = { teamId: "neutral", opacity: 100 };

export function isBaseballTeamId(value: unknown): value is BaseballTeamId {
  return BASEBALL_TEAMS.some((team) => team.id === value);
}

function normalizeSettings(value: unknown): BaseballSettings {
  const parsed = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const opacity = parsed.opacity;
  return {
    teamId: isBaseballTeamId(parsed.teamId) ? parsed.teamId : "neutral",
    opacity:
      typeof opacity === "number" &&
      Number.isInteger(opacity) &&
      opacity >= 30 &&
      opacity <= 100 &&
      opacity % 5 === 0
        ? opacity
        : 100,
  };
}

function settingsKey(scope: string): string {
  return `platformclaw.baseball.settings.v1:${scope}`;
}

export function loadBaseballSettings(scope: string | null): BaseballSettings {
  if (!scope) {
    return { ...BASEBALL_DEFAULT_SETTINGS };
  }
  try {
    return normalizeSettings(
      JSON.parse(getSafeLocalStorage()?.getItem(settingsKey(scope)) ?? "null"),
    );
  } catch {
    return { ...BASEBALL_DEFAULT_SETTINGS };
  }
}

export function saveBaseballSettings(scope: string | null, settings: BaseballSettings): boolean {
  if (!scope) {
    return false;
  }
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return false;
    }
    storage.setItem(settingsKey(scope), JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
