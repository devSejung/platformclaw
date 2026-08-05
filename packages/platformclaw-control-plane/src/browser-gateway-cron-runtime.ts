import {
  assertBrowserCronJobResult,
  browserCronListScope,
  projectBrowserCronResult,
} from "./browser-gateway-cron-policy.js";

type JsonObject = Record<string, unknown>;

type BrowserCronRuntime = {
  agentId: string;
  gateway: { request(method: string, params?: unknown): Promise<unknown> };
  resolveAgentIdFromSessionKey: (sessionKey: string) => string | null;
  deny: (message: string) => never;
  invalidParams: (message: string) => never;
};

const CRON_RUN_PAGE_LIMIT = 200;
const CRON_HISTORY_CONCURRENCY = 8;

function asObject(value: unknown, label: string, deny: (message: string) => never): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return deny(`${label} must be an object`);
  }
  return value as JsonObject;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

export async function requestBrowserCronList(
  runtime: BrowserCronRuntime,
  params: JsonObject,
): Promise<JsonObject> {
  const result = await runtime.gateway.request("cron.list", {
    ...params,
    // Browser list and derived status reads never need routing labels/details.
    includeDeliveryPreviews: false,
    ...browserCronListScope(runtime.agentId),
  });
  return projectBrowserCronResult({
    method: "cron.list",
    result,
    agentId: runtime.agentId,
    sessionKeyBelongsToAgent: (sessionKey) =>
      runtime.resolveAgentIdFromSessionKey(sessionKey) === runtime.agentId,
    deny: runtime.deny,
  }) as JsonObject;
}

export async function requestBrowserCronStatus(runtime: BrowserCronRuntime): Promise<JsonObject> {
  const [rawStatus, allPage, nextPage] = await Promise.all([
    runtime.gateway.request("cron.status", {}),
    requestBrowserCronList(runtime, { includeDisabled: true, limit: 1, offset: 0 }),
    requestBrowserCronList(runtime, {
      enabled: "enabled",
      sortBy: "nextRunAtMs",
      sortDir: "asc",
      limit: 1,
      offset: 0,
    }),
  ]);
  const status = asObject(rawStatus, "cron.status result", (message) => runtime.deny(message));
  const nextJobs = Array.isArray(nextPage.jobs) ? (nextPage.jobs as JsonObject[]) : [];
  const nextRunAtMs = (nextJobs[0]?.state as JsonObject | undefined)?.nextRunAtMs;
  return {
    enabled: status.enabled === true,
    jobs: typeof allPage.total === "number" ? allPage.total : 0,
    nextWakeAtMs: typeof nextRunAtMs === "number" ? nextRunAtMs : null,
  };
}

