import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  AiUsageReportError,
  type AiUsageReport,
  type AiUsageReportQuery,
  type AiUsageReportRow,
  type AiUsageReportUser,
  type AiUsageReportUsers,
  type AiUsageReportUsersQuery,
} from "./ai-usage-report-contracts.js";

type ModelDay = {
  date: string;
  provider: string | null;
  model: string | null;
  count: number;
  tokens: number | null;
};

type UsageSource = { days: ModelDay[]; fresh: boolean; usable: boolean };

function unavailable(message = "Usage report unavailable. Retry shortly."): AiUsageReportError {
  return new AiUsageReportError(503, "REPORT_UNAVAILABLE", message);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addCount(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw unavailable("Report exceeds safe numeric capacity. Select a smaller scope.");
  }
  return result;
}

function addTokens(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : addCount(left, right);
}

function sourceText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw unavailable();
  }
  return value.trim() || null;
}

function parseUsageSource(raw: unknown, query: AiUsageReportQuery): UsageSource {
  if (!isRecord(raw) || !isRecord(raw.aggregates) || !isRecord(raw.totals)) {
    throw unavailable();
  }
  const rows = raw.aggregates.modelDaily;
  if (rows !== undefined && !Array.isArray(rows)) {
    throw unavailable();
  }
  // Empty discovery has no per-session cache status. A nonzero total without
  // model buckets cannot be exported as a fabricated empty employee report.
  if (rows === undefined && raw.totals.totalTokens !== 0) {
    throw unavailable();
  }
  const days: ModelDay[] = [];
  for (const row of rows ?? []) {
    if (
      !isRecord(row) ||
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(row.date) ||
      !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) ||
      new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date ||
      row.date < query.startDate ||
      row.date > query.endDate ||
      !safeInteger(row.count) ||
      row.count === 0 ||
      (row.missingTokenEntries !== undefined && !safeInteger(row.missingTokenEntries)) ||
      (row.tokens !== null && !safeInteger(row.tokens))
    ) {
      throw unavailable();
    }
    days.push({
      date: row.date,
      provider: sourceText(row.provider),
      model: sourceText(row.model),
      count: row.count,
      tokens:
        row.missingTokenEntries !== undefined && row.missingTokenEntries > 0 ? null : row.tokens,
    });
  }
  const status = raw.cacheStatus;
  if (status === undefined) {
    if (days.length > 0) {
      throw unavailable();
    }
    return { days, fresh: true, usable: true };
  }
  if (
    !isRecord(status) ||
    typeof status.status !== "string" ||
    !["fresh", "partial", "stale", "refreshing"].includes(status.status) ||
    !safeInteger(status.cachedFiles) ||
    !safeInteger(status.pendingFiles)
  ) {
    throw unavailable();
  }
  const fresh = status.status === "fresh" && status.pendingFiles === 0;
  return { days, fresh, usable: fresh || status.cachedFiles > 0 || days.length > 0 };
}

