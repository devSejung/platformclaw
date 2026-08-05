import { randomUUID } from "node:crypto";
import {
  projectBrowserCommands,
  resolveBrowserCommandSuppression,
} from "./browser-command-policy.js";
import { resolveBrowserGatewayAccess } from "./browser-gateway-access.js";
import { BrowserGatewayAssertions } from "./browser-gateway-assertions.js";
import {
  BrowserGatewayProxyError,
  type BrowserGatewayAccess,
  type BrowserGatewayEvent,
  type BrowserGatewayProxyErrorCode,
  type BrowserGatewayProxyOptions,
  type BrowserGatewayRequestContext,
} from "./browser-gateway-contracts.js";
export * from "./browser-gateway-contracts.js";
import {
  preflightCronMutation,
  prepareCronRequest,
  projectCronResult,
  requestSpecialCronResult,
} from "./browser-gateway-cron-controller.js";
import { BrowserGatewayObserverVisibility } from "./browser-gateway-observer-visibility.js";
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
import { projectBrowserSessionResult } from "./browser-gateway-session-projections.js";
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
export const PLATFORMCLAW_WEB_GATEWAY_EVENTS = [
  "shutdown",
  "tick",
  "chat",
  "chat.send_timing",
  "chat.side_result",
  "session.message",
  "session.observer",
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

/** Enforces the browser-session-to-agent boundary before using operator Gateway RPC. */
export class BrowserGatewayProxy {
  private readonly assertions: BrowserGatewayAssertions;
  private readonly observerVisibility: BrowserGatewayObserverVisibility;

  constructor(private readonly options: BrowserGatewayProxyOptions) {
    this.assertions = new BrowserGatewayAssertions(
      (sessionKey) => this.options.resolveAgentIdFromSessionKey(sessionKey),
      PLATFORMCLAW_WEB_ALLOWED_PARAMS,
      (code, message): never => {
        throw new BrowserGatewayProxyError(code, message);
      },
    );
    this.observerVisibility = new BrowserGatewayObserverVisibility(
      options.gateway,
      () =>
        new BrowserGatewayProxyError(
          "invalid-params",
          "session observer visibility connection is no longer active",
        ),
    );
  }

  async resolveAccess(token: string, touch = true): Promise<BrowserGatewayAccess> {
    return await resolveBrowserGatewayAccess({
      token,
      touch,
      authService: this.options.authService,
      store: this.options.store,
      buildAgentMainSessionKey: (params) => this.options.buildAgentMainSessionKey(params),
      fail: (code, message): never => {
        throw new BrowserGatewayProxyError(code, message);
      },
    });
  }

  async request<T = unknown>(
    token: string,
    method: string,
    params?: unknown,
    context?: BrowserGatewayRequestContext,
  ): Promise<T> {
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
      if (method === "sessions.observer.visibility") {
        if (!context?.connectionId) {
          throw new BrowserGatewayProxyError(
            "invalid-params",
            "session observer visibility requires a browser connection",
          );
        }
        return (await this.observerVisibility.setConnectionVisibility(
          context.connectionId,
          prepared.visible === true,
        )) as T;
      }
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
      await preflightCronMutation(this.browserCronContext(access), method, prepared);
    } catch (error) {
      if (error instanceof BrowserGatewayProxyError) {
        await this.auditDeniedRequest(access, method, error.code);
        throw new BrowserGatewayProxyError(error.code, error.message, "rejected-before-dispatch");
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
    if (method === "sessions.subscribe") {
      // The process-wide private Gateway client owns this connection-scoped subscription.
      return { subscribed: true } as T;
    }
    const specialCronResult = await requestSpecialCronResult(
      this.browserCronContext(access),
      method,
      prepared,
    );
    if (specialCronResult.handled) {
      return specialCronResult.result as T;
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
    const attachments = prepared.attachments;
    if (attachments !== undefined && !Array.isArray(attachments)) {
      throw new BrowserGatewayProxyError(
        "invalid-params",
        "sessions.create attachments must be an array",
      );
    }
    const createParams = { ...prepared };
    delete createParams.message;
    delete createParams.attachments;
    const hasInitialTurn = Boolean(message || attachments?.length);
    if (hasInitialTurn && createParams.key === undefined && createParams.catalogId === undefined) {
      // Mint the dashboard key here because the separately relayed turn would reset main otherwise.
      createParams.key = `agent:${access.binding.agentId}:dashboard:${randomUUID()}`;
    }
    const rawCreated = await this.options.gateway.request("sessions.create", createParams);
    const created = asObject(
      this.filterResult(access, "sessions.create", createParams, rawCreated),
      "sessions.create result",
    );
    if (!hasInitialTurn || created.ok === false) {
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
        message: message ?? "",
        ...(attachments?.length ? { attachments } : {}),
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

  registerBrowserConnection(connectionId: string): void {
    this.observerVisibility.registerConnection(connectionId);
  }

  handleGatewayDisconnect(): void {
    this.observerVisibility.handleGatewayDisconnect();
  }

  async releaseBrowserConnection(connectionId: string): Promise<void> {
    await this.observerVisibility.releaseConnection(connectionId);
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
    this.assertions.methodParams(method, params);
    const selfServiceParams = prepareBrowserSelfServiceRequest({
      method,
      params,
      agentId: access.binding.agentId,
      assertOptionalAgentId: (value) =>
        this.assertions.optionalAgentId(access.binding.agentId, value, method),
      assertOwnedSessionKey: (value, label) =>
        this.assertions.ownedSessionKey(access.binding.agentId, value, label),
      deny: (message) => {
        throw new BrowserGatewayProxyError("method-not-allowed", message);
      },
    });
    if (selfServiceParams !== undefined) {
      return selfServiceParams;
    }
    const cronParams = prepareCronRequest(this.browserCronContext(access), method, params);
    if (cronParams !== undefined) {
      return cronParams;
    }
    if (method === "sessions.list") {
      this.assertions.optionalAgentId(access.binding.agentId, params.agentId, method);
      return {
        ...params,
        agentId: access.binding.agentId,
        includeGlobal: false,
        includeUnknown: false,
        configuredAgentsOnly: true,
      };
    }
    if (method === "sessions.search") {
      this.assertions.optionalAgentId(access.binding.agentId, params.agentId, method);
      this.assertions.sessionKeyArray(
        access.binding.agentId,
        params.sessionKeys,
        "sessionKeys",
        true,
      );
      return { ...params, agentId: access.binding.agentId };
    }
    if (method === "sessions.preview") {
      this.assertions.sessionKeyArray(access.binding.agentId, params.keys, "keys", true);
      return params;
    }
    if (method === "sessions.describe") {
      this.assertions.ownedSessionKey(access.binding.agentId, params.key, "key");
      return params;
    }
    if (method === "sessions.resolve") {
      this.assertions.optionalAgentId(access.binding.agentId, params.agentId, method);
      if (params.key !== undefined) {
        this.assertions.ownedSessionKey(access.binding.agentId, params.key, "key");
      }
      return {
        ...params,
        agentId: access.binding.agentId,
        includeGlobal: false,
        includeUnknown: false,
      };
    }
    if (method === "sessions.create") {
      this.assertions.optionalAgentId(access.binding.agentId, params.agentId, method);
      if (params.key !== undefined) {
        this.assertions.ownedSessionKey(access.binding.agentId, params.key, "key");
      }
      if (params.parentSessionKey !== undefined) {
        this.assertions.ownedSessionKey(
          access.binding.agentId,
          params.parentSessionKey,
          "parentSessionKey",
        );
      }
      return { ...params, agentId: access.binding.agentId, emitCommandHooks: false };
    }
    if (method.startsWith("sessions.companion.")) {
      this.assertions.ownedSessionKey(access.binding.agentId, params.sessionKey, "sessionKey");
      return params;
    }
    if (method === "sessions.observer.visibility") {
      if (typeof params.visible !== "boolean") {
        throw new BrowserGatewayProxyError("invalid-params", "visible must be a boolean");
      }
      return params;
    }
    if (method === "sessions.subscribe") {
      return params;
    }
    if (method === "tasks.get" || method === "tasks.cancel") {
      return params;
    }
    if (PLATFORMCLAW_WEB_AGENT_ONLY_METHODS.has(method)) {
      this.assertions.optionalAgentId(access.binding.agentId, params.agentId, method);
      if (params.sessionKey !== undefined) {
        this.assertions.ownedSessionKey(access.binding.agentId, params.sessionKey, "sessionKey");
      }
      return { ...params, agentId: access.binding.agentId };
    }
    const keyField = PLATFORMCLAW_WEB_SESSION_KEY_METHODS.get(method);
    if (keyField) {
      this.assertions.optionalAgentId(access.binding.agentId, params.agentId, method);
      this.assertions.ownedSessionKey(access.binding.agentId, params[keyField], keyField);
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
      return projectCronResult(this.browserCronContext(access), method, result);
    }
    const sessionResult = projectBrowserSessionResult({
      method,
      prepared,
      result,
      assertOwnedResultSessionKey: (value) =>
        this.assertions.ownedResultSessionKey(access.binding.agentId, value),
      payloadBelongsToAccess: (value) => this.payloadBelongsToAccess(access, value),
      fail: (message) => {
        throw new BrowserGatewayProxyError("upstream-result-denied", message);
      },
    });
    if (sessionResult !== undefined) {
      return sessionResult;
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
        this.assertions.ownedResultSessionKey(access.binding.agentId, payload.sessionKey);
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
      this.assertions.ownedResultSessionKey(access.binding.agentId, prepared.sessionKey);
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
      this.assertions.ownedResultSessionKey(access.binding.agentId, payload.key);
      return { ok: true, key: payload.key };
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

  private browserCronContext(access: BrowserGatewayAccess) {
    return {
      agentId: access.binding.agentId,
      mainSessionKey: access.mainSessionKey,
      accountId: access.user.accountId,
      gateway: this.options.gateway,
      resolveAgentIdFromSessionKey: (sessionKey: string) =>
        this.options.resolveAgentIdFromSessionKey(sessionKey),
      assertOptionalAgentId: (value: unknown, label: string) =>
        this.assertions.optionalAgentId(access.binding.agentId, value, label),
      assertOwnedSessionKey: (value: unknown, label: string) =>
        this.assertions.ownedSessionKey(access.binding.agentId, value, label),
      fail: (code: BrowserGatewayProxyErrorCode, message: string): never => {
        throw new BrowserGatewayProxyError(code, message);
      },
    };
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