export async function assertOwnedBrowserCronJob(
  runtime: BrowserCronRuntime,
  params: JsonObject,
): Promise<JsonObject> {
  const jobId = optionalString(params.id) ?? optionalString(params.jobId);
  if (!jobId) {
    return runtime.invalidParams("cron job id is required");
  }
  const result = await runtime.gateway.request("cron.get", { id: jobId });
  return assertBrowserCronJobResult({
    result,
    agentId: runtime.agentId,
    label: "cron.get result",
    sessionKeyBelongsToAgent: (sessionKey) =>
      runtime.resolveAgentIdFromSessionKey(sessionKey) === runtime.agentId,
    deny: runtime.deny,
  });
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectBrowserCronRunEntry(params: {
  entry: unknown;
  job: JsonObject;
  runtime: BrowserCronRuntime;
}): JsonObject {
  const entry = asObject(params.entry, "cron run entry", params.runtime.deny);
  const jobId = optionalString(entry.jobId);
  if (
    jobId !== optionalString(params.job.id) ||
    finiteNumber(entry.ts) === undefined ||
    entry.action !== "finished"
  ) {
    return params.runtime.deny("Gateway returned cron history outside the owned job registry");
  }
  const sessionKey = optionalString(entry.sessionKey);
  if (
    sessionKey &&
    params.runtime.resolveAgentIdFromSessionKey(sessionKey) !== params.runtime.agentId
  ) {
    return params.runtime.deny("Gateway returned cross-Agent cron run session metadata");
  }
  const status =
    entry.status === "ok" || entry.status === "error" || entry.status === "skipped"
      ? entry.status
      : undefined;
  const deliveryStatus =
    entry.deliveryStatus === "delivered" ||
    entry.deliveryStatus === "not-delivered" ||
    entry.deliveryStatus === "unknown" ||
    entry.deliveryStatus === "not-requested"
      ? entry.deliveryStatus
      : undefined;
  const rawUsage =
    entry.usage && typeof entry.usage === "object" && !Array.isArray(entry.usage)
      ? (entry.usage as JsonObject)
      : undefined;
  const usage = rawUsage
    ? withoutUndefined({
        input_tokens: finiteNumber(rawUsage.input_tokens),
        output_tokens: finiteNumber(rawUsage.output_tokens),
        total_tokens: finiteNumber(rawUsage.total_tokens),
        cache_read_tokens: finiteNumber(rawUsage.cache_read_tokens),
        cache_write_tokens: finiteNumber(rawUsage.cache_write_tokens),
      })
    : undefined;
  return withoutUndefined({
    ts: entry.ts,
    jobId,
    action: "finished",
    status,
    delivered: typeof entry.delivered === "boolean" ? entry.delivered : undefined,
    deliveryStatus,
    sessionKey,
    runAtMs: finiteNumber(entry.runAtMs),
    durationMs: finiteNumber(entry.durationMs),
    nextRunAtMs: finiteNumber(entry.nextRunAtMs),
    model: optionalString(entry.model),
    provider: optionalString(entry.provider),
    usage: usage && Object.keys(usage).length > 0 ? usage : undefined,
    jobName: optionalString(params.job.name),
  });
}

async function requestAllOwnedBrowserCronJobs(runtime: BrowserCronRuntime): Promise<JsonObject[]> {
  const jobs: JsonObject[] = [];
  let offset = 0;
  for (;;) {
    const page = await requestBrowserCronList(runtime, {
      includeDisabled: true,
      limit: CRON_RUN_PAGE_LIMIT,
      offset,
    });
    const pageJobs = Array.isArray(page.jobs) ? (page.jobs as JsonObject[]) : [];
    jobs.push(...pageJobs);
    const nextOffset = finiteNumber(page.nextOffset);
    if (page.hasMore !== true || nextOffset === undefined || nextOffset <= offset) {
      return jobs;
    }
    offset = nextOffset;
  }
}

function cronRunsFilters(params: JsonObject): JsonObject {
  const result = { ...params };
  delete result.id;
  delete result.jobId;
  delete result.scope;
  delete result.offset;
  delete result.limit;
  return result;
}

async function requestOwnedJobCronRuns(params: {
  runtime: BrowserCronRuntime;
  job: JsonObject;
  filters: JsonObject;
  offset: number;
  limit: number;
}): Promise<{ entries: JsonObject[]; total: number }> {
  const jobId = optionalString(params.job.id);
  if (!jobId) {
    return params.runtime.deny("Gateway returned an invalid owned cron job");
  }
  const entries: JsonObject[] = [];
  let pageOffset = 0;
  const targetCount = params.offset + params.limit;
  let total: number;
  for (;;) {
    const pageLimit = Math.min(CRON_RUN_PAGE_LIMIT, Math.max(1, targetCount - entries.length));
    const rawPage = await params.runtime.gateway.request("cron.runs", {
      ...params.filters,
      agentId: params.runtime.agentId,
      scope: "job",
      id: jobId,
      offset: pageOffset,
      limit: pageLimit,
    });
    const page = asObject(rawPage, "cron.runs result", params.runtime.deny);
    const rawEntries = Array.isArray(page.entries) ? page.entries : null;
    if (!rawEntries) {
      return params.runtime.deny("Gateway returned an invalid cron run page");
    }
    entries.push(
      ...rawEntries.map((entry) =>
        projectBrowserCronRunEntry({ entry, job: params.job, runtime: params.runtime }),
      ),
    );
    total = finiteNumber(page.total) ?? entries.length;
    const nextOffset = finiteNumber(page.nextOffset);
    if (
      entries.length >= targetCount ||
      page.hasMore !== true ||
      nextOffset === undefined ||
      nextOffset <= pageOffset
    ) {
      return { entries, total };
    }
    pageOffset = nextOffset;
  }
}

export async function requestBrowserCronRuns(
  runtime: BrowserCronRuntime,
  params: JsonObject,
  page: { offset: number; limit: number },
): Promise<JsonObject> {
  const jobId = optionalString(params.id) ?? optionalString(params.jobId);
  const scope = params.scope === "job" || jobId ? "job" : "all";
  const filters = cronRunsFilters(params);
  if (scope === "job") {
    const job = await assertOwnedBrowserCronJob(runtime, { id: jobId });
    const result = await requestOwnedJobCronRuns({
      runtime,
      job,
      filters,
      offset: page.offset,
      limit: page.limit,
    });
    const entries = result.entries.slice(page.offset, page.offset + page.limit);
    const nextOffset = page.offset + entries.length;
    return {
      entries,
      total: result.total,
      limit: page.limit,
      offset: page.offset,
      nextOffset: nextOffset < result.total ? nextOffset : null,
      hasMore: nextOffset < result.total,
    };
  }

  const jobs = await requestAllOwnedBrowserCronJobs(runtime);
  const histories: Array<{ entries: JsonObject[]; total: number }> = [];
  for (let index = 0; index < jobs.length; index += CRON_HISTORY_CONCURRENCY) {
    histories.push(
      ...(await Promise.all(
        jobs.slice(index, index + CRON_HISTORY_CONCURRENCY).map(
          async (job) =>
            await requestOwnedJobCronRuns({
              runtime,
              job,
              filters,
              offset: page.offset,
              limit: page.limit,
            }),
        ),
      )),
    );
  }
  const direction = params.sortDir === "asc" ? 1 : -1;
  const merged = histories
    .flatMap((history) => history.entries)
    .toSorted(
      (left, right) =>
        direction * ((left.ts as number) - (right.ts as number)) ||
        String(left.jobId).localeCompare(String(right.jobId)),
    );
  const total = histories.reduce((sum, history) => sum + history.total, 0);
  const entries = merged.slice(page.offset, page.offset + page.limit);
  const nextOffset = page.offset + entries.length;
  return {
    entries,
    total,
    limit: page.limit,
    offset: page.offset,
    nextOffset: nextOffset < total ? nextOffset : null,
    hasMore: nextOffset < total,
  };
}
