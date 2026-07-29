import { randomUUID } from "node:crypto";
import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  projectBrowserCommands,
  resolveBrowserCommandSuppression,
} from "./browser-command-policy.js";
import {
  assertBrowserCronJobResult,
  browserCronListScope,
  prepareBrowserCronRequest,
  projectBrowserCronResult,
} from "./browser-gateway-cron-policy.js";
import {
  browserEventPayloadBelongsToAccess,
  browserPayloadBelongsToAccess,
} from "./browser-gateway-ownership.js";
import {
  PLATFORMCLAW_WEB_ADMIN_METHODS,
  PLATFORMCLAW_WEB_AGENT_ONLY_METHODS,
  PLATFORMCLAW_WEB_ALLOWED_METHODS,
  PLATFORMCLAW_WEB_ALLOWED_PARAMS,
  PLATFORMCLAW_WEB_SESSION_KEY_METHODS,
} from "./browser-gateway-policy.js";
import {
  projectBrowserAgentSummary,
  projectBrowserModelChoice,
} from "./browser-gateway-projections.js";
export {
  PLATFORMCLAW_WEB_GATEWAY_METHODS,
  type PlatformClawWebGatewayMethod,
} from "./browser-gateway-policy.js";
import {
  prepareBrowserSelfServiceRequest,
  resolveBrowserSkillExecutionTarget,
} from "./browser-gateway-self-service-policy.js";
import {
  isConfiguredBrowserModel,
  projectBrowserAgentFiles,
  projectBrowserSelfUser,
  projectBrowserSkillResult,
} from "./browser-gateway-self-service-projections.js";
import {
  browserTaskEventBelongsToAccess,
  projectBrowserTaskResult,
} from "./browser-gateway-task-policy.js";
import type {
  ControlPlaneAuditWriter,
  ControlPlaneStore,
  PersonalAgentBinding,
  PlatformUser,
} from "./contracts.js";

export const PLATFORMCLAW_WEB_GATEWAY_EVENTS = [
  "shutdown",
  "tick",
  "chat",
  "chat.send_timing",
  "chat.side_result",
  "session.message",
  "session.operation",
  "session.tool",
  "sessions.changed",
  "task",
] as const;

const SAFE_GLOBAL_EVENTS = new Set<string>(["shutdown", "tick"]);
const SESSION_SCOPED_EVENTS = new Set<string>(
  PLATFORMCLAW_WEB_GATEWAY_EVENTS.filter((event) => event !== "shutdown" && event !== "tick"),
);
type JsonObject = Record<string, unknown>;

export type BrowserGatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: Record<string, number>;
};

export type BrowserGatewayRpc = {
  request(method: string, params?: unknown): Promise<unknown>;
};

export type BrowserGatewayAccess = {
  user: PlatformUser;
  binding: PersonalAgentBinding;
  mainSessionKey: string;
};

export type BrowserGatewayProxyErrorCode =
  | "unauthenticated"
  | "agent-unavailable"
  | "method-not-allowed"
  | "invalid-params"
  | "cross-agent-denied"
  | "upstream-result-denied";

export class BrowserGatewayProxyError extends Error {
  constructor(
    readonly code: BrowserGatewayProxyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserGatewayProxyError";
  }
}

export type BrowserGatewayProxyOptions = {
  authService: BrowserAuthService;
  store: ControlPlaneStore;
  auditWriter: ControlPlaneAuditWriter;
  gateway: BrowserGatewayRpc;
  buildAgentMainSessionKey(params: { agentId: string }): string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
  now?: () => number;
};

function asObject(value: unknown, label: string): JsonObject {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserGatewayProxyError("invalid-params", `${label} must be an object`);
  }
  return { ...(value as JsonObject) };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function browserPageInteger(
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
    throw new BrowserGatewayProxyError("invalid-params", `${label} must be an integer ${range}`);
  }
  return resolved;
}

/** Enforces the browser-session-to-agent boundary before using operator Gateway RPC. */
export class BrowserGatewayProxy {
  constructor(private readonly options: BrowserGatewayProxyOptions) {}

