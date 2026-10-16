import type {
  DashboardQuery,
  DashboardReport,
} from "../../../packages/platformclaw-control-plane/src/dashboard-contracts.js";

export function dashboardUrl(query: DashboardQuery, excel = false): string {
  const params = new URLSearchParams(query);
  if (excel) {
    params.set("format", "xlsx");
  }
  return `/platformclaw/api/dashboard?${params}`;
}

export async function requestDashboard(
  fetchImpl: typeof fetch,
  query: DashboardQuery,
  signal: AbortSignal,
  onUnauthenticated: () => void,
): Promise<DashboardReport> {
  const response = await fetchImpl(dashboardUrl(query), { credentials: "same-origin", signal });
  if (response.status === 401) {
    onUnauthenticated();
  }
  if (!response.ok) {
    throw new Error("Dashboard request failed");
  }
  return (await response.json()) as DashboardReport;
}

function dashboardDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return ["year", "month", "day"]
    .map((key) => parts.find((part) => part.type === key)?.value)
    .join("-");
}

export function dashboardPreset(
  days: number,
  timeZone: string,
): Pick<DashboardQuery, "startDate" | "endDate"> {
  const endDate = dashboardDate(new Date(), timeZone);
  const startDate = new Date(Date.parse(`${endDate}T12:00:00Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { startDate, endDate };
}
