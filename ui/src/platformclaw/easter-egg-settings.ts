import { getSafeLocalStorage } from "../local-storage.ts";

// Club-inspired screen colors and compact cap initials, not reproductions of official logos.
// Cap and jersey colors are separate: e.g. Hanwha wears navy caps with orange marks.
export const BASEBALL_TEAMS = [
  { id: "neutral", name: "기본", color: "", capColor: "", capMark: "", capMarkColor: "" },
  {
    id: "kia",
    name: "KIA 타이거즈",
    color: "#EA0029",
    capColor: "#EA0029",
    capMark: "T",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "kt",
    name: "KT 위즈",
    color: "#ED2024",
    capColor: "#111111",
    capMark: "KW",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "lg",
    name: "LG 트윈스",
    color: "#C30452",
    capColor: "#111111",
    capMark: "T",
    capMarkColor: "#C30452",
  },
  {
    id: "nc",
    name: "NC 다이노스",
    color: "#315288",
    capColor: "#315288",
    capMark: "NC",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "ssg",
    name: "SSG 랜더스",
    color: "#CE0E2D",
    capColor: "#CE0E2D",
    capMark: "L",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "doosan",
    name: "두산 베어스",
    color: "#131230",
    capColor: "#131230",
    capMark: "B",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "lotte",
    name: "롯데 자이언츠",
    color: "#D00F31",
    capColor: "#041E42",
    capMark: "G",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "samsung",
    name: "삼성 라이온즈",
    color: "#074CA1",
    capColor: "#074CA1",
    capMark: "SL",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "kiwoom",
    name: "키움 히어로즈",
    color: "#570514",
    capColor: "#570514",
    capMark: "H",
    capMarkColor: "#FFFFFF",
  },
  {
    id: "hanwha",
    name: "한화 이글스",
    color: "#FC4E00",
    capColor: "#07111F",
    capMark: "E",
    capMarkColor: "#FC4E00",
  },
] as const;

type BaseballTeamId = (typeof BASEBALL_TEAMS)[number]["id"];
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
