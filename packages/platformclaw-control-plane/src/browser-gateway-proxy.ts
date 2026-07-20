import type { BrowserAuthService } from "./browser-auth-service.js";
import {
  projectBrowserAgentSummary,
  projectBrowserModelChoice,
} from "./browser-gateway-projections.js";
import type {
  ControlPlaneAuditWriter,
  ControlPlaneStore,
  PersonalAgentBinding,
  PlatformUser,
} from "./contracts.js";

export const PLATFORMCLAW_WEB_GATEWAY_METHODS = [
  "agent.identity.get",
  "agents.list",
  "chat.abort",
  "chat.history",
  "chat.message.get",
  "chat.metadata",
  "chat.send",
  "chat.startup",
  "chat.toolTitles",
  "models.list",
  "sessions.abort",
  "sessions.create",
  "sessions.describe",
  "sessions.list",
  "sessions.messages.subscribe",
  "sessions.messages.unsubscribe",
  "sessions.patch",
  "sessions.preview",
  "sessions.resolve",
  "sessions.search",
  "tools.catalog",
  "tools.effective",
] as const;

export type PlatformClawWebGatewayMethod = (typeof PLATFORMCLAW_WEB_GATEWAY_METHODS)[number];

const ALLOWED_METHODS = new Set<string>(PLATFORMCLAW_WEB_GATEWAY_METHODS);
const ALLOWED_PARAMS = new Map<string, ReadonlySet<string>>([
  ["agent.identity.get", new Set(["agentId", "sessionKey"])],
  ["agents.list", new Set()],
  ["chat.abort", new Set(["sessionKey", "agentId", "preserveSideRuns"])],
  [
    "chat.history",
    new Set(["sessionKey", "agentId", "limit", "offset", "messageId", "sessionId", "maxChars"]),
  ],
  ["chat.message.get", new Set(["sessionKey", "agentId", "messageId", "maxChars"])],
  ["chat.metadata", new Set(["agentId"])],
  [
    "chat.send",
    new Set([
      "sessionKey",
      "agentId",
      "sessionId",
      "message",
      "thinking",
      "fastMode",
      "fastAutoOnSeconds",
      "queueMode",
      "deliver",
      "attachments",
      "timeoutMs",
      "idempotencyKey",
      "__controlUiReconnectResume",
    ]),
  ],
  [
    "chat.startup",
    new Set(["sessionKey", "agentId", "limit", "offset", "messageId", "sessionId", "maxChars"]),
  ],
  ["chat.toolTitles", new Set(["sessionKey", "agentId", "items"])],
  ["models.list", new Set(["view"])],
  ["sessions.abort", new Set(["key", "agentId"])],
  [
    "sessions.create",
    new Set([
      "key",
      "agentId",
      "label",
      "thinkingLevel",
      "catalogId",
      "parentSessionKey",
      "fork",
      "emitCommandHooks",
      "succeedsParent",
    ]),
  ],
  ["sessions.describe", new Set(["key", "includeDerivedTitles", "includeLastMessage"])],
  [
    "sessions.list",
    new Set([
      "limit",
      "offset",
      "activeMinutes",
      "requireLastInteraction",
      "sortBy",
      "includeGlobal",
      "includeUnknown",
      "configuredAgentsOnly",
      "includeDerivedTitles",
      "includeLastMessage",
      "label",
      "spawnedBy",
      "agentId",
      "search",
      "archived",
    ]),
  ],
  ["sessions.messages.subscribe", new Set(["key", "agentId"])],
  ["sessions.messages.unsubscribe", new Set(["key", "agentId"])],
  [
    "sessions.patch",
    new Set([
      "key",
      "agentId",
      "label",
      "category",
      "pinned",
      "unread",
      "thinkingLevel",
      "fastMode",
      "verboseLevel",
      "traceLevel",
      "reasoningLevel",
      "responseUsage",
    ]),
  ],
  ["sessions.preview", new Set(["keys", "limit", "maxChars"])],
  [
    "sessions.resolve",
    new Set([
      "key",
      "sessionId",
      "label",
      "agentId",
      "spawnedBy",
      "includeGlobal",
      "includeUnknown",
      "allowMissing",
    ]),
  ],
  ["sessions.search", new Set(["agentId", "sessionKeys", "query", "limit"])],
  ["tools.catalog", new Set(["agentId", "includePlugins"])],
  ["tools.effective", new Set(["agentId", "sessionKey"])],
]);
const AGENT_ONLY_METHODS = new Set(["agent.identity.get", "chat.metadata", "tools.catalog"]);
const SESSION_KEY_METHODS = new Map<string, string>([
  ["chat.abort", "sessionKey"],
  ["chat.history", "sessionKey"],
  ["chat.message.get", "sessionKey"],
  ["chat.send", "sessionKey"],
  ["chat.startup", "sessionKey"],
  ["chat.toolTitles", "sessionKey"],
  ["sessions.abort", "key"],
  ["sessions.describe", "key"],
  ["sessions.messages.subscribe", "key"],
  ["sessions.messages.unsubscribe", "key"],
  ["sessions.patch", "key"],
  ["tools.effective", "sessionKey"],
]);
const SAFE_GLOBAL_EVENTS = new Set(["shutdown", "tick"]);
const SESSION_SCOPED_EVENTS = new Set([
  "chat",
  "chat.send_timing",
  "chat.side_result",
  "session.message",
  "session.operation",
  "session.tool",
  "sessions.changed",
]);
const SESSION_KEY_FIELDS = new Set([
  "sessionKey",
  "parentSessionKey",
  "childSessionKey",
  "spawnedBy",
]);

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
    let prepared: JsonObject;
    try {
      prepared = this.prepareRequest(access, method, params);
    } catch (error) {
      if (error instanceof BrowserGatewayProxyError) {
        await this.auditDeniedRequest(access, method, error.code);
      }
      throw error;
    }
    const result = await this.options.gateway.request(method, prepared);
    try {
      return this.filterResult(access, method, prepared, result) as T;
    } catch (error) {
      if (error instanceof BrowserGatewayProxyError) {
        await this.auditDeniedRequest(access, method, error.code);
      }
      throw error;
    }
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
    if (!ALLOWED_METHODS.has(method)) {
      throw new BrowserGatewayProxyError(
        "method-not-allowed",
        `Gateway method is not available to browser users: ${method}`,
      );
    }
    const params = asObject(rawParams, `${method} params`);
    this.assertAllowedParams(method, params);
    if (method === "models.list") {
      if (params.view !== undefined && params.view !== "configured") {
        throw new BrowserGatewayProxyError(
          "method-not-allowed",
          "browser model catalog is limited to configured models",
        );
      }
      return { view: "configured" };
    }
    if (method === "agents.list") {
      return {};
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
    if (AGENT_ONLY_METHODS.has(method)) {
      this.assertOptionalAgentId(access, params.agentId, method);
      if (params.sessionKey !== undefined) {
        this.assertOwnedSessionKey(access, params.sessionKey, "sessionKey");
      }
      return { ...params, agentId: access.binding.agentId };
    }
    const keyField = SESSION_KEY_METHODS.get(method);
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
  ): unknown {
    if (method === "models.list") {
      const payload = asObject(result, "models.list result");
      const models = Array.isArray(payload.models)
        ? payload.models.map(projectBrowserModelChoice).filter((entry) => entry !== null)
        : [];
      return { models };
    }
    if (method === "chat.metadata") {
      const payload = asObject(result, "chat.metadata result");
      // Browser users may choose configured models, but operator-only slash commands stay hidden.
      return payload.models === undefined ? {} : { models: payload.models };
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

  private payloadBelongsToAccess(access: BrowserGatewayAccess, payload: unknown): boolean {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const record = payload as JsonObject;
    if (this.hasForeignOwnershipFields(access, record)) {
      return false;
    }
    const agentId = optionalString(record.agentId);
    const sessionKey = optionalString(record.sessionKey) ?? optionalString(record.key);
    if (agentId && agentId !== access.binding.agentId) {
      return false;
    }
    if (sessionKey) {
      return this.options.resolveAgentIdFromSessionKey(sessionKey) === access.binding.agentId;
    }
    return agentId === access.binding.agentId;
  }

  private eventPayloadBelongsToAccess(access: BrowserGatewayAccess, payload: unknown): boolean {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    const record = payload as JsonObject;
    const sessionKey = optionalString(record.sessionKey) ?? optionalString(record.key);
    if (
      !sessionKey ||
      this.options.resolveAgentIdFromSessionKey(sessionKey) !== access.binding.agentId
    ) {
      return false;
    }
    return !this.hasForeignOwnershipFields(access, record);
  }

  private hasForeignOwnershipFields(access: BrowserGatewayAccess, record: JsonObject): boolean {
    const agentId = optionalString(record.agentId);
    if (agentId && agentId !== access.binding.agentId) {
      return true;
    }
    for (const field of SESSION_KEY_FIELDS) {
      const sessionKey = optionalString(record[field]);
      if (
        sessionKey &&
        this.options.resolveAgentIdFromSessionKey(sessionKey) !== access.binding.agentId
      ) {
        return true;
      }
    }
    const rowKey = optionalString(record.key);
    if (rowKey) {
      const resolvedAgentId = this.options.resolveAgentIdFromSessionKey(rowKey);
      if (resolvedAgentId && resolvedAgentId !== access.binding.agentId) {
        return true;
      }
    }
    if (record.childSessions !== undefined) {
      if (!Array.isArray(record.childSessions)) {
        return true;
      }
      for (const childSession of record.childSessions) {
        const sessionKey = optionalString(childSession);
        if (
          !sessionKey ||
          this.options.resolveAgentIdFromSessionKey(sessionKey) !== access.binding.agentId
        ) {
          return true;
        }
      }
    }
    return false;
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
    const allowed = ALLOWED_PARAMS.get(method);
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
