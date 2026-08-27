type JsonObject = Record<string, unknown>;

type BrowserCronPolicyInput = {
  method: string;
  params: JsonObject;
  agentId: string;
  ownerSessionKey: string;
  ownerAccountId: string;
  assertOptionalAgentId: (value: unknown) => void;
  assertOwnedSessionKey: (value: unknown, label: string) => void;
  deny: (message: string) => never;
};

const BROWSER_CRON_METHODS = new Set([
  "cron.add",
  "cron.get",
  "cron.list",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "cron.status",
  "cron.update",
]);

export function browserCronListScope(agentId: string): JsonObject {
  return {
    agentId,
    scheduleKinds: ["at", "every", "cron"],
    payloadKinds: ["agentTurn", "systemEvent"],
    sessionTargets: ["main", "isolated", "current"],
    sessionAgentId: agentId,
    ownerAgentId: agentId,
    ownerSessionAgentId: agentId,
    requireOwnerAccountId: true,
  };
}

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

function restrictSchedule(
  schedule: unknown,
  deny: (message: string) => never,
): JsonObject | undefined {
  if (schedule === undefined) {
    return undefined;
  }
  const value = asObject(schedule, "cron schedule", deny);
  if (value.kind === "at") {
    return withoutUndefined({ kind: "at", at: value.at });
  }
  if (value.kind === "every") {
    return withoutUndefined({ kind: "every", everyMs: value.everyMs, anchorMs: value.anchorMs });
  }
  if (value.kind === "cron") {
    return withoutUndefined({
      kind: "cron",
      expr: value.expr,
      tz: value.tz,
      staggerMs: value.staggerMs,
    });
  }
  return deny("browser cron schedules are limited to at, every, and cron");
}

function restrictPayload(
  payload: unknown,
  deny: (message: string) => never,
): JsonObject | undefined {
  if (payload === undefined) {
    return undefined;
  }
  const value = asObject(payload, "cron payload", deny);
  if (value.kind === "systemEvent") {
    return withoutUndefined({ kind: "systemEvent", text: value.text });
  }
  if (value.kind === "agentTurn") {
    return withoutUndefined({
      kind: "agentTurn",
      message: value.message,
      model: value.model,
      thinking: value.thinking,
      timeoutSeconds: value.timeoutSeconds,
      lightContext: value.lightContext,
    });
  }
  return deny("browser cron payloads are limited to agent turns and system events");
}

function restrictDelivery(
  delivery: unknown,
  deny: (message: string) => never,
  mode: "create" | "update",
): JsonObject | undefined {
  if (delivery === undefined || delivery === null) {
    return mode === "create" ? { mode: "none" } : undefined;
  }
  const value = asObject(delivery, "cron job delivery", deny);
  if (
    optionalString(value.to) ||
    optionalString(value.accountId) ||
    (value.threadId !== undefined && value.threadId !== null)
  ) {
    return deny("browser cron cannot select an outbound delivery target");
  }
  if (value.mode === "announce") {
    if (value.channel !== undefined && value.channel !== "last") {
      return deny("browser cron delivery is limited to the user's last conversation");
    }
    return { mode: "announce", channel: "last" };
  }
  if (value.mode === "none") {
    return { mode: "none" };
  }
  return deny("browser cron delivery is limited to the last conversation or internal execution");
}

function restrictJob(
  input: BrowserCronPolicyInput,
  rawJob: unknown,
  label: string,
  mode: "create" | "update",
): JsonObject {
  const job = asObject(rawJob, label, input.deny);
  input.assertOptionalAgentId(job.agentId);
  if (job.sessionKey !== undefined && job.sessionKey !== null) {
    input.assertOwnedSessionKey(job.sessionKey, `${label} sessionKey`);
  }
  if (
    job.sessionTarget !== undefined &&
    job.sessionTarget !== "main" &&
    job.sessionTarget !== "isolated" &&
    job.sessionTarget !== "current"
  ) {
    return input.deny("browser cron session targets are limited to main, isolated, and current");
  }
  if (mode === "create" && job.sessionTarget === "current") {
    return input.deny(
      "browser cron creation is limited to main and isolated; current jobs are created from an owned conversation",
    );
  }
  const delivery = restrictDelivery(job.delivery, input.deny, mode);
  if (
    mode === "create" &&
    delivery?.mode === "announce" &&
    job.sessionTarget !== "isolated" &&
    job.sessionTarget !== "current"
  ) {
    return input.deny("browser cron delivery requires current or isolated Agent execution");
  }
  if (job.failureAlert && typeof job.failureAlert === "object") {
    return input.deny("browser cron cannot configure outbound failure alerts");
  }

  return withoutUndefined({
    name: job.name,
    description: job.description,
    agentId: input.agentId,
    // Personal Web and Knox DM turns share this main session. Pin every patch so
    // omitting delivery cannot retain announce while rebinding its `last` route.
    sessionKey: input.ownerSessionKey,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    schedule: restrictSchedule(job.schedule, input.deny),
    payload: restrictPayload(job.payload, input.deny),
    delivery,
    failureAlert: mode === "create" ? false : undefined,
    owner:
      mode === "create"
        ? {
            agentId: input.agentId,
            sessionKey: input.ownerSessionKey,
            accountId: input.ownerAccountId,
          }
        : undefined,
  });
}

