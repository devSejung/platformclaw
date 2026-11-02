import { describe, expect, it } from "vitest";
import { AiUsageReportError } from "./ai-usage-report-contracts.js";
import { parseAiUsageReportQuery, parseAiUsageReportUsersQuery } from "./ai-usage-report-query.js";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const url = (query = "") => new URL(`http://localhost/report${query}`);

describe("AI usage report queries", () => {
  it("defaults to the Korean calendar month and resolves relative periods once", () => {
    expect(parseAiUsageReportQuery(url(), Date.parse("2026-10-31T14:59:59Z"))).toMatchObject({
      months: ["2026-10"],
      startDate: "2026-10-01",
      endDate: "2026-10-31",
      groupBy: "service",
      format: "json",
      limit: null,
    });
    expect(parseAiUsageReportQuery(url(), Date.parse("2026-10-31T15:00:00Z")).months).toEqual([
      "2026-11",
    ]);
    expect(parseAiUsageReportQuery(url("?period=last_3_months"), NOW).months).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
    expect(
      parseAiUsageReportQuery(url("?period=last_month"), Date.parse("2026-01-02T00:00:00Z")),
    ).toMatchObject({ months: ["2025-12"], endDate: "2025-12-31" });
    expect(parseAiUsageReportQuery(url("?month=2024-02"), NOW).endDate).toBe("2024-02-29");
  });

  it("normalizes batch identities while retaining exact department and model filters", () => {
    const parsed = parseAiUsageReportQuery(
      url(
        "?knox_id=PERSON.ONE,%20person.two,person.one&team=Example%20Engineering&provider=Provider&model=Model&group_by=model&format=csv&sort=token_usage&order=desc&limit=10",
      ),
      NOW,
    );
    expect(parsed).toMatchObject({
      filters: {
        knox_id: ["person.one", "person.two"],
        team: "Example Engineering",
        provider: "Provider",
        model: "Model",
      },
      groupBy: "model",
      format: "csv",
      sort: "token_usage",
      order: "desc",
      limit: 10,
    });
  });

  it.each([
    "?month=2026-10&period=this_month",
    "?month=2026-10&start_month=2026-10&end_month=2026-10",
    "?start_month=2026-10",
    "?end_month=2026-10",
    "?start_month=2025-10&end_month=2026-10",
    "?start_month=2026-10&end_month=2026-09",
    "?month=2026-12",
    "?month=2026-13",
    "?month=0000-10",
    "?month=2026-10&month=2026-10",
    "?future=true",
    "?period=weekly",
    "?knox_id=person.one,",
    "?knox_id=",
    "?team=%20",
    "?limit=0",
    "?limit=1.5",
    "?limit=100001",
    "?format=xlsx",
    "?order=backwards",
  ])("rejects invalid or ambiguous request %s", (query) => {
    expect(() => parseAiUsageReportQuery(url(query), NOW)).toThrow(AiUsageReportError);
  });

  it("bounds submitted account entries before deduplication", () => {
    expect(() =>
      parseAiUsageReportQuery(url(`?knox_id=${Array(101).fill("person.one").join(",")}`), NOW),
    ).toThrow("100");
    expect(
      parseAiUsageReportQuery(url(`?knox_id=${Array(100).fill("person.one").join(",")}`), NOW)
        .filters.knox_id,
    ).toEqual(["person.one"]);
  });

  it("parses Unicode directory search and validated pagination", () => {
    expect(
      parseAiUsageReportUsersQuery(url("?q=%20PERSON%20&status=disabled&limit=5&offset=20")),
    ).toEqual({ q: "person", team: null, status: "disabled", limit: 5, offset: 20 });
    expect(parseAiUsageReportUsersQuery(url())).toEqual({
      q: null,
      team: null,
      status: "all",
      limit: 20,
      offset: 0,
    });
    expect(() => parseAiUsageReportUsersQuery(url("?q=%20"))).toThrow(AiUsageReportError);
    expect(() => parseAiUsageReportUsersQuery(url("?offset=9007199254740992"))).toThrow(
      AiUsageReportError,
    );
    expect(() => parseAiUsageReportUsersQuery(url("?q=person&q=person"))).toThrow(
      AiUsageReportError,
    );
  });
});