  async resolveAccess(token: string, touch = true): Promise<BrowserGatewayAccess> {
    const auth = await this.options.authService.authenticateToken(token, touch);
    if (auth.status !== "active") {
      throw new BrowserGatewayProxyError("unauthenticated", "active browser session required");
    }
    const binding = await this.options.store.getPersonalAgentBinding(auth.user.id);
    if (!binding || binding.state !== "active") {
      throw new BrowserGatewayProxyError(
        "agent-unavailable",
        "active personal agent binding required",
      );
    }
    return {
      user: auth.user,
      binding,
      mainSessionKey: this.options.buildAgentMainSessionKey({ agentId: binding.agentId }),
    };
  }

  async request<T = unknown>(token: string, method: string, params?: unknown): Promise<T> {
    const access = await this.resolveAccess(token);
    let executionTarget: "platform_server" | "assigned_vm" | undefined;
    let prepared: JsonObject;
    let initialCommandSuppressed = true;
    try {
      executionTarget = await resolveBrowserSkillExecutionTarget({
        method,
        load: () => this.options.store.getPersonalExecutionProfile(access.binding.agentId),
        deny: (message) => {
          throw new BrowserGatewayProxyError("method-not-allowed", message);
        },
      });
      prepared = this.prepareRequest(access, method, params);
      if (method === "chat.send" || method === "sessions.create") {
        initialCommandSuppressed = await this.resolveCommandSuppression(access, prepared.message);
        if (method === "chat.send") {
          prepared = { ...prepared, suppressCommandInterpretation: initialCommandSuppressed };
        }
      }
      if (
        method === "sessions.patch" &&
        typeof prepared.model === "string" &&
        !(await isConfiguredBrowserModel(this.options.gateway, prepared.model))
      ) {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "browser model selection is limited to configured models",
        );
      }
      if (method === "tasks.cancel") {
        await this.assertOwnedTask(access, prepared.taskId);
      }
      if (
        method === "cron.get" ||
        method === "cron.update" ||
        method === "cron.remove" ||
        method === "cron.run"
      ) {
        const job = await this.assertOwnedCronJob(access, prepared);
        if (method === "cron.update" || method === "cron.remove" || method === "cron.run") {
          const expectedConfigRevision = optionalString(prepared.expectedConfigRevision);
          if (!expectedConfigRevision) {
            throw new BrowserGatewayProxyError(
              "invalid-params",
              "cron mutation requires the loaded job config revision",
            );
          }
          if (optionalString(job.configRevision) !== expectedConfigRevision) {
            throw new BrowserGatewayProxyError(
              "invalid-params",
              "cron job changed after it was loaded; refresh before retrying",
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof BrowserGatewayProxyError) {
        await this.auditDeniedRequest(access, method, error.code);
      }
      throw error;
    }
    if (method === "sessions.create") {
      try {
        return (await this.createBrowserSession(access, prepared, initialCommandSuppressed)) as T;
      } catch (error) {
        if (error instanceof BrowserGatewayProxyError) {
          await this.auditDeniedRequest(access, method, error.code);
        }
        throw error;
      }
    }
    if (method === "users.self") {
      return projectBrowserSelfUser(access.user) as T;
    }
    if (method === "cron.list") {
      return (await this.requestBrowserCronList(access, prepared)) as T;
    }
    if (method === "cron.status") {
      return (await this.requestBrowserCronStatus(access)) as T;
    }
    if (method === "cron.runs") {
      const offset = browserPageInteger(prepared.offset, 0, "cron.runs offset", { minimum: 0 });
      const limit = browserPageInteger(prepared.limit, 50, "cron.runs limit", {
        minimum: 1,
        maximum: 200,
      });
      return { entries: [], total: 0, limit, offset, nextOffset: null, hasMore: false } as T;
    }
    // Keep commands.list on filtered metadata so browser visibility and execution cannot drift.
    const upstreamMethod = method === "commands.list" ? "chat.metadata" : method;
    const upstreamParams = method === "commands.list" ? { agentId: prepared.agentId } : prepared;
    const result = await this.options.gateway.request(upstreamMethod, upstreamParams);
    try {
      return this.filterResult(access, method, prepared, result, executionTarget) as T;
    } catch (error) {
      if (error instanceof BrowserGatewayProxyError) {
        await this.auditDeniedRequest(access, method, error.code);
      }
      throw error;
    }
  }

  private async createBrowserSession(
    access: BrowserGatewayAccess,
    prepared: JsonObject,
    suppressCommandInterpretation: boolean,
  ): Promise<unknown> {
    const message =
      typeof prepared.message === "string" && prepared.message.trim()
        ? prepared.message
        : undefined;
    const createParams = { ...prepared };
    delete createParams.message;
    if (message && createParams.key === undefined && createParams.catalogId === undefined) {
      // Mint the dashboard key here because the separately relayed turn would reset main otherwise.
      createParams.key = `agent:${access.binding.agentId}:dashboard:${randomUUID()}`;
    }
    const rawCreated = await this.options.gateway.request("sessions.create", createParams);
    const created = asObject(
      this.filterResult(access, "sessions.create", createParams, rawCreated),
      "sessions.create result",
    );
    if (!message || created.ok === false) {
      return created;
    }
    const key = optionalString(created.key);
    if (!key) {
      throw new BrowserGatewayProxyError(
        "upstream-result-denied",
        "Gateway returned an invalid browser-created session",
      );
    }
    try {
      const sendParams = this.prepareRequest(access, "chat.send", {
        sessionKey: key,
        message,
        idempotencyKey: randomUUID(),
      });
      sendParams.suppressCommandInterpretation = suppressCommandInterpretation;
      const run = asObject(
        await this.options.gateway.request("chat.send", sendParams),
        "chat.send result",
      );
      return { ...created, runStarted: run.status === "started" };
    } catch (error) {
      return {
        ...created,
        runStarted: false,
        runError: {
          message:
            error instanceof Error && error.message.trim()
              ? error.message
              : "The session was created, but its first message could not be sent.",
        },
      };
    }
  }

  private async resolveCommandSuppression(
    access: BrowserGatewayAccess,
    message: unknown,
  ): Promise<boolean> {
    const policy = await resolveBrowserCommandSuppression({
      gateway: this.options.gateway,
      agentId: access.binding.agentId,
      message,
    });
    if (policy === "block") {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        "Gateway administration commands are not available to browser users",
      );
    }
    return policy === "suppress";
  }

  async filterEvent(
    token: string,
    event: BrowserGatewayEvent,
  ): Promise<BrowserGatewayEvent | null> {
    let access: BrowserGatewayAccess;
    try {
      // Server-pushed traffic must not keep an unattended browser session alive.
      access = await this.resolveAccess(token, false);
    } catch {
      return null;
    }
    if (SAFE_GLOBAL_EVENTS.has(event.event)) {
      return event;
    }
    if (event.event === "task") {
      return browserTaskEventBelongsToAccess(this.browserTaskAccess(access), event.payload)
        ? event
        : null;
    }
    if (
      !SESSION_SCOPED_EVENTS.has(event.event) ||
      !this.eventPayloadBelongsToAccess(access, event.payload)
    ) {
      return null;
    }
    return event;
  }

  private prepareRequest(
    access: BrowserGatewayAccess,
    method: string,
    rawParams: unknown,
  ): JsonObject {
    if (!PLATFORMCLAW_WEB_ALLOWED_METHODS.has(method)) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        `Gateway method is not available to browser users: ${method}`,
      );
    }
    if (PLATFORMCLAW_WEB_ADMIN_METHODS.has(method) && access.user.globalRole !== "admin") {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        `Gateway administration method is not available to browser users: ${method}`,
      );
    }
    const params = { ...asObject(rawParams, `${method} params`) };
    this.assertAllowedParams(method, params);
    const selfServiceParams = prepareBrowserSelfServiceRequest({
      method,
      params,
      agentId: access.binding.agentId,
      assertOptionalAgentId: (value) => this.assertOptionalAgentId(access, value, method),
      assertOwnedSessionKey: (value, label) => this.assertOwnedSessionKey(access, value, label),
      deny: (message) => {
        throw new BrowserGatewayProxyError("method-not-allowed", message);
      },
    });
    if (selfServiceParams !== undefined) {
      return selfServiceParams;
    }
    const cronParams = prepareBrowserCronRequest({
      method,
      params,
      agentId: access.binding.agentId,
      ownerSessionKey: access.mainSessionKey,
      ownerAccountId: access.user.accountId,
      assertOptionalAgentId: (value) => this.assertOptionalAgentId(access, value, method),
      assertOwnedSessionKey: (value, label) => this.assertOwnedSessionKey(access, value, label),
      deny: (message) => {
        throw new BrowserGatewayProxyError("method-not-allowed", message);
      },
    });
    if (cronParams !== undefined) {
      return cronParams;
    }
    if (method === "sessions.list") {
      this.assertOptionalAgentId(access, params.agentId, method);
      return {
        ...params,
        agentId: access.binding.agentId,
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
      };
    }
    if (method === "sessions.search") {
      this.assertOptionalAgentId(access, params.agentId, method);
      this.assertSessionKeyArray(access, params.sessionKeys, "sessionKeys", true);
      return { ...params, agentId: access.binding.agentId };
    }
    if (method === "sessions.preview") {
      this.assertSessionKeyArray(access, params.keys, "keys", true);
      return params;
    }
    if (method === "sessions.describe") {
      this.assertOwnedSessionKey(access, params.key, "key");
      return params;
    }
    if (method === "sessions.resolve") {
      this.assertOptionalAgentId(access, params.agentId, method);
      if (params.key !== undefined) {
        this.assertOwnedSessionKey(access, params.key, "key");
      }
      return {
        ...params,
        agentId: access.binding.agentId,
        includeGlobal: false,
        includeUnknown: false,
      };
    }
    if (method === "sessions.create") {
      this.assertOptionalAgentId(access, params.agentId, method);
      if (params.key !== undefined) {
        this.assertOwnedSessionKey(access, params.key, "key");
      }
      if (params.parentSessionKey !== undefined) {
        this.assertOwnedSessionKey(access, params.parentSessionKey, "parentSessionKey");
      }
      return { ...params, agentId: access.binding.agentId, emitCommandHooks: false };
    }
    if (method === "tasks.get" || method === "tasks.cancel") {
      return params;
    }
    if (PLATFORMCLAW_WEB_AGENT_ONLY_METHODS.has(method)) {
      this.assertOptionalAgentId(access, params.agentId, method);
      if (params.sessionKey !== undefined) {
        this.assertOwnedSessionKey(access, params.sessionKey, "sessionKey");
      }
      return { ...params, agentId: access.binding.agentId };
    }
    const keyField = PLATFORMCLAW_WEB_SESSION_KEY_METHODS.get(method);
    if (keyField) {
      this.assertOptionalAgentId(access, params.agentId, method);
      this.assertOwnedSessionKey(access, params[keyField], keyField);
      if (method === "chat.send") {
        const gatewayParams = { ...params };
        delete gatewayParams["__controlUiReconnectResume"];
        return {
          ...gatewayParams,
          agentId: access.binding.agentId,
          deliver: false,
          suppressCommandInterpretation: true,
        };
      }
      // Never let a browser-selected run id cross the shared Gateway client.
      delete params.runId;
      return { ...params, agentId: access.binding.agentId };
    }
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      `Gateway method has no browser policy: ${method}`,
    );
  }

  private filterResult(
    access: BrowserGatewayAccess,
    method: string,
    prepared: JsonObject,
    result: unknown,
    executionTarget?: "platform_server" | "assigned_vm",
  ): unknown {
    if (method.startsWith("cron.")) {
      return projectBrowserCronResult({
        method,
        result,
        agentId: access.binding.agentId,
        sessionKeyBelongsToAgent: (sessionKey) =>
          this.options.resolveAgentIdFromSessionKey(sessionKey) === access.binding.agentId,
        deny: (message) => {
          throw new BrowserGatewayProxyError("upstream-result-denied", message);
        },
      });
    }
    if (method === "tasks.list" || method === "tasks.get" || method === "tasks.cancel") {
      return projectBrowserTaskResult({
        access: this.browserTaskAccess(access),
        method,
        result,
        fail: (message) => {
          throw new BrowserGatewayProxyError("upstream-result-denied", message);
        },
      });
    }
    if (method.startsWith("agents.files.")) {
      return projectBrowserAgentFiles({
        agentId: access.binding.agentId,
        method,
        result,
        fail: (message) => {
          throw new BrowserGatewayProxyError("upstream-result-denied", message);
        },
      });
    }
    if (method.startsWith("skills.")) {
      return projectBrowserSkillResult({
        agentId: access.binding.agentId,
        executionTarget: executionTarget ?? "platform_server",
        method,
        result,
        fail: (message) => {
          throw new BrowserGatewayProxyError("upstream-result-denied", message);
        },
      });
    }
    if (method === "models.list") {
      const payload = asObject(result, "models.list result");
      const models = Array.isArray(payload.models)
        ? payload.models.map(projectBrowserModelChoice).filter((entry) => entry !== null)
        : [];
      return { models };
    }
    if (method === "chat.metadata" || method === "commands.list") {
      const payload = asObject(result, `${method} result`);
      const commands = projectBrowserCommands(payload.commands);
      return method === "chat.metadata" && payload.models !== undefined
        ? { models: payload.models, commands }
        : { commands };
    }
    if (method === "agents.list") {
      const payload = asObject(result, "agents.list result");
      const agents = Array.isArray(payload.agents)
        ? payload.agents
            .map(projectBrowserAgentSummary)
            .filter((entry) => entry?.id === access.binding.agentId)
        : [];
      if (agents.length !== 1) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "owned agent missing from Gateway response",
        );
      }
      return { ...payload, defaultId: access.binding.agentId, agents };
    }
    if (method === "chat.history" || method === "chat.startup") {
      const payload = asObject(result, `${method} result`);
      if (payload.sessionKey !== undefined) {
        this.assertOwnedResultSessionKey(access, payload.sessionKey);
      }
      if (
        payload.sessionInfo !== undefined &&
        !this.payloadBelongsToAccess(access, payload.sessionInfo)
      ) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned session metadata outside the browser binding",
        );
      }
      if (method === "chat.history") {
        return payload;
      }
      const agentsList = asObject(payload.agentsList, "chat.startup agentsList");
      const agents = Array.isArray(agentsList.agents)
        ? agentsList.agents
            .map(projectBrowserAgentSummary)
            .filter((entry) => entry?.id === access.binding.agentId)
        : [];
      if (agents.length !== 1) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "owned agent missing from Gateway startup response",
        );
      }
      return {
        ...payload,
        agentsList: { ...agentsList, defaultId: access.binding.agentId, agents },
      };
    }
    if (method === "chat.message.get") {
      // Upstream resolves message IDs inside the already-pinned session transcript.
      this.assertOwnedResultSessionKey(access, prepared.sessionKey);
      const payload = asObject(result, "chat.message.get result");
      if (payload.ok === true) {
        if (payload.message === undefined) {
          throw new BrowserGatewayProxyError(
            "upstream-result-denied",
            "Gateway returned an invalid direct message result",
          );
        }
        return { ok: true, message: payload.message };
      }
      return payload.unavailableReason === undefined
        ? { ok: false }
        : { ok: false, unavailableReason: payload.unavailableReason };
    }
    if (method === "sessions.list") {
      const payload = asObject(result, "sessions.list result");
      const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      if (sessions.some((entry) => !this.payloadBelongsToAccess(access, entry))) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned a session outside the browser binding",
        );
      }
      return payload;
    }
    if (method === "sessions.search") {
      const payload = asObject(result, "sessions.search result");
      const results = Array.isArray(payload.results) ? payload.results : [];
      if (results.some((entry) => !this.payloadBelongsToAccess(access, entry))) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned a search result outside the browser binding",
        );
      }
      return payload;
    }
    if (method === "sessions.preview") {
      const payload = asObject(result, "sessions.preview result");
      const previews = Array.isArray(payload.previews) ? payload.previews : [];
      if (previews.some((entry) => !this.payloadBelongsToAccess(access, entry))) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned a preview outside the browser binding",
        );
      }
      return payload;
    }
    if (method === "sessions.create" || method === "sessions.resolve") {
      const payload = asObject(result, `${method} result`);
      if (payload.ok === false) {
        return { ok: false };
      }
      this.assertOwnedResultSessionKey(access, payload.key);
      return { ok: true, key: payload.key };
    }
    if (method === "sessions.patch") {
      const payload = asObject(result, "sessions.patch result");
      if (payload.ok !== true) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned an invalid session patch result",
        );
      }
      this.assertOwnedResultSessionKey(access, prepared.key);
      return { ok: true, key: prepared.key };
    }
    if (method === "sessions.describe") {
      const payload = asObject(result, "sessions.describe result");
      if (payload.session !== null && !this.payloadBelongsToAccess(access, payload.session)) {
        throw new BrowserGatewayProxyError(
          "upstream-result-denied",
          "Gateway returned a session outside the browser binding",
        );
      }
      return payload;
    }
    return result;
  }

  private async assertOwnedTask(access: BrowserGatewayAccess, rawTaskId: unknown): Promise<void> {
    const taskId = optionalString(rawTaskId);
    if (!taskId) {
      throw new BrowserGatewayProxyError("invalid-params", "tasks.cancel requires a task id");
    }
    const result = await this.options.gateway.request("tasks.get", { taskId });
    this.filterResult(access, "tasks.get", { taskId }, result);
  }

  private async requestBrowserCronList(
    access: BrowserGatewayAccess,
    params: JsonObject,
  ): Promise<JsonObject> {
    const result = await this.options.gateway.request("cron.list", {
      ...params,
      ...browserCronListScope(access.binding.agentId),
    });
    return projectBrowserCronResult({
      method: "cron.list",
      result,
      agentId: access.binding.agentId,
      sessionKeyBelongsToAgent: (sessionKey) =>
        this.options.resolveAgentIdFromSessionKey(sessionKey) === access.binding.agentId,
      deny: (message) => {
        throw new BrowserGatewayProxyError("upstream-result-denied", message);
      },
    }) as JsonObject;
  }

  private async requestBrowserCronStatus(access: BrowserGatewayAccess): Promise<JsonObject> {
    const [rawStatus, allPage, nextPage] = await Promise.all([
      this.options.gateway.request("cron.status", {}),
      this.requestBrowserCronList(access, { includeDisabled: true, limit: 1, offset: 0 }),
      this.requestBrowserCronList(access, {
        enabled: "enabled",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
        limit: 1,
        offset: 0,
      }),
    ]);
    const status = asObject(rawStatus, "cron.status result");
    const nextJobs = Array.isArray(nextPage.jobs) ? (nextPage.jobs as JsonObject[]) : [];
    const nextRunAtMs = (nextJobs[0]?.state as JsonObject | undefined)?.nextRunAtMs;
    return {
      enabled: status.enabled === true,
      jobs: typeof allPage.total === "number" ? allPage.total : 0,
      nextWakeAtMs: typeof nextRunAtMs === "number" ? nextRunAtMs : null,
    };
  }

  private async assertOwnedCronJob(
    access: BrowserGatewayAccess,
    params: JsonObject,
  ): Promise<JsonObject> {
    const jobId = optionalString(params.id) ?? optionalString(params.jobId);
    if (!jobId) {
      throw new BrowserGatewayProxyError("invalid-params", "cron job id is required");
    }
    const result = await this.options.gateway.request("cron.get", { id: jobId });
    return assertBrowserCronJobResult({
      result,
      agentId: access.binding.agentId,
      label: "cron.get result",
      sessionKeyBelongsToAgent: (sessionKey) =>
        this.options.resolveAgentIdFromSessionKey(sessionKey) === access.binding.agentId,
      deny: (message) => {
        throw new BrowserGatewayProxyError("cross-agent-denied", message);
      },
    });
  }

  private browserTaskAccess(access: BrowserGatewayAccess) {
    return {
      agentId: access.binding.agentId,
      resolveAgentIdFromSessionKey: (sessionKey: string) =>
        this.options.resolveAgentIdFromSessionKey(sessionKey),
    };
  }

  private payloadBelongsToAccess(access: BrowserGatewayAccess, payload: unknown): boolean {
    return browserPayloadBelongsToAccess(this.browserTaskAccess(access), payload);
  }

  private eventPayloadBelongsToAccess(access: BrowserGatewayAccess, payload: unknown): boolean {
    return browserEventPayloadBelongsToAccess(this.browserTaskAccess(access), payload);
  }

  private assertOptionalAgentId(
    access: BrowserGatewayAccess,
    rawAgentId: unknown,
    label: string,
  ): void {
    const agentId = optionalString(rawAgentId);
    if (agentId && agentId !== access.binding.agentId) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        `browser access denied for ${label}`,
      );
    }
  }

  private assertOwnedSessionKey(
    access: BrowserGatewayAccess,
    rawSessionKey: unknown,
    label: string,
  ): void {
    const sessionKey = optionalString(rawSessionKey);
    if (!sessionKey) {
      throw new BrowserGatewayProxyError("invalid-params", `${label} is required`);
    }
    if (this.options.resolveAgentIdFromSessionKey(sessionKey) !== access.binding.agentId) {
      throw new BrowserGatewayProxyError(
        "cross-agent-denied",
        `browser access denied for ${label}`,
      );
    }
  }

  private assertSessionKeyArray(
    access: BrowserGatewayAccess,
    value: unknown,
    label: string,
    required: boolean,
  ): void {
    if (value === undefined && !required) {
      return;
    }
    if (!Array.isArray(value) || (required && value.length === 0)) {
      throw new BrowserGatewayProxyError("invalid-params", `${label} must be a non-empty array`);
    }
    for (const sessionKey of value) {
      this.assertOwnedSessionKey(access, sessionKey, label);
    }
  }

  private assertOwnedResultSessionKey(access: BrowserGatewayAccess, rawSessionKey: unknown): void {
    const sessionKey = optionalString(rawSessionKey);
    if (
      !sessionKey ||
      this.options.resolveAgentIdFromSessionKey(sessionKey) !== access.binding.agentId
    ) {
      throw new BrowserGatewayProxyError(
        "upstream-result-denied",
        "Gateway returned a session outside the browser binding",
      );
    }
  }

  private assertAllowedParams(method: string, params: JsonObject): void {
    const allowed = PLATFORMCLAW_WEB_ALLOWED_PARAMS.get(method);
    if (!allowed) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        `Gateway method has no browser parameter policy: ${method}`,
      );
    }
    const disallowed = Object.keys(params).find((key) => !allowed.has(key));
    if (disallowed) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        `Gateway parameter is not available to browser users: ${method}.${disallowed}`,
      );
    }
  }

  private async auditDeniedRequest(
    access: BrowserGatewayAccess,
    method: string,
    reason: BrowserGatewayProxyErrorCode,
  ): Promise<void> {
    await this.options.auditWriter.recordAuditEvent({
      actorUserId: access.user.id,
      eventType: "browser.gateway.denied",
      targetType: "agent-binding",
      targetId: access.binding.id,
      details: { method, reason },
      createdAt: (this.options.now ?? Date.now)(),
    });
  }
}
