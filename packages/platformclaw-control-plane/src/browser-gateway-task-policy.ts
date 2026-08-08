import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";

type JsonObject = Record<string, unknown>;

type TaskProjectionFailure = (message: string) => never;

type BrowserTaskAccess = {
  agentId: string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
};

type BrowserTaskMethod =
  | "tasks.cancel"
  | "tasks.dismiss"
  | "tasks.get"
  | "tasks.list"
  | "tasks.retry";

const BROWSER_TASK_METHODS = new Set<BrowserTaskMethod>([
  "tasks.cancel",
  "tasks.dismiss",
  "tasks.get",
  "tasks.list",
  "tasks.retry",
]);

export function isBrowserTaskMethod(method: string): method is BrowserTaskMethod {
  return BROWSER_TASK_METHODS.has(method as BrowserTaskMethod);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asObject(value: unknown, label: string, fail: TaskProjectionFailure): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail(`Gateway returned an invalid ${label}`);
  }
  return value as JsonObject;
}

function taskBelongsToAccess(access: BrowserTaskAccess, payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const task = payload as JsonObject;
  const agentId = optionalString(task.agentId);
  const ownershipKeys = [task.sessionKey, task.childSessionKey, task.ownerKey]
    .map(optionalString)
    .filter((value) => value !== undefined);
  if (agentId && agentId !== access.agentId) {
    return false;
  }
  if (
    ownershipKeys.some(
      (sessionKey) => access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId,
    )
  ) {
    return false;
  }
  return agentId === access.agentId || ownershipKeys.length > 0;
}

export async function preflightBrowserTaskMutation(params: {
  method: string;
  request: JsonObject;
  loadTask: (taskId: string) => Promise<unknown>;
  assertOwnedResult: (taskId: string, result: unknown) => void;
}): Promise<void> {
  const assertOwnedTask = async (taskId: string) => {
    params.assertOwnedResult(taskId, await params.loadTask(taskId));
  };
  if (params.method === "tasks.cancel") {
    const taskId = optionalString(params.request.taskId);
    if (!taskId) {
      throw new BrowserGatewayProxyError("invalid-params", "task operation requires a task id");
    }
    await assertOwnedTask(taskId);
    return;
  }
  if (params.method !== "tasks.retry" && params.method !== "tasks.dismiss") {
    return;
  }
  const taskIds = params.request.taskIds;
  if (
    !Array.isArray(taskIds) ||
    taskIds.length < 1 ||
    taskIds.length > 10 ||
    taskIds.some((taskId) => !optionalString(taskId)) ||
    new Set(taskIds).size !== taskIds.length
  ) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "task recovery requires between 1 and 10 task ids",
    );
  }
  await Promise.all(taskIds.map((taskId) => assertOwnedTask(taskId as string)));
}

export function projectBrowserTaskResult(params: {
  access: BrowserTaskAccess;
  method: BrowserTaskMethod;
  requestedTaskIds?: ReadonlySet<string>;
  result: unknown;
  fail: TaskProjectionFailure;
}): JsonObject {
  const payload = asObject(params.result, `${params.method} result`, params.fail);
  if (params.method === "tasks.list") {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : null;
    if (!tasks) {
      return params.fail("Gateway returned an invalid tasks.list result");
    }
    // Upstream scopes the query by executing agent, while requester/owner keys can
    // legitimately name cron, system, or cross-agent sessions. Keep the upstream
    // cursor, but project only rows whose complete ownership metadata is browser-safe.
    return {
      ...payload,
      tasks: tasks.filter((task) => taskBelongsToAccess(params.access, task)),
    };
  }
  if (params.method === "tasks.get") {
    if (!taskBelongsToAccess(params.access, payload.task)) {
      return params.fail("Gateway returned a task outside the browser binding");
    }
    return payload;
  }
  if (params.method === "tasks.retry" || params.method === "tasks.dismiss") {
    const results = Array.isArray(payload.results) ? payload.results : null;
    if (!results || !params.requestedTaskIds || results.length !== params.requestedTaskIds.size) {
      return params.fail(`Gateway returned an invalid ${params.method} result`);
    }
    const seen = new Set<string>();
    for (const entryValue of results) {
      const entry = asObject(entryValue, `${params.method} item`, params.fail);
      const taskId = optionalString(entry.taskId);
      if (!taskId || !params.requestedTaskIds.has(taskId) || seen.has(taskId)) {
        return params.fail(`Gateway returned an invalid ${params.method} task id`);
      }
      seen.add(taskId);
      if (entry.task !== undefined && !taskBelongsToAccess(params.access, entry.task)) {
        return params.fail("Gateway returned a task outside the browser binding");
      }
    }
    return payload;
  }
  if (payload.task !== undefined && !taskBelongsToAccess(params.access, payload.task)) {
    return params.fail("Gateway returned a task outside the browser binding");
  }
  return payload;
}

export function browserTaskEventBelongsToAccess(
  access: BrowserTaskAccess,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const event = payload as JsonObject;
  // Delete/restore events do not carry ownership, so the shared Gateway cannot safely relay them.
  return event.action === "upserted" && taskBelongsToAccess(access, event.task);
}
