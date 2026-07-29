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

function asObject(value: unknown, label: string, deny: (message: string) => never): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return deny(`${label} must be an object`);
  }
  return value as JsonObject;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
