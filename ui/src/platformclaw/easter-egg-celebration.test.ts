import type { ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseballCelebration } from "./easter-egg-celebration.ts";

describe("confirmed baseball bonus celebration", () => {
  let celebration: BaseballCelebration;
  beforeEach(() => {
    vi.useFakeTimers();
    celebration = new BaseballCelebration({
      addController: vi.fn(),
      requestUpdate: vi.fn(),
    } as unknown as ReactiveControllerHost);
  });
  afterEach(() => {
    celebration.hostDisconnected();
    vi.useRealTimers();
  });
  it("ignores old receipts and nonbonus rewards, then displays a confirmed bonus once", () => {
    celebration.confirm("old-receipt", undefined, 0, true);
    celebration.confirm("regular-hit", 0, 0, true);
    expect(celebration.visible).toBe(false);
    celebration.confirm("fifth-homer", 5, 0, true);
    expect(celebration.visible).toBe(true);
    vi.advanceTimersByTime(500);
    celebration.confirm("fifth-homer", 5, 0, true);
    vi.advanceTimersByTime(399);
    expect(celebration.visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(celebration.visible).toBe(false);
    celebration.confirm("fifth-homer", 5, 0, true);
    expect(celebration.visible).toBe(false);
  });
  it.each([
    [10, 0],
    [0, 10],
    [10, 10],
  ])("keeps confirmed total %s and streak %s bonuses distinct", (total, streak) => {
    celebration.confirm("new-bonus", total, streak, true);
    expect(celebration.bonus).toEqual({ total, streak });
    vi.advanceTimersByTime(900);
    expect(celebration.bonus).toBeNull();
    celebration.confirm("new-bonus", total, streak, true);
    expect(celebration.visible).toBe(false);
  });
  it("consumes suppressed celebrations and never replays them after a pause", () => {
    celebration.confirm("hidden-receipt", 5, 0, false);
    celebration.confirm("hidden-receipt", 5, 0, true);
    expect(celebration.visible).toBe(false);
    celebration.confirm("visible-receipt", 5, 0, true);
    celebration.hide();
    celebration.confirm("visible-receipt", 5, 0, true);
    expect(celebration.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the effect and timer on reset and disconnect", () => {
    celebration.confirm("account-a-receipt", 5, 0, true);
    celebration.reset();
    expect(celebration.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    celebration.confirm("account-b-receipt", 5, 0, true);
    celebration.hostDisconnected();
    expect(celebration.visible).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
