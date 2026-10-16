import { describe, expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import { UsageActivityAccumulator } from "./usage-activity.js";

describe("all-session activity aggregates", () => {
  it("keeps request counts separate from assistant/tool traffic and merges daily/UTC buckets without session identifiers", () => {
    const result = new UsageActivityAccumulator();
    for (const requests of [2, 3]) {
      const messages = {
        user: requests,
        assistant: 20,
        total: requests + 20,
        toolCalls: 8,
        toolResults: 8,
        errors: 0,
      };
      result.add("agent-one", "webchat", "direct", {
        ...createEmptyCostUsageTotals(),
        firstActivity: 1,
        lastActivity: requests,
        totalTokens: 100,
        messageCounts: messages,
        dailyMessageCounts: [{ date: "2026-10-16", ...messages }],
        utcQuarterHourMessageCounts: [{ date: "2026-10-15", quarterIndex: 60, ...messages }],
      });
    }
    result.add("agent-one", "webchat", "cron", {
      ...createEmptyCostUsageTotals(),
      messageCounts: { user: 1, assistant: 0, total: 1, toolCalls: 0, toolResults: 0, errors: 0 },
    });
    expect(result.entries()).toEqual([
      expect.objectContaining({ kind: "cron", userMessages: 1 }),
      expect.objectContaining({
        kind: "direct",
        userMessages: 5,
        sessionCount: 2,
        totalTokens: 200,
        lastActivity: 3,
        daily: [{ date: "2026-10-16", userMessages: 5 }],
        hours: [{ weekday: 3, hour: 15, userMessages: 5 }],
      }),
    ]);
  });

  it("collapses a year of dated quarters into bounded local weekday/hour facts", () => {
    const result = new UsageActivityAccumulator({ mode: "time-zone", timeZone: "Asia/Seoul" });
    const messages = { user: 1, assistant: 0, total: 1, toolCalls: 0, toolResults: 0, errors: 0 };
    const quarters = Array.from({ length: 366 }, (_, day) => ({
      date: new Date(Date.parse("2024-01-01T00:00:00Z") + day * 86_400_000)
        .toISOString()
        .slice(0, 10),
      quarterIndex: 60,
      ...messages,
    }));
    result.add("agent-one", "webchat", "direct", {
      ...createEmptyCostUsageTotals(),
      messageCounts: { ...messages, user: 366, total: 366 },
      utcQuarterHourMessageCounts: quarters,
    });
    const entry = result.entries()[0]!;
    expect(entry.hours).toHaveLength(7);
    expect(entry.hours.every((hour) => hour.hour === 0)).toBe(true);
    expect(entry.hours.reduce((sum, hour) => sum + hour.userMessages, 0)).toBe(366);
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(2_000);
  });
});
