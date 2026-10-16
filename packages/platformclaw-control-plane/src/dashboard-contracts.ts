export type DashboardAccount = {
  accountId: string;
  displayName: string | null;
  status: "active" | "disabled";
  createdAt: number;
  agentId: string | null;
  organizationId: string | null;
  organizationName: string | null;
};

export type DashboardQuery = {
  startDate: string;
  endDate: string;
  timeZone: string;
  accountId: string;
  organizationId: string;
  channel: string;
  kind: string;
};

export type DashboardMetrics = {
  requests: number;
  toolCalls: number;
  tokens: number;
  estimatedCost: number;
  missingCostEntries: number;
};

export type DashboardAccountUsage = Omit<DashboardAccount, "createdAt"> &
  DashboardMetrics & {
    previousRequests: number;
    activeDays: number;
    lastActivity: number | null;
  };

export type DashboardReport = {
  query: DashboardQuery;
  updatedAt: number;
  previousStartDate: string;
  previousEndDate: string;
  cacheStatus: "fresh" | "partial" | "stale" | "refreshing";
  previousCacheStatus: "fresh" | "partial" | "stale" | "refreshing";
  totals: DashboardMetrics & {
    registeredAccounts: number;
    activeAccounts: number;
    previousRequests: number;
  };
  daily: Array<{ date: string; requests: number; activeAccounts: number }>;
  heatmap: Array<{ weekday: number; hour: number; requests: number }>;
  accounts: DashboardAccountUsage[];
  options: {
    accounts: Array<{ accountId: string; displayName: string | null }>;
    organizations: Array<{ id: string; name: string }>;
    channels: string[];
    kinds: string[];
  };
};
