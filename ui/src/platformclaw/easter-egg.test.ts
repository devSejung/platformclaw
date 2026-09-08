import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyHitResult,
  classifyTimingDelta,
  distanceForTiming,
  formatHitResult,
  formatTimingFeedback,
} from "./easter-egg-timing.ts";
import {
  PLATFORMCLAW_EASTER_EGG_EVENT,
  recordPlatformClawEasterEggClick,
  resetPlatformClawEasterEggClickCount,
} from "./easter-egg.ts";
import "./easter-egg-game.ts";

type EasterEggElement = HTMLElement & { updateComplete: Promise<unknown> };

describe("PlatformClaw easter egg", () => {
  beforeEach(() => {
    resetPlatformClawEasterEggClickCount();
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

  it("formats timing feedback and scales distance with accuracy", () => {
    expect(formatTimingFeedback(0, "PERFECT")).toBe("PERFECT");
    expect(formatTimingFeedback(-54, "GOOD")).toBe("54ms 빠름");
    expect(formatTimingFeedback(32, "HIT")).toBe("32ms 느림");
    expect(formatTimingFeedback(101, "MISS")).toBe("MISS");
    expect(distanceForTiming(0, 150, 70)).toBe(150);
    expect(distanceForTiming(100, 150, 70)).toBe(70);
  });

  it("distinguishes ordinary hits from home runs by distance", () => {
    expect(classifyHitResult(119)).toBe("HIT");
    expect(classifyHitResult(120)).toBe("HOME_RUN");
    expect(formatHitResult("HIT")).toBe("안타");
    expect(formatHitResult("HOME_RUN")).toBe("홈런");
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
    expect(egg.querySelector(".platformclaw-easter-egg__trajectory-line")).not.toBeNull();

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
});
