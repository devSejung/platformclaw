import type { SessionCostSummary, UsageDailyBucket } from "../infra/session-cost-usage.types.js";
import type { SessionKind } from "../sessions/classify-session-kind.js";

/** Numeric activity facts across all matched sessions, independent of the row limit. */
export type SessionUsageActivity = {
  agentId: string;
  channel: string;
  kind: SessionKind;
  userMessages: number;
  toolCalls: number;
  totalTokens: number;
  estimatedCost: number;
  missingCostEntries: number;
  sessionCount: number;
  lastActivity?: number;
  daily: Array<{ date: string; userMessages: number }>;
  hours: Array<{ weekday: number; hour: number; userMessages: number }>;
};

export class UsageActivityAccumulator {
  private readonly groups = new Map<
    string,
    {
      activity: SessionUsageActivity;
      daily: Map<string, number>;
      hours: Map<number, number>;
    }
  >();
  private readonly hourBuckets = new Map<number, { weekday: number; hour: number }>();
  private readonly localFormat?: Intl.DateTimeFormat;

  constructor(private readonly dayBucket?: UsageDailyBucket) {
    if (dayBucket?.mode === "time-zone") {
      this.localFormat = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
        timeZone: dayBucket.timeZone,
        weekday: "short",
        hour: "2-digit",
        hourCycle: "h23",
      });
    }
  }

  private hourBucket(date: string, quarterIndex: number) {
    const timestamp = Date.parse(`${date}T00:00:00Z`) + quarterIndex * 900_000;
    const cached = this.hourBuckets.get(timestamp);
    if (cached) {
      return cached;
    }
    let bucket: { weekday: number; hour: number };
    if (this.localFormat) {
      const parts = this.localFormat.formatToParts(timestamp);
      const day = parts.find((part) => part.type === "weekday")!.value;
      bucket = {
        weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(day),
        hour: Number(parts.find((part) => part.type === "hour")!.value),
      };
    } else {
      const local = new Date(
        timestamp +
          (this.dayBucket?.mode === "utc-offset" ? this.dayBucket.utcOffsetMinutes * 60_000 : 0),
      );
      bucket = { weekday: (local.getUTCDay() + 6) % 7, hour: local.getUTCHours() };
    }
    this.hourBuckets.set(timestamp, bucket);
    return bucket;
  }

  add(agentId: string, channel: string, kind: SessionKind, usage: SessionCostSummary): void {
    const key = JSON.stringify([agentId, channel, kind]);
    let group = this.groups.get(key);
    if (!group) {
      group = {
        activity: {
          agentId,
          channel,
          kind,
          userMessages: 0,
          toolCalls: 0,
          totalTokens: 0,
          estimatedCost: 0,
          missingCostEntries: 0,
          sessionCount: 0,
          daily: [],
          hours: [],
        },
        daily: new Map(),
        hours: new Map(),
      };
      this.groups.set(key, group);
    }
    const activity = group.activity;
    activity.userMessages += usage.messageCounts?.user ?? 0;
    activity.toolCalls += usage.toolUsage?.totalCalls ?? 0;
    activity.totalTokens += usage.totalTokens;
    activity.estimatedCost += usage.totalCost;
    activity.missingCostEntries += usage.missingCostEntries;
    if (usage.firstActivity !== undefined || (usage.messageCounts?.total ?? 0) > 0) {
      activity.sessionCount += 1;
    }
    if (usage.lastActivity !== undefined) {
      activity.lastActivity = Math.max(activity.lastActivity ?? 0, usage.lastActivity);
    }
    for (const day of usage.dailyMessageCounts ?? []) {
      group.daily.set(day.date, (group.daily.get(day.date) ?? 0) + day.user);
    }
    for (const quarter of usage.utcQuarterHourMessageCounts ?? []) {
      if (quarter.user <= 0) {
        continue;
      }
      const { weekday, hour } = this.hourBucket(quarter.date, quarter.quarterIndex);
      const hourKey = weekday * 24 + hour;
      group.hours.set(hourKey, (group.hours.get(hourKey) ?? 0) + quarter.user);
    }
  }

  entries(): SessionUsageActivity[] {
    return Array.from(this.groups.entries())
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([, group]) =>
        Object.assign({}, group.activity, {
          daily: Array.from(group.daily, ([date, userMessages]) => ({
            date,
            userMessages,
          })).toSorted((a, b) => a.date.localeCompare(b.date)),
          // Collapse dates before serialization: a year and a day both transmit
          // at most 168 hour buckets per group over the shared Gateway socket.
          hours: Array.from(group.hours, ([key, userMessages]) => ({
            weekday: Math.floor(key / 24),
            hour: key % 24,
            userMessages,
          })).toSorted((a, b) => a.weekday - b.weekday || a.hour - b.hour),
        }),
      );
  }
}
