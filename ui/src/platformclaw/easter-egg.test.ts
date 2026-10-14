import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballLeaderboard,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { i18n } from "../i18n/index.ts";
import {
  BASEBALL_TEAMS,
  loadBaseballSettings,
  saveBaseballSettings,
} from "./easter-egg-settings.ts";
import { classifyTimingDelta, formatTimingFeedback } from "./easter-egg-timing.ts";
import { PLATFORMCLAW_EASTER_EGG_EVENT, recordPlatformClawEasterEggClick } from "./easter-egg.ts";
import { loadAllPlatformClawLocales } from "./i18n.ts";
import "./easter-egg-game.ts";

type EasterEggElement = HTMLElement & {
  client: { request<T>(method: string, params?: unknown): Promise<T> } | null;
  now: () => number;
  random: () => number;
  updateComplete: Promise<unknown>;
};

function progress(overrides: Partial<BaseballProgress> = {}): BaseballProgress {
  return {
    gold: 0,
    ownedBatIds: ["wood"],
    equippedBatId: "wood",
    totalHomers: 0,
    bestDistanceM: 0,
    currentHomeRunStreak: 0,
    bestHomeRunStreak: 0,
    revision: 0,
    ...overrides,
  };
}

function leaderboard(overrides: Partial<BaseballLeaderboard> = {}): BaseballLeaderboard {
  return {
    distance: [],
    homeRunStreak: [],
    ...overrides,
  };
}

async function flush(element: EasterEggElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
}

function atBat(batId: BaseballProgress["equippedBatId"] = "wood", pitchSample = 0) {
  return {
    id: "test-at-bat",
    pitchSample,
    batId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 120_000,
  };
}

