import {
  prepareBrowserCronRequest,
  projectBrowserCronResult,
} from "./browser-gateway-cron-policy.js";
import {
  assertOwnedBrowserCronJob,
  requestBrowserCronList,
  requestBrowserCronStatus,
} from "./browser-gateway-cron-runtime.js";

type JsonObject = Record<string, unknown>;
type CronErrorCode =
  | "invalid-params"
  | "cross-agent-denied"
  | "method-not-allowed"
  | "upstream-result-denied";

export type BrowserCronContext = {
  agentId: string;
  mainSessionKey: string;
  accountId: string;
  gateway: { request(method: string, params?: unknown): Promise<unknown> };
  resolveAgentIdFromSessionKey: (sessionKey: string) => string | null;
  assertOptionalAgentId: (value: unknown, label: string) => void;
  assertOwnedSessionKey: (value: unknown, label: string) => void;
  fail: (code: CronErrorCode, message: string) => never;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pageInteger(
  value: unknown,
  fallback: number,
  label: string,
  options: { minimum: number; maximum?: number },
): number {
  const resolved = value === undefined ? fallback : value;
  if (
    typeof resolved !== "number" ||
    !Number.isInteger(resolved) ||
    resolved < options.minimum ||
    (options.maximum !== undefined && resolved > options.maximum)
  ) {
    const range =
      options.maximum === undefined
        ? `at least ${options.minimum}`
        : `between ${options.minimum} and ${options.maximum}`;
    throw new TypeError(`${label} must be an integer ${range}`);
  }
  return resolved;
}

function runtime(context: BrowserCronContext, errorCode: CronErrorCode) {
  return {
    agentId: context.agentId,
    gateway: context.gateway,
    resolveAgentIdFromSessionKey: (sessionKey: string) =>
      context.resolveAgentIdFromSessionKey(sessionKey),
    deny: (message: string): never => context.fail(errorCode, message),
    invalidParams: (message: string): never => context.fail("invalid-params", message),
  };
}

export function prepareCronRequest(
  context: BrowserCronContext,
  method: string,
  params: JsonObject,
): JsonObject | undefined {
  return prepareBrowserCronRequest({
    method,
    params,
    agentId: context.agentId,
    ownerSessionKey: context.mainSessionKey,
    ownerAccountId: context.accountId,
    assertOptionalAgentId: (value) => context.assertOptionalAgentId(value, method),
    assertOwnedSessionKey: (value, label) => context.assertOwnedSessionKey(value, label),
    deny: (message) => context.fail("method-not-allowed", message),
  });
}

export async function preflightCronMutation(
  context: BrowserCronContext,
  method: string,
  prepared: JsonObject,
): Promise<void> {
  if (
    method !== "cron.get" &&
    method !== "cron.update" &&
    method !== "cron.remove" &&
    method !== "cron.run"
  ) {
    return;
  }
  const job = await assertOwnedBrowserCronJob(runtime(context, "cross-agent-denied"), prepared);
  if (method === "cron.get") {
    return;
  }
  const expectedConfigRevision = optionalString(prepared.expectedConfigRevision);
  if (!expectedConfigRevision) {
    context.fail("invalid-params", "cron mutation requires the loaded job config revision");
  }
  if (optionalString(job.configRevision) !== expectedConfigRevision) {
    context.fail("invalid-params", "cron job changed after it was loaded; refresh before retrying");
  }
}

export async function requestSpecialCronResult(
  context: BrowserCronContext,
  method: string,
  prepared: JsonObject,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const cronRuntime = runtime(context, "upstream-result-denied");
  if (method === "cron.list") {
    return { handled: true, result: await requestBrowserCronList(cronRuntime, prepared) };
  }
  if (method === "cron.status") {
    return { handled: true, result: await requestBrowserCronStatus(cronRuntime) };
  }
  if (method === "cron.runs") {
    let offset: number;
    let limit: number;
    try {
      offset = pageInteger(prepared.offset, 0, "cron.runs offset", { minimum: 0 });
      limit = pageInteger(prepared.limit, 50, "cron.runs limit", {
        minimum: 1,
        maximum: 200,
      });
    } catch (error) {
      return context.fail(
        "invalid-params",
        error instanceof Error ? error.message : "invalid cron.runs pagination",
      );
    }
    return {
      handled: true,
      result: { entries: [], total: 0, limit, offset, nextOffset: null, hasMore: false },
    };
  }
  return { handled: false };
}

export function projectCronResult(
  context: BrowserCronContext,
  method: string,
  result: unknown,
): unknown {
  return projectBrowserCronResult({
    method,
    result,
    agentId: context.agentId,
    sessionKeyBelongsToAgent: (sessionKey) =>
      context.resolveAgentIdFromSessionKey(sessionKey) === context.agentId,
    deny: (message) => context.fail("upstream-result-denied", message),
  });
}
