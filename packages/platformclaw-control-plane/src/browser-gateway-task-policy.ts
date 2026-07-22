type JsonObject = Record<string, unknown>;

type TaskProjectionFailure = (message: string) => never;

type BrowserTaskAccess = {
  agentId: string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
};

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

export function projectBrowserTaskResult(params: {
  access: BrowserTaskAccess;
  method: "tasks.cancel" | "tasks.get" | "tasks.list";
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