async function openBaseball(egg: EasterEggElement): Promise<void> {
  window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
  await egg.updateComplete;
  egg.querySelector<HTMLButtonElement>('[data-game-choice="baseball"]')!.click();
  await flush(egg);
}
describe("PlatformClaw easter egg", () => {
  beforeEach(() => {
    document.body.replaceChildren(document.createElement("platformclaw-easter-egg"));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("opens after seven taps within the three-second gesture window", async () => {
    const listener = vi.fn();
    window.addEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, listener);
    try {
      for (let index = 0; index < 6; index += 1) {
        expect(recordPlatformClawEasterEggClick(1_000 + index * 400)).toBe(false);
      }
      expect(recordPlatformClawEasterEggClick(3_400)).toBe(true);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
    } finally {
      window.removeEventListener(PLATFORMCLAW_EASTER_EGG_EVENT, listener);
    }
  });

  it("resets the gesture after a pause", () => {
    for (let index = 0; index < 6; index += 1) {
      recordPlatformClawEasterEggClick(2_000 + index * 100);
    }
    expect(recordPlatformClawEasterEggClick(5_600)).toBe(false);
    expect(recordPlatformClawEasterEggClick(5_700)).toBe(false);
  });

  it("classifies timing at the inclusive timing boundaries", () => {
    expect(classifyTimingDelta(0)).toBe("PERFECT");
    expect(classifyTimingDelta(25)).toBe("PERFECT");
    expect(classifyTimingDelta(-25)).toBe("PERFECT");
    expect(classifyTimingDelta(26)).toBe("GOOD");
    expect(classifyTimingDelta(-50)).toBe("GOOD");
    expect(classifyTimingDelta(51)).toBe("HIT");
    expect(classifyTimingDelta(-100)).toBe("HIT");
    expect(classifyTimingDelta(101)).toBe("MISS");
  });

  it("formats timing feedback", () => {
    expect(formatTimingFeedback(0, "PERFECT")).toBe("PERFECT");
    expect(formatTimingFeedback(-54, "GOOD")).toBe("54ms 빠름");
    expect(formatTimingFeedback(32, "HIT")).toBe("32ms 느림");
    expect(formatTimingFeedback(101, "MISS")).toBe("MISS");
  });

  it("starts a baseball game, ignores Space in inputs, and closes on Escape", async () => {
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    await openBaseball(egg);
    await egg.updateComplete;
    await Promise.resolve();
    await egg.updateComplete;

    const game = egg.querySelector('[role="application"]');
    expect(game).not.toBeNull();
    expect(document.body.classList.contains("platformclaw-baseball-active")).toBe(true);
    expect(game?.getAttribute("aria-label")).toBe("PlatformClaw Stickman Baseball");
    expect(egg.querySelector(".platformclaw-easter-egg__score")?.textContent).toContain("안타 0");
    expect(egg.querySelector(".platformclaw-easter-egg__score")?.textContent).toContain("홈런 0");
    const hudMetrics = Array.from(
      egg.querySelectorAll<HTMLElement>(".platformclaw-easter-egg__hud > span"),
      (element) => element.textContent,
    );
    expect(hudMetrics).not.toContain("안타 0");
    expect(hudMetrics).not.toContain("홈런 0");
    expect(egg.querySelector(".platformclaw-easter-egg__hud")?.textContent).toContain(
      "연속 홈런 0",
    );
    expect(egg.querySelector(".platformclaw-easter-egg__hud")?.textContent).toContain("최고 0m");
    expect(egg.querySelector(".platformclaw-easter-egg__player")?.textContent).toContain("타자");
    expect(egg.querySelector(".platformclaw-easter-egg__target")?.textContent).toContain("투수");
    expect(egg.querySelector(".platformclaw-easter-egg__wind")).toBeNull();
    expect(egg.querySelector(".platformclaw-easter-egg__home-plate")).toBeNull();
    expect(
      egg.querySelector(".platformclaw-easter-egg__player .platformclaw-easter-egg__bat"),
    ).not.toBeNull();
    expect(
      egg.querySelector('.platformclaw-easter-egg__player [data-player-role="batter"]'),
    ).not.toBeNull();
    expect(
      egg.querySelector('.platformclaw-easter-egg__target [data-player-role="pitcher"]'),
    ).not.toBeNull();
    expect(
      egg.querySelector('.platformclaw-easter-egg__outfielder [data-player-role="outfielder"]'),
    ).not.toBeNull();
    expect(
      egg.querySelector(
        ".platformclaw-easter-egg__target .platformclaw-easter-egg__figure-arm-front",
      ),
    ).not.toBeNull();
    expect(
      egg.querySelectorAll(".platformclaw-easter-egg__player, .platformclaw-easter-egg__target"),
    ).toHaveLength(2);
    expect(egg.querySelector(".platformclaw-easter-egg__trajectory-line")).toBeNull();
    expect(egg.querySelectorAll(".platformclaw-easter-egg__trail-dot")).toHaveLength(9);

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }),
    );
    expect(game?.getAttribute("data-strikes")).toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await egg.updateComplete;
    expect(egg.querySelector('[role="application"]')).toBeNull();
    expect(document.body.classList.contains("platformclaw-baseball-active")).toBe(false);
  });

  it("loads account progress, pauses game timers in the shop, and lets Escape close only the shop", async () => {
    vi.useFakeTimers();
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    egg.now = () => Date.now();
    egg.random = () => 0;
    egg.client = {
      request: async <T>(method: string): Promise<T> => {
        if (method === BASEBALL_RPC.beginAtBat) {
          return atBat("wood", egg.random()) as T;
        }
        if (method === BASEBALL_RPC.progress) {
          return progress({ gold: 50, bestDistanceM: 168, currentHomeRunStreak: 2 }) as T;
        }
        if (method === BASEBALL_RPC.leaderboard) {
          return leaderboard({
            distance: [
              { displayName: "Person B", value: 172, isCurrentUser: false },
              { displayName: "Person A", value: 168, isCurrentUser: true },
            ],
            homeRunStreak: [{ displayName: "Person A", value: 4, isCurrentUser: true }],
          }) as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };
    await openBaseball(egg);
    await flush(egg);
    expect(egg.textContent).toContain("골드 50");
    expect(egg.textContent).toContain("최고 168m");
    expect(egg.textContent).toContain("연속 홈런 2");
    expect(egg.textContent).toContain("비거리 TOP 5");
    expect(egg.textContent).toContain("1. Person B");
    expect(egg.textContent).toContain("2. Person A (나)");
    expect(egg.textContent).toContain("연속 홈런 TOP 5");
    expect(
      egg.querySelector(".platformclaw-easter-egg > .platformclaw-easter-egg__leaderboards"),
    ).not.toBeNull();

    (egg.querySelector(".platformclaw-easter-egg__shop-trigger") as HTMLButtonElement).click();
    await egg.updateComplete;
    expect(egg.querySelector('[role="dialog"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(egg.querySelector('[role="application"]')?.getAttribute("data-pitch-state")).toBe(
      "ready",
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    await egg.updateComplete;
    expect(egg.querySelector('[role="dialog"]')).toBeNull();
    expect(egg.querySelector('[role="application"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(710);
    await egg.updateComplete;
    expect(egg.querySelector('[role="application"]')?.getAttribute("data-pitch-state")).toBe(
      "pitch",
    );
  });

  it("retries a purchase with the same request id and applies the confirmed server revision", async () => {
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    const purchaseParams: unknown[] = [];
    let purchases = 0;
    egg.client = {
      request: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === BASEBALL_RPC.beginAtBat) {
          return atBat("wood", egg.random()) as T;
        }
        if (method === BASEBALL_RPC.progress) {
          return progress({ gold: 50 }) as T;
        }
        if (method === BASEBALL_RPC.leaderboard) {
          return leaderboard() as T;
        }
        if (method === BASEBALL_RPC.purchaseBat) {
          purchaseParams.push(params);
          purchases += 1;
          if (purchases === 1) {
            throw new Error("response lost");
          }
          return {
            purchased: true,
            batId: "silver",
            price: 50,
            progress: progress({
              gold: 0,
              ownedBatIds: ["wood", "silver"],
              revision: 1,
            }),
          } as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };
    await openBaseball(egg);
    await flush(egg);
    (egg.querySelector(".platformclaw-easter-egg__shop-trigger") as HTMLButtonElement).click();
    await egg.updateComplete;
    (egg.querySelector('[data-shop-bat="silver"]') as HTMLButtonElement).click();
    await flush(egg);
    expect(egg.textContent).toContain("배트 구매 실패");
    const retry = Array.from(egg.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "재시도",
    ) as HTMLButtonElement;
    retry.click();
    await flush(egg);
    expect(purchaseParams).toHaveLength(2);
    expect(purchaseParams[1]).toEqual(purchaseParams[0]);
    expect(egg.textContent).toContain("골드 0");
    expect(egg.textContent).toContain("장착");
  });

  it("keeps the newest leaderboard when an older refresh finishes later", async () => {
    vi.useFakeTimers();
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    egg.now = () => Date.now();
    egg.random = () => 0;
    let releaseFirstLeaderboard!: (value: BaseballLeaderboard) => void;
    const firstLeaderboard = new Promise<BaseballLeaderboard>((resolve) => {
      releaseFirstLeaderboard = resolve;
    });
    let leaderboardRequests = 0;
    egg.client = {
      request: async <T>(method: string): Promise<T> => {
        if (method === BASEBALL_RPC.beginAtBat) {
          return atBat("wood", egg.random()) as T;
        }
        if (method === BASEBALL_RPC.progress) {
          return progress() as T;
        }
        if (method === BASEBALL_RPC.leaderboard) {
          leaderboardRequests += 1;
          if (leaderboardRequests === 1) {
            return firstLeaderboard as Promise<T>;
          }
          return leaderboard({
            distance: [{ displayName: "Newest", value: 160, isCurrentUser: false }],
          }) as T;
        }
        if (method === BASEBALL_RPC.plateAppearance) {
          return { awardedGold: 0, progress: progress() } as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };
    await egg.updateComplete;

    await openBaseball(egg);
    await flush(egg);
    expect(leaderboardRequests).toBe(1);

    await vi.advanceTimersByTimeAsync(1_600);
    await flush(egg);
    expect(leaderboardRequests).toBe(2);
    expect(egg.textContent).toContain("Newest");

    releaseFirstLeaderboard(
      leaderboard({
        distance: [{ displayName: "Stale", value: 120, isCurrentUser: false }],
      }),
    );
    await flush(egg);
    expect(egg.textContent).toContain("Newest");
    expect(egg.textContent).not.toContain("Stale");
  });

  it("keeps existing leaderboard rows visible when a refresh fails", async () => {
    vi.useFakeTimers();
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    egg.now = () => Date.now();
    egg.random = () => 0;
    let leaderboardRequests = 0;
    egg.client = {
      request: async <T>(method: string): Promise<T> => {
        if (method === BASEBALL_RPC.beginAtBat) {
          return atBat("wood", egg.random()) as T;
        }
        if (method === BASEBALL_RPC.progress) {
          return progress() as T;
        }
        if (method === BASEBALL_RPC.leaderboard) {
          leaderboardRequests += 1;
          if (leaderboardRequests === 1) {
            return leaderboard({
              distance: [{ displayName: "Existing", value: 150, isCurrentUser: true }],
            }) as T;
          }
          throw new Error("leaderboard unavailable");
        }
        if (method === BASEBALL_RPC.plateAppearance) {
          return { awardedGold: 0, progress: progress() } as T;
        }
        throw new Error(`unexpected method: ${method}`);
      },
    };
    await egg.updateComplete;

    await openBaseball(egg);
    await flush(egg);
    await vi.waitFor(() => expect(leaderboardRequests).toBe(1));
    await flush(egg);
    expect(egg.textContent).toContain("Existing");

    await vi.advanceTimersByTimeAsync(1_600);
    await flush(egg);
    await vi.waitFor(() => expect(leaderboardRequests).toBe(2));
    await flush(egg);
    expect(egg.textContent).toContain("Existing");
    expect(egg.textContent).toContain("랭킹 불러오기 실패");
  });

  it("ignores a late progress response after the gateway client changes", async () => {
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    let releaseFirst!: (value: BaseballProgress) => void;
    const firstProgress = new Promise<BaseballProgress>((resolve) => {
      releaseFirst = resolve;
    });
    egg.client = { request: async <T>(): Promise<T> => firstProgress as Promise<T> };
    await openBaseball(egg);
    await egg.updateComplete;

    egg.client = {
      request: async <T>(method: string): Promise<T> =>
        (method === BASEBALL_RPC.beginAtBat
          ? atBat()
          : method === BASEBALL_RPC.leaderboard
            ? leaderboard()
            : progress({ gold: 7, revision: 2 })) as T,
    };
    await flush(egg);
    releaseFirst(progress({ gold: 999, revision: 99 }));
    await flush(egg);
    expect(egg.textContent).toContain("골드 7");
    expect(egg.textContent).not.toContain("골드 999");
  });
});

type SettingsEgg = EasterEggElement & { preferenceScope: string | null };

const savedProgress: BaseballProgress = {
  gold: 1234,
  ownedBatIds: ["wood", "titanium", "diamond"],
  equippedBatId: "diamond",
  totalHomers: 9,
  bestDistanceM: 147,
  currentHomeRunStreak: 0,
  bestHomeRunStreak: 4,
  revision: 42,
};
const scopeA = JSON.stringify(["wss://synthetic.test/platformclaw/gateway", "account-a"]);
const scopeB = JSON.stringify(["wss://synthetic.test/platformclaw/gateway", "account-b"]);
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };

async function openSettingsGame(scope = scopeA) {
  const egg = document.createElement("platformclaw-easter-egg") as SettingsEgg;
  const request = vi.fn(async (method: string) => {
    if (method === BASEBALL_RPC.beginAtBat) {
      return atBat("diamond", egg.random());
    }
    if (method === BASEBALL_RPC.progress) {
      return { ...savedProgress };
    }
    if (method === BASEBALL_RPC.leaderboard) {
      return { distance: [], homeRunStreak: [] };
    }
    throw new Error(`unexpected mutation: ${method}`);
  });
  egg.client = { request: async <T>(method: string) => (await request(method)) as T };
  egg.preferenceScope = scope;
  document.body.append(egg);
  await egg.updateComplete;
  await openBaseball(egg);
  await flush(egg);
  egg.querySelector<HTMLButtonElement>(".platformclaw-easter-egg__shop-trigger")!.click();
  await flush(egg);
  return { egg, request };
}

function change(egg: SettingsEgg, selector: string, value: string, event: string): void {
  const input = egg.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event(event, { bubbles: true }));
}

describe("baseball local cosmetic settings", () => {
  beforeEach(async () => {
    await loadAllPlatformClawLocales();
    await i18n.setLocale("ko");
    const values = new Map<string, string>();
    storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(async () => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("restores each account and server independently and rejects corrupt or invisible settings", () => {
    const otherServer = JSON.stringify([
      "wss://other.synthetic.test/platformclaw/gateway",
      "account-a",
    ]);
    expect(saveBaseballSettings(scopeA, { teamId: "hanwha", opacity: 30 })).toBe(true);
    expect(loadBaseballSettings(scopeA)).toEqual({ teamId: "hanwha", opacity: 30 });
    expect(loadBaseballSettings(scopeB)).toEqual({ teamId: "neutral", opacity: 100 });
    expect(loadBaseballSettings(otherServer)).toEqual({ teamId: "neutral", opacity: 100 });
    for (const value of [
      "{",
      "null",
      '{"teamId":"unknown","opacity":0}',
      '{"opacity":31}',
      '{"opacity":"30"}',
    ]) {
      storage.getItem.mockReturnValueOnce(value);
      expect(loadBaseballSettings(scopeA)).toEqual({ teamId: "neutral", opacity: 100 });
    }
    expect(saveBaseballSettings(null, { teamId: "kia", opacity: 30 })).toBe(false);
  });

  it("offers all ten clubs for free, changes the batter appearance, and keeps server progress intact", async () => {
    const { egg, request } = await openSettingsGame();
    const select = egg.querySelector<HTMLSelectElement>("#baseball-team")!;
    expect(Array.from(select.options, (option) => option.text)).toEqual([
      "기본",
      "KIA 타이거즈",
      "KT 위즈",
      "LG 트윈스",
      "NC 다이노스",
      "SSG 랜더스",
      "두산 베어스",
      "롯데 자이언츠",
      "삼성 라이온즈",
      "키움 히어로즈",
      "한화 이글스",
    ]);
    for (const team of BASEBALL_TEAMS.slice(1)) {
      change(egg, "#baseball-team", team.id, "change");
      await flush(egg);
      const game = egg.querySelector<HTMLElement>('[role="application"]')!;
      expect(game.dataset.teamId).toBe(team.id);
      expect(game.style.getPropertyValue("--baseball-team-color")).toBe(team.color);
      expect(game.style.getPropertyValue("--baseball-cap-color")).toBe(team.capColor);
      expect(egg.querySelector(".platformclaw-easter-egg__cap-mark")?.textContent).toBe(
        team.capMark,
      );
      expect(egg.querySelectorAll(".platformclaw-easter-egg__cap")).toHaveLength(1);
      expect(game.dataset.batId).toBe("diamond");
      expect(egg.querySelector(".platformclaw-easter-egg__player")!.textContent).toContain(
        team.name,
      );
    }
    expect(egg.textContent).toContain("골드 1234");
    expect(egg.textContent).toContain("다음 누적 보너스까지 1홈런");
    expect(
      request.mock.calls.every(([method]) =>
        [BASEBALL_RPC.progress, BASEBALL_RPC.leaderboard, BASEBALL_RPC.beginAtBat].includes(
          method as typeof BASEBALL_RPC.progress,
        ),
      ),
    ).toBe(true);
  });

  it("saves opacity, restores it on reopening, and recovers without changing the team", async () => {
    const first = await openSettingsGame();
    change(first.egg, "#baseball-team", "lg", "change");
    change(first.egg, "#baseball-opacity", "30", "input");
    await flush(first.egg);
    expect(first.egg.querySelector<HTMLInputElement>("#baseball-opacity")!.min).toBe("30");
    expect(loadBaseballSettings(scopeA)).toEqual({ teamId: "lg", opacity: 30 });
    first.egg.remove();
    const { egg } = await openSettingsGame();
    expect(egg.querySelector<HTMLInputElement>("#baseball-opacity")!.value).toBe("30");
    expect(egg.querySelector<HTMLSelectElement>("#baseball-team")!.value).toBe("lg");
    Array.from(egg.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "100%로 복구")!
      .click();
    await flush(egg);
    expect(loadBaseballSettings(scopeA)).toEqual({ teamId: "lg", opacity: 100 });
  });

  it("closes the old account game and ignores late old progress after account switching", async () => {
    const { egg } = await openSettingsGame();
    change(egg, "#baseball-team", "kia", "change");
    await flush(egg);
    let release!: (value: BaseballProgress) => void;
    const pending = new Promise<BaseballProgress>((resolve) => {
      release = resolve;
    });
    egg.client = { request: async <T>() => pending as Promise<T> };
    await flush(egg);
    egg.preferenceScope = scopeB;
    await flush(egg);
    release({ ...savedProgress, gold: 9999 });
    await flush(egg);
    expect(egg.querySelector('[role="application"]')).toBeNull();
    egg.client = {
      request: async <T>(method: string) =>
        (method === BASEBALL_RPC.beginAtBat
          ? atBat("diamond")
          : method === BASEBALL_RPC.progress
            ? savedProgress
            : { distance: [], homeRunStreak: [] }) as T,
    };
    await flush(egg);
    await openBaseball(egg);
    await flush(egg);
    expect(egg.querySelector<HTMLElement>('[role="application"]')!.dataset.teamId).toBe("neutral");
    expect(egg.textContent).not.toContain("9999");
    expect(loadBaseballSettings(scopeA).teamId).toBe("kia");
  });

  it("keeps controls usable when storage fails and traps focus while the game is paused", async () => {
    storage.setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    const { egg } = await openSettingsGame();
    const dialog = egg.querySelector<HTMLElement>('[role="dialog"]')!;
    const close = dialog.querySelector<HTMLButtonElement>("button")!;
    expect(document.activeElement).toBe(close);
    close.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(close);
    const input = egg.querySelector<HTMLInputElement>("#baseball-opacity")!;
    input.focus();
    const pointer = new Event("pointerdown", { bubbles: true, cancelable: true });
    expect(input.dispatchEvent(pointer)).toBe(true);
    change(egg, "#baseball-opacity", "30", "input");
    await flush(egg);
    expect(egg.textContent).toContain("이번 실행에만 적용");
    expect(
      egg
        .querySelector<HTMLElement>('[role="application"]')!
        .style.getPropertyValue("--baseball-opacity"),
    ).toBe("0.3");
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await flush(egg);
    expect(document.activeElement).toBe(
      egg.querySelector(".platformclaw-easter-egg__shop-trigger"),
    );
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await flush(egg);
    expect(egg.querySelector('[role="application"]')).toBeNull();
  });
});
