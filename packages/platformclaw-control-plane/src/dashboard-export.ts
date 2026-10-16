import writeXlsxFile, { type Cell, type Sheet } from "write-excel-file/node";
import type { DashboardReport } from "./dashboard-contracts.js";

export async function createDashboardWorkbook(report: DashboardReport): Promise<Buffer> {
  const sheets: Sheet<never>[] = [];
  const sheet = (
    name: string,
    headers: string[],
    rows: Array<Array<string | number | Date | null>>,
  ) => {
    sheets.push({
      sheet: name,
      stickyRowsCount: 1,
      dateFormat: "yyyy-mm-dd hh:mm:ss",
      columns: headers.map((header) => ({ width: Math.min(48, Math.max(18, header.length + 6)) })),
      data: [
        headers.map((value) => ({ type: String, value, fontWeight: "bold" })),
        ...rows.map((row) =>
          row.map((value): Cell => {
            // Explicit string cells keep formula-like account names literal in Excel.
            if (typeof value === "string") {
              return { type: String, value };
            }
            if (typeof value === "number") {
              return { type: Number, value };
            }
            if (value instanceof Date) {
              return { type: Date, value };
            }
            return null;
          }),
        ),
      ],
    });
  };
  sheet(
    "Overview",
    ["Metric", "Value"],
    [
      ["Registered accounts", report.totals.registeredAccounts],
      ["Active accounts", report.totals.activeAccounts],
      ["Request messages", report.totals.requests],
      ["Previous request messages", report.totals.previousRequests],
      ["Tool calls", report.totals.toolCalls],
      ["Tokens", report.totals.tokens],
      ["Estimated cost (USD)", report.totals.estimatedCost],
      ["Unpriced entries", report.totals.missingCostEntries],
    ],
  );
  sheet(
    "Accounts",
    [
      "Account",
      "Name",
      "Agent",
      "Organization",
      "Status",
      "Requests",
      "Previous requests",
      "Active days",
      "Tool calls",
      "Tokens",
      "Estimated USD",
      "Unpriced entries",
      "Last activity (UTC)",
    ],
    report.accounts.map((account) => [
      account.accountId,
      account.displayName,
      account.agentId,
      account.organizationName,
      account.status,
      account.requests,
      account.previousRequests,
      account.activeDays,
      account.toolCalls,
      account.tokens,
      account.estimatedCost,
      account.missingCostEntries,
      account.lastActivity ? new Date(account.lastActivity) : null,
    ]),
  );
  sheet(
    "Daily",
    ["Date", "Request messages", "Active accounts"],
    report.daily.map((day) => [day.date, day.requests, day.activeAccounts]),
  );
  sheet(
    "Hours",
    ["Weekday (Monday=1)", "Hour", "Request messages"],
    report.heatmap.map((cell) => [cell.weekday + 1, cell.hour, cell.requests]),
  );
  sheet(
    "Definitions",
    ["Setting", "Value"],
    [
      ...Object.entries(report.query),
      ["Generated at (UTC)", new Date(report.updatedAt).toISOString()],
      ["Current data status", report.cacheStatus],
      ["Previous data status", report.previousCacheStatus],
      ["Previous start date", report.previousStartDate],
      ["Previous end date", report.previousEndDate],
      [
        "Request definition",
        "Transcript user-role messages; may include automated or synthetic messages. Not model calls or completed tasks.",
      ],
      [
        "Scope",
        "Registered personal accounts, including disabled accounts. Shared room agents are excluded.",
      ],
      [
        "History",
        "Available retained conversation history; deleted history and missing usage are not reconstructed.",
      ],
      ["Organization", "Current primary organization; not historical membership."],
      [
        "Cost",
        "Estimated USD from available usage and prices; not a provider invoice. Missing prices are reported separately.",
      ],
    ],
  );
  return writeXlsxFile(sheets).toBuffer();
}
