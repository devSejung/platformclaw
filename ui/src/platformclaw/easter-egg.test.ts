import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASEBALL_RPC,
  type BaseballProgress,
} from "../../../packages/platformclaw-control-plane/src/baseball-contracts.ts";
import { classifyTimingDelta, formatTimingFeedback } from "./easter-egg-timing.ts";
import { PLATFORMCLAW_EASTER_EGG_EVENT, recordPlatformClawEasterEggClick } from "./easter-egg.ts";
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
    revision: 0,
    ...overrides,
  };
}

async function flush(element: EasterEggElement): Promise<void> {
  await Promise.resolve();
  await element.updateComplete;
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
    window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
    await egg.updateComplete;
    await Promise.resolve();
    await egg.updateComplete;

    const game = egg.querySelector('[role="application"]');
    expect(game).not.toBeNull();
    expect(game?.getAttribute("aria-label")).toBe("PlatformClaw Stickman Baseball");
    expect(egg.querySelector(".platformclaw-easter-egg__hud")?.textContent).toContain("안타 0");
    expect(egg.querySelector(".platformclaw-easter-egg__hud")?.textContent).toContain("홈런 0");
    expect(egg.querySelector(".platformclaw-easter-egg__hud")?.textContent).toContain("연속 0");
    expect(egg.querySelector(".platformclaw-easter-egg__hud")?.textContent).toContain("최고 0m");
    expect(egg.querySelector(".platformclaw-easter-egg__player-label")).toBeNull();
    expect(egg.querySelector(".platformclaw-easter-egg__target-label")).toBeNull();
    expect(egg.querySelector(".platformclaw-easter-egg__wind")).toBeNull();
    expect(egg.querySelector(".platformclaw-easter-egg__home-plate")).toBeNull();
    expect(
      egg.querySelector(".platformclaw-easter-egg__player .platformclaw-easter-egg__bat"),
    ).not.toBeNull();
    expect(
      egg.querySelectorAll(".platformclaw-easter-egg__player, .platformclaw-easter-egg__target"),
    ).toHaveLength(2);
    expect(egg.querySelector(".platformclaw-easter-egg__trajectory-line")).toBeNull();
    expect(egg.querySelectorAll(".platformclaw-easter-egg__trail-dot")).toHaveLength(7);

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
  });

  it("loads account progress, pauses game timers in the shop, and lets Escape close only the shop", async () => {
    vi.useFakeTimers();
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    egg.now = () => Date.now();
    egg.random = () => 0;
    egg.client = {
      request: vi.fn(async () => progress({ gold: 50, bestDistanceM: 168 })),
    };
    window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
    await flush(egg);
    expect(egg.textContent).toContain("골드 50");
    expect(egg.textContent).toContain("최고 168m");

    (egg.querySelector(".platformclaw-easter-egg__hud button") as HTMLButtonElement).click();
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
      request: vi.fn(async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === BASEBALL_RPC.progress) {
          return progress({ gold: 50 }) as T;
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
      }),
    };
    window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
    await flush(egg);
    (egg.querySelector(".platformclaw-easter-egg__hud button") as HTMLButtonElement).click();
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

  it("ignores a late progress response after the gateway client changes", async () => {
    const egg = document.querySelector("platformclaw-easter-egg") as EasterEggElement;
    let releaseFirst!: (value: BaseballProgress) => void;
    const firstProgress = new Promise<BaseballProgress>((resolve) => {
      releaseFirst = resolve;
    });
    egg.client = { request: vi.fn(async () => firstProgress) };
    window.dispatchEvent(new Event(PLATFORMCLAW_EASTER_EGG_EVENT));
    await egg.updateComplete;

    egg.client = { request: vi.fn(async () => progress({ gold: 7, revision: 2 })) };
    await flush(egg);
    releaseFirst(progress({ gold: 999, revision: 99 }));
    await flush(egg);
    expect(egg.textContent).toContain("골드 7");
    expect(egg.textContent).not.toContain("골드 999");
  });
});
