/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDreamingSummary } from "./dreaming-summary.ts";

type DreamingSummaryProps = Parameters<typeof renderDreamingSummary>[0];

const labels: Record<Parameters<DreamingSummaryProps["text"]>[0], string> = {
  enabled: "Dreaming is on",
  disabled: "Dreaming is off",
  statusUnavailable: "Status unavailable",
  loading: "Loading status",
  nextCycle: "Next cycle",
  phaseLight: "Light",
  phaseDeep: "Deep",
  phaseRem: "Rem",
  phaseOff: "off",
  pending: "Waiting",
  promotedToday: "Promoted today",
  promotedTotal: "Promoted total",
  lastPromotion: "Last promotion",
  diaryUpdated: "Diary updated",
  recentPromotions: "Recent promotions",
  noPromotions: "No recent promotions",
  openActivity: "View activity",
  openDiary: "Open dream diary",
  unavailable: "Unavailable",
};

function buildProps(overrides: Partial<DreamingSummaryProps> = {}): DreamingSummaryProps {
  return {
    enabled: true,
    loading: false,
    hasStatus: true,
    nextCycle: "April 5, 2026, 8:00 AM",
    timezone: "UTC",
    statusError: null,
    shortTermCount: 4,
    promotedToday: 2,
    promotedTotal: 9,
    lastPromotedAt: "2026-04-05T04:00:00.000Z",
    promotedEntries: [
      {
        key: "promoted-1",
        path: "memory/2026-04-05.md",
        startLine: 1,
        endLine: 1,
        snippet: "Keep direct airline receipts when possible.",
        recallCount: 1,
        dailyCount: 1,
        groundedCount: 0,
        totalSignalCount: 2,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        promotedAt: "2026-04-05T04:00:00.000Z",
      },
    ],
    phases: {
      light: { enabled: true, nextRunAtMs: Date.parse("2026-04-05T08:00:00.000Z") },
      deep: { enabled: true, nextRunAtMs: Date.parse("2026-04-05T03:00:00.000Z") },
      rem: { enabled: false },
    },
    diaryUpdatedAtMs: Date.parse("2026-04-05T05:00:00.000Z"),
    text: (key) => labels[key],
    onOpenActivity: vi.fn(),
    onOpenDiary: vi.fn(),
    ...overrides,
  };
}

describe("renderDreamingSummary", () => {
  it("presents configured enablement without claiming the engine is currently running", () => {
    const container = document.createElement("div");
    render(renderDreamingSummary(buildProps()), container);

    expect(container.textContent).toContain("Dreaming is on");
    expect(container.textContent).not.toMatch(/running|active/i);
    const rows = [...container.querySelectorAll(".settings-row")].map((row) =>
      row.textContent?.trim().replace(/\s+/g, " "),
    );
    expect(rows).toContain("Waiting 4");
    expect(rows).toContain("Promoted today 2");
    expect(rows).toContain("Promoted total 9");
    expect(container.textContent).toContain("Keep direct airline receipts when possible.");
    expect(container.textContent).toContain("off");
  });

  it("shows missing timestamps as unavailable and keeps status errors visible", () => {
    const container = document.createElement("div");
    render(
      renderDreamingSummary(
        buildProps({
          statusError: "doctor.memory.status failed",
          lastPromotedAt: undefined,
          phases: undefined,
          diaryUpdatedAtMs: null,
          promotedEntries: [],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("Status unavailable");
    expect(container.textContent).toContain("doctor.memory.status failed");
    expect(container.textContent?.match(/Unavailable/g)?.length).toBeGreaterThanOrEqual(5);
    expect(container.querySelector(".settings-status--danger")).not.toBeNull();
  });

  it("does not turn a loading or unavailable status into successful zero counts", () => {
    const container = document.createElement("div");
    render(
      renderDreamingSummary(
        buildProps({
          loading: true,
          hasStatus: false,
          shortTermCount: 0,
          promotedToday: 0,
          promotedTotal: 0,
          phases: undefined,
          promotedEntries: [],
          lastPromotedAt: undefined,
        }),
      ),
      container,
    );

    expect(container.querySelector(".dreams-summary")?.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).toContain("Loading status");
    expect(container.textContent).not.toContain("Status unavailable");
    const rows = [...container.querySelectorAll(".settings-row")].map((row) =>
      row.textContent?.trim().replace(/\s+/g, " "),
    );
    expect(rows).toContain("Waiting Unavailable");
    expect(rows).toContain("Promoted today Unavailable");
    expect(rows).toContain("Promoted total Unavailable");
    expect(rows).not.toContain("Waiting 0");
    expect(rows).not.toContain("Promoted today 0");
    expect(rows).not.toContain("Promoted total 0");
  });

  it("navigates to the existing activity and diary views", () => {
    const onOpenActivity = vi.fn();
    const onOpenDiary = vi.fn();
    const container = document.createElement("div");
    render(renderDreamingSummary(buildProps({ onOpenActivity, onOpenDiary })), container);

    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button.settings-row--nav")];
    expect(buttons).toHaveLength(2);
    buttons[0]?.click();
    buttons[1]?.click();
    expect(onOpenActivity).toHaveBeenCalledOnce();
    expect(onOpenDiary).toHaveBeenCalledOnce();
  });
});
