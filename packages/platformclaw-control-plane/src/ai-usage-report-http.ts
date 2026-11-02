import type { IncomingMessage, ServerResponse } from "node:http";
import { AiUsageReportError, type AiUsageReport } from "./ai-usage-report-contracts.js";
import { parseAiUsageReportQuery, parseAiUsageReportUsersQuery } from "./ai-usage-report-query.js";
import type { AiUsageReportService } from "./ai-usage-report-service.js";
import { sendBrowserJson } from "./browser-http-shared.js";

const AI_USAGE_REPORT_PATH = "/platformclaw/api/v1/reports/ai-usage";
const AI_USAGE_REPORT_USERS_PATH = `${AI_USAGE_REPORT_PATH}/users`;

const CSV_FIELDS = [
  "team",
  "month",
  "knox_id",
  "ai_service",
  "call_count",
  "token_usage",
  "provider",
  "model",
] as const;

function csvCell(value: string | number | null): string {
  if (value === null) {
    return "";
  }
  let text = String(value);
  // Excel evaluates formula-shaped text even inside CSV quotes. Only text is
  // escaped; numeric metrics stay numeric and JSON preserves original values.
  if (typeof value === "string" && /^[=+@\-\t\r\n]/u.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatAiUsageReportCsv(report: AiUsageReport): string {
  const rows = report.raw_data.map((row) =>
    CSV_FIELDS.map((field) => csvCell(row[field])).join(","),
  );
  return `\uFEFF${[CSV_FIELDS.join(","), ...rows].join("\r\n")}\r\n`;
}

/** Network policy belongs to the intranet edge; only these numeric report paths bypass login. */
export async function handleAiUsageReportRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: AiUsageReportService,
  now: () => number = Date.now,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== AI_USAGE_REPORT_PATH && url.pathname !== AI_USAGE_REPORT_USERS_PATH) {
    return false;
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      throw new AiUsageReportError(405, "METHOD_NOT_ALLOWED", "Use GET for usage reports");
    }
    if (
      req.headers["transfer-encoding"] !== undefined ||
      (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0")
    ) {
      req.resume();
      throw new AiUsageReportError(
        400,
        "INVALID_REQUEST",
        "Usage report requests cannot have a body",
      );
    }
    if (url.pathname === AI_USAGE_REPORT_USERS_PATH) {
      sendBrowserJson(res, 200, await service.users(parseAiUsageReportUsersQuery(url)));
      return true;
    }
    const query = parseAiUsageReportQuery(url, now());
    const report = await service.report(query);
    if (query.format === "json") {
      sendBrowserJson(res, 200, report);
      return true;
    }
    if (report.meta.data_status !== "complete") {
      throw new AiUsageReportError(
        503,
        "REPORT_UNAVAILABLE",
        "CSV requires complete usage data. Retry or use JSON to inspect collection warnings",
      );
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="ai-usage-${query.startMonth}_${query.endMonth}-${query.groupBy}.csv"`,
    );
    res.setHeader("X-Report-Data-Status", report.meta.data_status);
    res.setHeader("X-Report-Truncated", String(report.meta.truncated));
    res.setHeader("X-Report-Total-Rows", report.meta.total_row_count);
    res.setHeader("X-Report-Total-Tokens", report.meta.total_tokens ?? "unknown");
    res.end(formatAiUsageReportCsv(report));
  } catch (error) {
    const failure =
      error instanceof AiUsageReportError
        ? error
        : new AiUsageReportError(
            503,
            "REPORT_UNAVAILABLE",
            "Usage report unavailable. Retry later",
          );
    if (failure.statusCode === 429 || failure.statusCode === 503) {
      res.setHeader("Retry-After", "10");
    }
    sendBrowserJson(res, failure.statusCode, {
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
    });
  }
  return true;
}
