import type { SessionUsageActivity } from "../../../src/shared/usage-activity.js";
import type {
  DashboardAccount,
  DashboardMetrics,
  DashboardQuery,
  DashboardReport,
} from "./dashboard-contracts.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
export class DashboardQueryError extends Error {}
export class DashboardBusyError extends Error {}

function dateMs(value: string): number {
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(ms) ||
    new Date(ms).toISOString().slice(0, 10) !== value
  ) {
    throw new DashboardQueryError("Invalid calendar date");
  }
  return ms;
}

export function parseDashboardQuery(url: URL): DashboardQuery {
  const allowed = new Set([
    "startDate",
    "endDate",
    "timeZone",
    "accountId",
    "organizationId",
    "channel",
    "kind",
    "format",
  ]);
  for (const key of url.searchParams.keys()) {
    if (
      !allowed.has(key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (url.searchParams.get(key)?.length ?? 0) > 160
    ) {
      throw new DashboardQueryError("Invalid dashboard query");
    }
  }
  const value = (key: string) => url.searchParams.get(key) ?? "";
  const startDate = value("startDate");
  const endDate = value("endDate");
  const days = (dateMs(endDate) - dateMs(startDate)) / DAY_MS + 1;
  if (days < 1 || days > MAX_DAYS) {
    throw new DashboardQueryError(`Select between 1 and ${MAX_DAYS} days`);
  }
  const timeZone = value("timeZone") || "Asia/Seoul";
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new DashboardQueryError("Invalid time zone");
  }
  if (value("format") && value("format") !== "xlsx") {
    throw new DashboardQueryError("Unsupported export format");
  }
  return {
    startDate,
    endDate,
    timeZone,
    accountId: value("accountId"),
    organizationId: value("organizationId"),
    channel: value("channel"),
    kind: value("kind"),
  };
}

type UsageSource = {
  updatedAt: number;
  cacheStatus?: { status: DashboardReport["cacheStatus"] };
  aggregates: { activity?: SessionUsageActivity[] };
};

function metrics(): DashboardMetrics {
  return { requests: 0, toolCalls: 0, tokens: 0, estimatedCost: 0, missingCostEntries: 0 };
}

function add(target: DashboardMetrics, entry: SessionUsageActivity) {
  target.requests += entry.userMessages;
  target.toolCalls += entry.toolCalls;
  target.tokens += entry.totalTokens;
  target.estimatedCost += entry.estimatedCost;
  target.missingCostEntries += entry.missingCostEntries;
}

function combineSources(sources: UsageSource[]): UsageSource {
  const statuses: DashboardReport["cacheStatus"][] = ["fresh", "refreshing", "stale", "partial"];
  const status = sources.reduce(
    (worst, source) => Math.max(worst, statuses.indexOf(source.cacheStatus?.status ?? "fresh")),
    0,
  );
  return {
    updatedAt: sources.length ? Math.min(...sources.map((source) => source.updatedAt)) : Date.now(),
    cacheStatus: { status: statuses[status]! },
    aggregates: { activity: sources.flatMap((source) => source.aggregates.activity!) },
  };
}

/** Public numeric projection; private session identifiers never cross this boundary. */
export class DashboardService {
  private inFlight = new Map<string, Promise<DashboardReport>>();
  private readonly settled = new Map<string, { expiresAt: number; report: DashboardReport }>();
  private readonly callers = new Map<string, { startedAt: number; jobs: number; active: number }>();
  constructor(
    private readonly options: {
      store: { listDashboardAccounts(): Promise<DashboardAccount[]> };
      gateway: { request(method: string, params: unknown): Promise<unknown> };
      now?: () => number;
    },
  ) {}