function compareValue(left: string | number | null, right: string | number | null): number {
  if (left === null || right === null) {
    return left === right ? 0 : left === null ? 1 : -1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortRows(rows: AiUsageReportRow[], query: AiUsageReportQuery): void {
  const keys = ["month", "knox_id", "ai_service", "provider", "model"] as const;
  rows.sort((left, right) => {
    const a = left[query.sort];
    const b = right[query.sort];
    const primary = compareValue(a, b);
    if (primary) {
      return a === null || b === null || query.order === "asc" ? primary : -primary;
    }
    for (const key of keys) {
      const tie = compareValue(left[key], right[key]);
      if (tie) {
        return tie;
      }
    }
    return 0;
  });
}

function active(row: AiUsageReportRow): boolean {
  return row.call_count > 0 || (row.token_usage !== null && row.token_usage > 0);
}

/** Owns the corporate numeric projection; transcript data never crosses this boundary. */
export class AiUsageReportService {
  private readonly inFlight = new Map<string, Promise<AiUsageReport>>();
  private sourceCalls = 0;
  private readonly sourceWaiters: Array<() => void> = [];

  constructor(
    private readonly options: {
      store: { listAiUsageReportUsers(): Promise<AiUsageReportUser[]> };
      gateway: { request(method: string, params: unknown): Promise<unknown> };
      now?: () => number;
    },
  ) {}

  private async roster(): Promise<AiUsageReportUser[]> {
    let roster: AiUsageReportUser[];
    try {
      roster = await this.options.store.listAiUsageReportUsers();
    } catch {
      throw unavailable("Employee directory unavailable. Retry shortly.");
    }
    if (roster.length > 10_000) {
      throw unavailable("Employee directory exceeds reporting capacity.");
    }
    const accounts = new Set<string>();
    const agents = new Set<string>();
    for (const user of roster) {
      if (
        !user.accountId ||
        user.accountId !== user.accountId.trim().toLowerCase() ||
        accounts.has(user.accountId) ||
        (user.agentId !== null && agents.has(user.agentId))
      ) {
        throw unavailable("Employee reporting identities are inconsistent.");
      }
      accounts.add(user.accountId);
      if (user.agentId !== null) {
        agents.add(user.agentId);
      }
    }
    return roster;
  }

  async users(query: AiUsageReportUsersQuery): Promise<AiUsageReportUsers> {
    const matches = (await this.roster())
      .filter(
        (user) =>
          (query.team === null || user.department === query.team) &&
          (query.status === "all" || user.status === query.status) &&
          (query.q === null ||
            [user.accountId, user.displayName ?? ""].some((value) =>
              value
                .normalize("NFC")
                .toLowerCase()
                .includes(query.q ?? ""),
            )),
      )
      .toSorted((a, b) => compareValue(a.accountId, b.accountId));
    const users = matches.slice(query.offset, query.offset + query.limit).map((user) => ({
      knox_id: user.accountId,
      display_name: user.displayName,
      team: user.department,
      status: user.status,
    }));
    const next = query.offset + users.length;
    const hasMore = next < matches.length;
    return {
      users,
      meta: {
        total: matches.length,
        limit: query.limit,
        offset: query.offset,
        has_more: hasMore,
        next_offset: hasMore ? next : null,
      },
    };
  }

  async report(query: AiUsageReportQuery): Promise<AiUsageReport> {
    const roster = await this.roster();
    const known = new Set(roster.map((user) => user.accountId));
    const missing = query.filters.knox_id.filter((account) => !known.has(account));
    if (missing.length > 0) {
      throw new AiUsageReportError(
        404,
        "USER_NOT_FOUND",
        "One or more requested accounts were not found",
        {
          unknown_knox_ids: missing,
        },
      );
    }
    const selected = roster.filter(
      (user) =>
        (query.filters.knox_id.length === 0 || query.filters.knox_id.includes(user.accountId)) &&
        (query.filters.team === null || user.department === query.filters.team),
    );
    // Membership and binding facts participate in joining. No settled cache is
    // retained here: each HTTP request observes the canonical directory again.
    const key = JSON.stringify([query, selected]);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    if (this.inFlight.size >= 4) {
      throw new AiUsageReportError(
        429,
        "RATE_LIMITED",
        "Too many reports in progress. Retry shortly.",
      );
    }
    const pending = this.build(query, selected).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async load(user: AiUsageReportUser, query: AiUsageReportQuery): Promise<UsageSource> {
    if (this.sourceCalls >= 4) {
      await new Promise<void>((resolve) => {
        this.sourceWaiters.push(resolve);
      });
    } else {
      this.sourceCalls++;
    }
    try {
      return parseUsageSource(
        await this.options.gateway.request("sessions.usage", {
          agentId: user.agentId,
          startDate: query.startDate,
          endDate: query.endDate,
          mode: "specific",
          timeZone: "Asia/Seoul",
          groupBy: "instance",
          limit: 0,
          includeContextWeight: false,
        }),
        query,
      );
    } finally {
      const next = this.sourceWaiters.shift();
      if (next) {
        next();
      } else {
        this.sourceCalls--;
      }
    }
  }

  private async build(
    query: AiUsageReportQuery,
    users: AiUsageReportUser[],
  ): Promise<AiUsageReport> {
    const warnings = new Set(["HISTORICAL_COVERAGE_UNVERIFIED"]);
    const buckets = new Map<string, AiUsageReportRow>();
    const jobs = users.filter((user) => user.agentId !== null);
    let nextJob = 0;
    let partial = false;
    let usable = jobs.length === 0;
    const failures: AiUsageReportError[] = [];
    await Promise.all(
      Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (failures.length === 0 && nextJob < jobs.length) {
          const user = jobs[nextJob++];
          if (!user) {
            continue;
          }
          let source: UsageSource;
          try {
            source = await this.load(user, query);
          } catch {
            partial = true;
            warnings.add("SOURCE_READ_INCOMPLETE");
            continue;
          }
          if (failures.length > 0) {
            return;
          }
          usable ||= source.usable;
          if (!source.fresh) {
            partial = true;
            warnings.add("USAGE_CACHE_STALE");
          }
          try {
            for (const day of source.days) {
              if (
                (query.filters.provider !== null && day.provider !== query.filters.provider) ||
                (query.filters.model !== null && day.model !== query.filters.model)
              ) {
                continue;
              }
              const month = day.date.slice(0, 7);
              const provider = query.groupBy === "model" ? day.provider : null;
              const model = query.groupBy === "model" ? day.model : null;
              const key = JSON.stringify([month, user.accountId, provider, model]);
              const row: AiUsageReportRow = buckets.get(key) ?? {
                team: user.department,
                month,
                knox_id: user.accountId,
                ai_service: "PlatformClaw",
                call_count: 0,
                token_usage: 0,
                provider,
                model,
              };
              row.call_count = addCount(row.call_count, day.count);
              row.token_usage = addTokens(row.token_usage, day.tokens);
              buckets.set(key, row);
              if (user.department === null) {
                warnings.add("UNKNOWN_TEAM");
              }
              if (day.provider === null || day.model === null) {
                warnings.add("UNKNOWN_MODEL");
              }
              if (day.tokens === null) {
                partial = true;
                warnings.add("UNKNOWN_TOKEN_USAGE");
              }
            }
          } catch (error) {
            // Keep the report slot until every already-running source call has
            // settled; retiring it early could leave unbounded orphan workers.
            failures.push(error instanceof AiUsageReportError ? error : unavailable());
          }
        }
      }),
    );
    const failure = failures[0];
    if (failure) {
      throw failure;
    }
    if (!usable || (partial && buckets.size === 0)) {
      throw unavailable();
    }
    const allRows = [...buckets.values()];
    if (query.limit === null && allRows.length > 100_000) {
      throw new AiUsageReportError(
        413,
        "REPORT_TOO_LARGE",
        "Select fewer months, teams, or accounts.",
      );
    }
    sortRows(allRows, query);
    const rows = query.limit === null ? allRows : allRows.slice(0, query.limit);
    return {
      raw_data: rows,
      meta: {
        schema_version: "1",
        source: "platformclaw",
        fetched_at: (this.options.now ?? Date.now)() / 1000,
        row_count: rows.length,
        active_row_count: rows.filter(active).length,
        team_size: users.length,
        active_user_count: new Set(allRows.filter(active).map((row) => row.knox_id)).size,
        months: query.months,
        total_tokens: allRows.reduce<number | null>(
          (sum, row) => addTokens(sum, row.token_usage),
          0,
        ),
        returned_tokens: rows.reduce<number | null>(
          (sum, row) => addTokens(sum, row.token_usage),
          0,
        ),
        total_call_count: allRows.reduce((sum, row) => addCount(sum, row.call_count), 0),
        total_row_count: allRows.length,
        truncated: rows.length < allRows.length,
        filters: query.filters,
        sort: query.sort,
        order: query.order,
        limit: query.limit,
        timezone: "Asia/Seoul",
        group_by: query.groupBy,
        scope: "personal_agents",
        call_count_basis: "usage_records",
        token_usage_basis: "provider_total_or_components",
        coverage: "retained_records",
        data_status: partial ? "partial" : "complete",
        warnings: [...warnings].toSorted(),
      },
    };
  }
}
