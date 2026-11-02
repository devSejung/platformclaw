export type AiUsageReportUser = {
  accountId: string;
  displayName: string | null;
  department: string | null;
  status: "active" | "disabled";
  agentId: string | null;
};

type AiUsageReportFilters = {
  knox_id: string[];
  team: string | null;
  provider: string | null;
  model: string | null;
};

export type AiUsageReportQuery = {
  startMonth: string;
  endMonth: string;
  months: string[];
  startDate: string;
  endDate: string;
  filters: AiUsageReportFilters;
  groupBy: "service" | "model";
  sort: "month" | "knox_id" | "call_count" | "token_usage";
  order: "asc" | "desc";
  limit: number | null;
  format: "json" | "csv";
};

export type AiUsageReportUsersQuery = {
  q: string | null;
  team: string | null;
  status: "all" | "active" | "disabled";
  limit: number;
  offset: number;
};

export type AiUsageReportRow = {
  team: string | null;
  month: string;
  knox_id: string;
  ai_service: "PlatformClaw";
  call_count: number;
  token_usage: number | null;
  provider: string | null;
  model: string | null;
};

export type AiUsageReport = {
  raw_data: AiUsageReportRow[];
  meta: {
    schema_version: "1";
    source: "platformclaw";
    fetched_at: number;
    row_count: number;
    active_row_count: number;
    team_size: number;
    active_user_count: number;
    months: string[];
    total_tokens: number | null;
    returned_tokens: number | null;
    total_call_count: number;
    total_row_count: number;
    truncated: boolean;
    filters: AiUsageReportFilters;
    sort: AiUsageReportQuery["sort"];
    order: AiUsageReportQuery["order"];
    limit: number | null;
    timezone: "Asia/Seoul";
    group_by: AiUsageReportQuery["groupBy"];
    scope: "personal_agents";
    call_count_basis: "usage_records";
    token_usage_basis: "provider_total_or_components";
    coverage: "retained_records";
    data_status: "complete" | "partial";
    warnings: string[];
  };
};

export type AiUsageReportUsers = {
  users: Array<{
    knox_id: string;
    display_name: string | null;
    team: string | null;
    status: "active" | "disabled";
  }>;
  meta: {
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
    next_offset: number | null;
  };
};

export class AiUsageReportError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: { unknown_knox_ids: string[] },
  ) {
    super(message);
    this.name = "AiUsageReportError";
  }
}