  async report(query: DashboardQuery, callerId: string): Promise<DashboardReport> {
    const roster = await this.options.store.listDashboardAccounts();
    if (roster.length > 10_000) {
      throw new Error("Dashboard account capacity exceeded");
    }
    const now = (this.options.now ?? Date.now)();
    // Reread membership before using a shared report. A changed account, binding,
    // or primary organization invalidates its identity projection immediately.
    const key = JSON.stringify([query, roster]);
    for (const [cacheKey, entry] of this.settled) {
      if (entry.expiresAt <= now) {
        this.settled.delete(cacheKey);
      }
    }
    const cached = this.settled.get(key);
    if (cached) {
      return cached.report;
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    if (this.inFlight.size >= 8) {
      throw new DashboardBusyError("Dashboard is busy. Retry in one minute.");
    }
    for (const [id, entry] of this.callers) {
      if (!entry.active && now - entry.startedAt >= 60_000) {
        this.callers.delete(id);
      }
    }
    let caller = this.callers.get(callerId);
    if (!caller) {
      if (this.callers.size >= 10_000) {
        throw new DashboardBusyError("Dashboard is busy. Retry in one minute.");
      }
      caller = { startedAt: now, jobs: 0, active: 0 };
      this.callers.set(callerId, caller);
    }
    if (caller.active >= 2) {
      throw new DashboardBusyError("Too many reports in progress. Retry in one minute.");
    }
    caller.active++;
    const pending = this.build(query, roster, caller)
      .then((report) => {
        const fresh = report.cacheStatus === "fresh" && report.previousCacheStatus === "fresh";
        this.settled.set(key, {
          expiresAt: (this.options.now ?? Date.now)() + (fresh ? 15_000 : 3_000),
          report,
        });
        if (this.settled.size > 16) {
          this.settled.delete(this.settled.keys().next().value!);
        }
        return report;
      })
      .finally(() => {
        caller.active--;
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async build(
    query: DashboardQuery,
    roster: DashboardAccount[],
    caller: { jobs: number },
  ): Promise<DashboardReport> {
    const days = (dateMs(query.endDate) - dateMs(query.startDate)) / DAY_MS + 1;
    const previousEndDate = new Date(dateMs(query.startDate) - DAY_MS).toISOString().slice(0, 10);
    const previousStartDate = new Date(dateMs(query.startDate) - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const load = async (
      agentId: string,
      startDate: string,
      endDate: string,
    ): Promise<UsageSource> => {
      const result = (await this.options.gateway.request("sessions.usage", {
        agentId,
        startDate,
        endDate,
        mode: "specific",
        timeZone: query.timeZone,
        groupBy: "instance",
        limit: 0,
        includeContextWeight: false,
        includeActivity: true,
      })) as UsageSource;
      if (!Array.isArray(result.aggregates?.activity)) {
        throw new Error("Activity aggregates unavailable");
      }
      return result;
    };
    const dateFormat = new Intl.DateTimeFormat("en-CA", {
      timeZone: query.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dayKey = (ms: number) => {
      const parts = dateFormat.formatToParts(ms);
      const part = (name: string) => parts.find((p) => p.type === name)?.value;
      return `${part("year")}-${part("month")}-${part("day")}`;
    };
    const eligible = roster.filter((account) => dayKey(account.createdAt) <= query.endDate);
    const selected = eligible.filter(
      (account) =>
        (!query.accountId || account.accountId === query.accountId) &&
        (!query.organizationId || account.organizationId === query.organizationId),
    );
    // Each RPC is scoped to one registered agent so annual enterprise reports
    // cannot exceed the shared Gateway socket's 25 MiB response limit. Four
    // workers bound discovery pressure while reusing the canonical usage cache.
    const jobs = selected
      .filter((account) => account.agentId)
      .flatMap((account) => [
        { agentId: account.agentId!, window: 0, start: query.startDate, end: query.endDate },
        { agentId: account.agentId!, window: 1, start: previousStartDate, end: previousEndDate },
      ]);
    // Charge actual upstream calls, including the comparison window. Varying
    // filters cannot bypass a caller's 2,000-call budget per minute.
    if (caller.jobs + jobs.length > 2_000) {
      throw new DashboardBusyError(
        "Report budget exceeded. Select fewer accounts or retry in one minute.",
      );
    }
    caller.jobs += jobs.length;
    const sources: [UsageSource[], UsageSource[]] = [[], []];
    let nextJob = 0;
    let failed = false;
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (!failed && nextJob < jobs.length) {
          const job = jobs[nextJob++]!;
          try {
            sources[job.window as 0 | 1].push(await load(job.agentId, job.start, job.end));
          } catch {
            failed = true;
          }
        }
      }),
    );
    if (failed) {
      throw new Error("Activity aggregates unavailable");
    }
    const current = combineSources(sources[0]);
    const previous = combineSources(sources[1]);
    const allCurrent = current.aggregates.activity!;
    const allPrevious = previous.aggregates.activity!;
    const matches = (entry: SessionUsageActivity) =>
      (!query.channel || entry.channel === query.channel) &&
      (!query.kind || entry.kind === query.kind);
    const byAgent = (entries: SessionUsageActivity[]) => {
      const groups = new Map<string, SessionUsageActivity[]>();
      for (const entry of entries.filter(matches)) {
        const group = groups.get(entry.agentId) ?? [];
        group.push(entry);
        groups.set(entry.agentId, group);
      }
      return groups;
    };
    const nowByAgent = byAgent(allCurrent);
    const priorByAgent = byAgent(allPrevious);
    const daily = new Map<string, { date: string; requests: number; users: Set<string> }>();
    for (let ms = dateMs(query.startDate); ms <= dateMs(query.endDate); ms += DAY_MS) {
      const date = new Date(ms).toISOString().slice(0, 10);
      daily.set(date, { date, requests: 0, users: new Set() });
    }
    const heatmap = Array.from({ length: 168 }, (_, index) => ({
      weekday: Math.floor(index / 24),
      hour: index % 24,
      requests: 0,
    }));
    const totals = {
      ...metrics(),
      registeredAccounts: selected.length,
      activeAccounts: 0,
      previousRequests: 0,
    };
    const accounts = selected
      .map((account) => {
        const result = Object.assign(metrics(), {
          accountId: account.accountId,
          displayName: account.displayName,
          status: account.status,
          agentId: account.agentId,
          organizationId: account.organizationId,
          organizationName: account.organizationName,
          previousRequests: 0,
          activeDays: 0,
          lastActivity: null as number | null,
        });
        const activeDates = new Set<string>();
        for (const entry of nowByAgent.get(account.agentId ?? "") ?? []) {
          add(result, entry);
          add(totals, entry);
          if (entry.lastActivity !== undefined) {
            result.lastActivity = Math.max(result.lastActivity ?? 0, entry.lastActivity);
          }
          for (const day of entry.daily) {
            if (day.userMessages <= 0) {
              continue;
            }
            const bucket = daily.get(day.date);
            if (bucket) {
              bucket.requests += day.userMessages;
              bucket.users.add(account.accountId);
              activeDates.add(day.date);
            }
          }
          for (const hour of entry.hours) {
            heatmap[hour.weekday * 24 + hour.hour]!.requests += hour.userMessages;
          }
        }
        result.activeDays = activeDates.size;
        result.previousRequests = (priorByAgent.get(account.agentId ?? "") ?? []).reduce(
          (sum, entry) => sum + entry.userMessages,
          0,
        );
        totals.previousRequests += result.previousRequests;
        if (result.requests > 0) {
          totals.activeAccounts += 1;
        }
        return result;
      })
      .toSorted((a, b) => b.requests - a.requests || a.accountId.localeCompare(b.accountId));
    const knownAgents = new Set(eligible.map((account) => account.agentId));
    const organizations = new Map(
      eligible
        .filter((account) => account.organizationId)
        .map((account) => [
          account.organizationId!,
          account.organizationName ?? account.organizationId!,
        ]),
    );
    const registeredActivity = allCurrent.filter((entry) => knownAgents.has(entry.agentId));
    return {
      query,
      updatedAt: current.updatedAt,
      previousStartDate,
      previousEndDate,
      cacheStatus: current.cacheStatus?.status ?? "fresh",
      previousCacheStatus: previous.cacheStatus?.status ?? "fresh",
      totals,
      daily: Array.from(daily.values(), ({ date, requests, users }) => ({
        date,
        requests,
        activeAccounts: users.size,
      })),
      heatmap,
      accounts,
      options: {
        accounts: eligible.map(({ accountId, displayName }) => ({ accountId, displayName })),
        organizations: Array.from(organizations, ([id, name]) => ({ id, name })).toSorted((a, b) =>
          a.name.localeCompare(b.name),
        ),
        channels: [...new Set(registeredActivity.map((entry) => entry.channel))].toSorted(),
        kinds: [...new Set(registeredActivity.map((entry) => entry.kind))].toSorted(),
      },
    };
  }
}
