import { describe, expect, it, vi } from "vitest";
import type { AiUsageReportUser } from "./ai-usage-report-contracts.js";
import { parseAiUsageReportQuery, parseAiUsageReportUsersQuery } from "./ai-usage-report-query.js";
import { AiUsageReportService } from "./ai-usage-report-service.js";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const query = (value = "") =>
  parseAiUsageReportQuery(new URL(`http://localhost/report${value}`), NOW);
const roster: AiUsageReportUser[] = [
  {
    accountId: "person.one",
    displayName: "Example Person",
    department: "Engineering",
    status: "active",
    agentId: "agent-one",
  },
  {
    accountId: "person.two",
    displayName: "Other Person",
    department: "Engineering",
    status: "disabled",
    agentId: "agent-two",
  },
  {
    accountId: "person.three",
    displayName: null,
    department: "Sales",
    status: "active",
    agentId: null,
  },
];
type Day = {
  date: string;
  provider?: string;
  model?: string;
  count: number;
  tokens: number;
  missingTokenEntries?: number;
};
function source(days: Day[], status = "fresh", cachedFiles = 1, pendingFiles = 0) {
  return {
    aggregates: { modelDaily: days },
    totals: { totalTokens: days.reduce((sum, d) => sum + d.tokens, 0) },
    cacheStatus: { status, cachedFiles, pendingFiles },
  };
}
const days: Day[] = [
  { date: "2026-10-31", provider: "provider-a", model: "model-a", count: 2, tokens: 200 },
  { date: "2026-11-01", provider: "provider-a", model: "model-a", count: 3, tokens: 300 },
  { date: "2026-11-01", provider: "provider-a", model: "model-b", count: 1, tokens: 100 },
  { date: "2026-11-02", count: 1, tokens: 50 },
];
function setup(request: (method: string, params: unknown) => Promise<unknown>, users = roster) {
  return new AiUsageReportService({
    store: { listAiUsageReportUsers: async () => users },
    gateway: { request },
    now: () => NOW,
  });
}

