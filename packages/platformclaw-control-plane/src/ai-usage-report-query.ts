import {
  AiUsageReportError,
  type AiUsageReportQuery,
  type AiUsageReportUsersQuery,
} from "./ai-usage-report-contracts.js";

const REPORT_PARAMETERS = new Set([
  "month",
  "start_month",
  "end_month",
  "period",
  "knox_id",
  "team",
  "provider",
  "model",
  "group_by",
  "sort",
  "order",
  "limit",
  "format",
]);
const USERS_PARAMETERS = new Set(["q", "team", "status", "limit", "offset"]);

function invalid(message: string): never {
  throw new AiUsageReportError(400, "INVALID_REQUEST", message);
}

function validateParameters(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      invalid(`Unknown or repeated query parameter: ${key}`);
    }
    if ((url.searchParams.get(key)?.length ?? 0) > 16_384) {
      invalid(`Query parameter is too long: ${key}`);
    }
  }
}

function optionalText(url: URL, key: string, maximum = 256): string | null {
  const raw = url.searchParams.get(key);
  if (raw === null) {
    return null;
  }
  const value = raw.trim();
  if (!value || Array.from(value).length > maximum) {
    invalid(`${key} must contain between 1 and ${maximum} characters`);
  }
  return value;
}

function choice<T extends string>(url: URL, key: string, allowed: readonly T[], fallback: T): T {
  const value = optionalText(url, key);
  if (value === null) {
    return fallback;
  }
  const selected = allowed.find((candidate) => candidate === value);
  return selected ?? invalid(`Unsupported ${key}: ${value}`);
}

function integer(url: URL, key: string, minimum: number, maximum: number): number | null {
  const value = optionalText(url, key);
  if (value === null) {
    return null;
  }
  if (!/^\d+$/u.test(value)) {
    invalid(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    invalid(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function monthIndex(value: string): number {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value) || value.startsWith("0000")) {
    invalid("Months must use YYYY-MM format with a year between 0001 and 9999");
  }
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
}

function monthKey(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function dateRange(url: URL, now: number) {
  const currentMonth = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const current = monthIndex(currentMonth);
  const month = optionalText(url, "month");
  const start = optionalText(url, "start_month");
  const end = optionalText(url, "end_month");
  const period = optionalText(url, "period");
  if (
    Number(month !== null) + Number(start !== null || end !== null) + Number(period !== null) >
    1
  ) {
    invalid("Choose month, start_month/end_month, or period, not several date selectors");
  }
  if ((start === null) !== (end === null)) {
    invalid("start_month and end_month must be supplied together");
  }
  let first = current;
  let last = current;
  if (month !== null) {
    first = last = monthIndex(month);
  } else if (start !== null && end !== null) {
    first = monthIndex(start);
    last = monthIndex(end);
  } else if (period === "last_month") {
    first = last = current - 1;
  } else if (period === "last_3_months") {
    first = current - 2;
  } else if (period === "this_year") {
    first = Math.floor(current / 12) * 12;
  } else if (period !== null && period !== "this_month") {
    invalid(`Unsupported period: ${period}`);
  }
  if (last < first || last - first >= 12 || last > current || first < 12) {
    invalid("Select between 1 and 12 calendar months, without future months");
  }
  const months = Array.from({ length: last - first + 1 }, (_, index) => monthKey(first + index));
  const startMonth = monthKey(first);
  const endMonth = monthKey(last);
  // UTC is used only for calendar arithmetic; the Gateway applies Asia/Seoul
  // when interpreting these date labels and selecting actual usage events.
  const nextMonth = new Date(`${monthKey(last + 1)}-01T00:00:00Z`);
  const endDate = new Date(nextMonth.getTime() - 86_400_000).toISOString().slice(0, 10);
  return { startMonth, endMonth, months, startDate: `${startMonth}-01`, endDate };
}

export function parseAiUsageReportQuery(url: URL, now = Date.now()): AiUsageReportQuery {
  validateParameters(url, REPORT_PARAMETERS);
  const rawAccounts = optionalText(url, "knox_id", 16_384)?.split(",") ?? [];
  if (rawAccounts.length > 100 || rawAccounts.some((account) => !account.trim())) {
    invalid("knox_id must contain between 1 and 100 nonempty submitted accounts");
  }
  return {
    ...dateRange(url, now),
    filters: {
      knox_id: [...new Set(rawAccounts.map((account) => account.trim().toLowerCase()))].toSorted(),
      team: optionalText(url, "team"),
      provider: optionalText(url, "provider"),
      model: optionalText(url, "model"),
    },
    groupBy: choice(url, "group_by", ["service", "model"], "service"),
    sort: choice(url, "sort", ["month", "knox_id", "call_count", "token_usage"], "month"),
    order: choice(url, "order", ["asc", "desc"], "asc"),
    limit: integer(url, "limit", 1, 100_000),
    format: choice(url, "format", ["json", "csv"], "json"),
  };
}

export function parseAiUsageReportUsersQuery(url: URL): AiUsageReportUsersQuery {
  validateParameters(url, USERS_PARAMETERS);
  return {
    q: optionalText(url, "q", 100)?.normalize("NFC").toLowerCase() ?? null,
    team: optionalText(url, "team"),
    status: choice(url, "status", ["all", "active", "disabled"], "all"),
    limit: integer(url, "limit", 1, 100) ?? 20,
    offset: integer(url, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0,
  };
}