export function prepareBrowserCronRequest(input: BrowserCronPolicyInput): JsonObject | undefined {
  if (!BROWSER_CRON_METHODS.has(input.method)) {
    return undefined;
  }
  if (input.method === "cron.status") {
    return {};
  }
  if (input.method === "cron.list" || input.method === "cron.runs") {
    input.assertOptionalAgentId(input.params.agentId);
    if (input.method === "cron.list" && input.params.compact !== undefined) {
      return input.deny("compact cron listings are not available to browser users");
    }
    if (
      input.method === "cron.list" &&
      input.params.includeDeliveryPreviews !== undefined &&
      input.params.includeDeliveryPreviews !== false
    ) {
      return input.deny("cron delivery previews are not available to browser users");
    }
    return input.method === "cron.list"
      ? {
          ...input.params,
          includeDeliveryPreviews: false,
          ...browserCronListScope(input.agentId),
        }
      : { ...input.params, agentId: input.agentId };
  }
  if (input.method === "cron.add") {
    return restrictJob(input, input.params, "cron job", "create");
  }
  if (input.method === "cron.update") {
    return {
      ...input.params,
      patch: restrictJob(input, input.params.patch, "cron patch", "update"),
    };
  }
  return input.params;
}

function browserCronJobIsSafe(
  value: unknown,
  agentId: string,
  sessionKeyBelongsToAgent: (sessionKey: string) => boolean,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const job = value as JsonObject;
  if (job.agentId !== agentId) {
    return false;
  }
  const schedule = job.schedule as JsonObject | undefined;
  const payload = job.payload as JsonObject | undefined;
  const sessionKey = optionalString(job.sessionKey);
  const owner = job.owner as JsonObject | undefined;
  const ownerSessionKey = optionalString(owner?.sessionKey);
  return (
    (!sessionKey || sessionKeyBelongsToAgent(sessionKey)) &&
    owner?.agentId === agentId &&
    Boolean(optionalString(owner?.accountId)) &&
    Boolean(ownerSessionKey && sessionKeyBelongsToAgent(ownerSessionKey)) &&
    (job.sessionTarget !== "current" ||
      Boolean(sessionKey && ownerSessionKey && sessionKey === ownerSessionKey)) &&
    (job.sessionTarget === "main" ||
      job.sessionTarget === "isolated" ||
      job.sessionTarget === "current") &&
    (schedule?.kind === "at" || schedule?.kind === "every" || schedule?.kind === "cron") &&
    (payload?.kind === "agentTurn" || payload?.kind === "systemEvent")
  );
}

const BROWSER_CRON_EVENT_ACTIONS = new Set([
  "added",
  "updated",
  "removed",
  "started",
  "finished",
  "scheduled",
]);

/** Projects a global Gateway cron event only after its persisted owner envelope is verified. */
export function projectBrowserCronEvent(params: {
  payload: unknown;
  agentId: string;
  sessionKeyBelongsToAgent: (sessionKey: string) => boolean;
}): JsonObject | null {
  if (!params.payload || typeof params.payload !== "object" || Array.isArray(params.payload)) {
    return null;
  }
  const payload = params.payload as JsonObject;
  const job = payload.job;
  const jobId = optionalString(payload.jobId);
  const action = optionalString(payload.action);
  if (
    !jobId ||
    !action ||
    !BROWSER_CRON_EVENT_ACTIONS.has(action) ||
    !browserCronJobIsSafe(job, params.agentId, params.sessionKeyBelongsToAgent) ||
    optionalString((job as JsonObject).id) !== jobId
  ) {
    return null;
  }
  // UI only needs invalidation. Raw summaries, diagnostics, and delivery traces
  // can describe an older privileged definition and must not cross this boundary.
  return { action, jobId };
}

export function assertBrowserCronJobResult(params: {
  result: unknown;
  agentId: string;
  label: string;
  sessionKeyBelongsToAgent: (sessionKey: string) => boolean;
  deny: (message: string) => never;
}): JsonObject {
  const result = asObject(params.result, params.label, params.deny);
  if (!browserCronJobIsSafe(result, params.agentId, params.sessionKeyBelongsToAgent)) {
    return params.deny("Gateway returned a privileged or cross-Agent cron job");
  }
  return result;
}

export function projectBrowserCronResult(params: {
  method: string;
  result: unknown;
  agentId: string;
  sessionKeyBelongsToAgent: (sessionKey: string) => boolean;
  deny: (message: string) => never;
}): unknown {
  if (params.method === "cron.list") {
    const page = asObject(params.result, "cron.list result", params.deny);
    const jobs = Array.isArray(page.jobs) ? page.jobs : null;
    if (!jobs) {
      return params.deny("Gateway returned an invalid cron job list");
    }
    if (
      jobs.some(
        (job) => !browserCronJobIsSafe(job, params.agentId, params.sessionKeyBelongsToAgent),
      )
    ) {
      return params.deny("Gateway returned a privileged or cross-Agent cron job page");
    }
    return page;
  }
  if (params.method === "cron.get" || params.method === "cron.update") {
    return assertBrowserCronJobResult({
      result: params.result,
      agentId: params.agentId,
      label: `${params.method} result`,
      sessionKeyBelongsToAgent: params.sessionKeyBelongsToAgent,
      deny: params.deny,
    });
  }
  if (params.method === "cron.add") {
    const container = asObject(params.result, "cron.add result", params.deny);
    const job = container.job ?? container;
    assertBrowserCronJobResult({
      result: job,
      agentId: params.agentId,
      label: "cron.add job",
      sessionKeyBelongsToAgent: params.sessionKeyBelongsToAgent,
      deny: params.deny,
    });
    return params.result;
  }
  return params.result;
}