describe("AI usage report service", () => {
  it("queries personal agents once per whole range and conserves model/service totals", async () => {
    const request = vi.fn(async () => source(days));
    const service = setup(request);
    const scope = "?knox_id=person.one&period=last_3_months";
    const report = await service.report(query(scope));
    expect(request).toHaveBeenCalledExactlyOnceWith("sessions.usage", {
      agentId: "agent-one",
      startDate: "2026-09-01",
      endDate: "2026-11-30",
      mode: "specific",
      timeZone: "Asia/Seoul",
      groupBy: "instance",
      limit: 0,
      includeContextWeight: false,
    });
    expect(report.raw_data).toEqual([
      {
        team: "Engineering",
        month: "2026-10",
        knox_id: "person.one",
        ai_service: "PlatformClaw",
        call_count: 2,
        token_usage: 200,
        provider: null,
        model: null,
      },
      {
        team: "Engineering",
        month: "2026-11",
        knox_id: "person.one",
        ai_service: "PlatformClaw",
        call_count: 5,
        token_usage: 450,
        provider: null,
        model: null,
      },
    ]);
    expect(report.meta).toMatchObject({
      total_tokens: 650,
      total_call_count: 7,
      team_size: 1,
      active_user_count: 1,
      data_status: "complete",
      warnings: ["HISTORICAL_COVERAGE_UNVERIFIED", "UNKNOWN_MODEL"],
    });
    const detail = await service.report(query(`${scope}&group_by=model`));
    expect(detail.raw_data).toHaveLength(4);
    expect(detail.meta.total_tokens).toBe(report.meta.total_tokens);
    expect(detail.meta.total_call_count).toBe(report.meta.total_call_count);
    expect(detail.raw_data.at(-1)).toMatchObject({ provider: null, model: null, token_usage: 50 });
  });

  it("filters provider before service grouping and keeps ranking totals distinct", async () => {
    const service = setup(async () => source(days.filter((day) => day.date.startsWith("2026-11"))));
    const report = await service.report(
      query(
        "?knox_id=person.one&provider=provider-a&group_by=model&sort=token_usage&order=desc&limit=1",
      ),
    );
    expect(report.raw_data).toEqual([
      expect.objectContaining({ model: "model-a", token_usage: 300 }),
    ]);
    expect(report.meta).toMatchObject({
      total_tokens: 400,
      returned_tokens: 300,
      total_call_count: 4,
      row_count: 1,
      total_row_count: 2,
      truncated: true,
    });
    const summary = await service.report(query("?knox_id=person.one&provider=provider-a"));
    expect(summary.raw_data[0]).toMatchObject({
      provider: null,
      model: null,
      token_usage: 400,
      call_count: 4,
    });
  });

  it("distinguishes unknown accounts from known people with no usage", async () => {
    const request = vi.fn(async () => source([]));
    const service = setup(request);
    await expect(service.report(query("?knox_id=person.one,missing.person"))).rejects.toMatchObject(
      {
        statusCode: 404,
        code: "USER_NOT_FOUND",
        details: { unknown_knox_ids: ["missing.person"] },
      },
    );
    expect(request).not.toHaveBeenCalled();
    const empty = await service.report(query("?knox_id=person.three"));
    expect(empty.raw_data).toEqual([]);
    expect(empty.meta).toMatchObject({
      total_tokens: 0,
      total_call_count: 0,
      active_user_count: 0,
      team_size: 1,
      data_status: "complete",
    });
  });

  it("keeps unknown token counts null while preserving measured zero and null-last ranking", async () => {
    const service = setup(async () =>
      source([
        {
          date: "2026-11-01",
          provider: "provider-a",
          model: "unknown-tokens",
          count: 1,
          tokens: 0,
          missingTokenEntries: 1,
        },
        { date: "2026-11-01", provider: "provider-a", model: "known-zero", count: 1, tokens: 0 },
      ]),
    );
    const report = await service.report(
      query("?knox_id=person.one&group_by=model&sort=token_usage&order=desc"),
    );
    expect(report.raw_data.map((row) => row.token_usage)).toEqual([0, null]);
    expect(report.meta).toMatchObject({
      total_tokens: null,
      returned_tokens: null,
      data_status: "partial",
      warnings: ["HISTORICAL_COVERAGE_UNVERIFIED", "UNKNOWN_TOKEN_USAGE"],
    });
    const filtered = await service.report(query("?knox_id=person.one&model=known-zero"));
    expect(filtered.meta).toMatchObject({ total_tokens: 0, data_status: "complete" });
  });

  it("does not turn cold caches or unavailable sources into zero reports", async () => {
    const cold = setup(async () => source([], "refreshing", 0, 1));
    await expect(cold.report(query("?knox_id=person.one"))).rejects.toMatchObject({
      statusCode: 503,
    });
    const broken = setup(async () => {
      throw new Error("private transport details");
    });
    await expect(broken.report(query())).rejects.toMatchObject({
      statusCode: 503,
      code: "REPORT_UNAVAILABLE",
    });
    const malformed = setup(async () => ({ totals: { totalTokens: 100 }, aggregates: {} }));
    await expect(malformed.report(query("?knox_id=person.one"))).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("marks mixed source failures partial without affecting a successful personal filter", async () => {
    const service = setup(async (_method, params) => {
      if (
        typeof params === "object" &&
        params !== null &&
        "agentId" in params &&
        params.agentId === "agent-two"
      ) {
        throw new Error("unavailable");
      }
      return source(days.filter((day) => day.date.startsWith("2026-11")));
    });
    const all = await service.report(query());
    expect(all.meta).toMatchObject({
      data_status: "partial",
      total_tokens: 450,
      warnings: ["HISTORICAL_COVERAGE_UNVERIFIED", "SOURCE_READ_INCOMPLETE", "UNKNOWN_MODEL"],
    });
    expect((await service.report(query("?knox_id=person.one"))).meta.data_status).toBe("complete");
  });

  it("searches account/display name, retains disabled users and paginates without usage calls", async () => {
    const request = vi.fn(async () => source([]));
    const service = setup(request);
    const page = await service.users(
      parseAiUsageReportUsersQuery(
        new URL("http://localhost/users?q=PERSON&team=Engineering&limit=1"),
      ),
    );
    expect(page).toEqual({
      users: [
        {
          knox_id: "person.one",
          display_name: "Example Person",
          team: "Engineering",
          status: "active",
        },
      ],
      meta: { total: 2, limit: 1, offset: 0, has_more: true, next_offset: 1 },
    });
    const disabled = await service.users(
      parseAiUsageReportUsersQuery(new URL("http://localhost/users?status=disabled")),
    );
    expect(disabled.users.map((user) => user.knox_id)).toEqual(["person.two"]);
    expect(request).not.toHaveBeenCalled();
  });

  it("joins identical in-flight reports and rereads changed roster identity", async () => {
    let resolveSource: ((value: unknown) => void) | undefined;
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const request = vi.fn(async () => {
      started?.();
      return await new Promise<unknown>((resolve) => {
        resolveSource = resolve;
      });
    });
    const mutable = roster.map((user) => ({ ...user }));
    const service = setup(request, mutable);
    const first = service.report(query("?knox_id=person.one"));
    await didStart;
    const second = service.report(query("?knox_id=person.one"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    resolveSource?.(source(days.filter((day) => day.date.startsWith("2026-11"))));
    expect(await first).toEqual(await second);
    mutable[0]!.department = "Renamed";
    request.mockResolvedValue(source([]));
    expect((await service.report(query("?knox_id=person.one"))).meta.filters.team).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds shared Gateway work across several independently filtered reports", async () => {
    const users = Array.from({ length: 6 }, (_, index) => ({
      ...roster[0]!,
      accountId: `person.${index}`,
      agentId: `agent-${index}`,
    }));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximum = 0;
    const request = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
      return source([{ date: "2026-11-01", provider: "p", model: "m", tokens: 1, count: 1 }]);
    });
    const service = setup(request, users);
    const reports = [1, 2, 3, 4].map((limit) => service.report(query(`?limit=${limit}`)));
    release?.();
    await Promise.all(reports);
    expect(maximum).toBe(4);
    expect(request).toHaveBeenCalledTimes(24);
  });

  it("settles running source calls before releasing an overflowing report slot", async () => {
    const users = Array.from({ length: 6 }, (_, index) => ({
      ...roster[0]!,
      accountId: `person.${index}`,
      agentId: `agent-${index}`,
    }));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn(async (_method: string, params: unknown) => {
      if (
        typeof params === "object" &&
        params !== null &&
        "agentId" in params &&
        params.agentId === "agent-0"
      ) {
        return source([
          {
            date: "2026-11-01",
            provider: "p",
            model: "m",
            count: Number.MAX_SAFE_INTEGER,
            tokens: 1,
          },
          { date: "2026-11-01", provider: "p", model: "m", count: 1, tokens: 1 },
        ]);
      }
      await gate;
      return source([]);
    });
    const service = setup(request, users);
    let settled = false;
    const report = service.report(query()).finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(request).toHaveBeenCalledTimes(4);
    release?.();
    await expect(report).rejects.toMatchObject({ statusCode: 503 });
    expect(request).toHaveBeenCalledTimes(4);
  });
});
