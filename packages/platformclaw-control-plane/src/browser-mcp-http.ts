import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneStore } from "./contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type {
  McpCredentialPayload,
  ControlPlaneMcpCredentialStore,
  ControlPlaneMcpSettingsStore,
} from "./mcp-credential-contracts.js";
import { normalizeMcpAdditionalHeaders, type McpCredentialVault } from "./mcp-credential-vault.js";
import { assertAdditionalMcpHeader } from "./mcp-header-policy.js";
import { isMcpOAuthCredentialUsable, McpOAuthService } from "./mcp-oauth-service.js";
import {
  mcpPolicyFingerprint,
  parseMcpUserCatalog,
  protectedMcpHeaders,
  validateAdditionalMcpHeaders,
  type UserMcpAuthKind,
  type UserMcpServerPolicy,
} from "./mcp-user-policy.js";

export const PLATFORMCLAW_MCP_SETTINGS_PATH = "/platformclaw/api/mcp";
export const PLATFORMCLAW_MCP_CREDENTIAL_PATH = "/platformclaw/api/mcp/credential";
export const PLATFORMCLAW_MCP_OAUTH_START_PATH = "/platformclaw/api/mcp/oauth/start";
export const PLATFORMCLAW_MCP_OAUTH_CALLBACK_PATH = "/platformclaw/api/mcp/oauth/callback";
const MCP_BODY_LIMIT_BYTES = 80 * 1024;
const OAUTH_ATTEMPT_WINDOW_MS = 5 * 60_000;
const OAUTH_ATTEMPT_LIMIT = 5;

type McpSelfServiceStore = Pick<ControlPlaneStore, "getPersonalAgentBinding"> &
  ControlPlaneMcpCredentialStore &
  ControlPlaneMcpSettingsStore;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function redirectMcpOAuthResult(res: ServerResponse, result: "success" | "error"): void {
  res.statusCode = 302;
  res.setHeader("Location", `/platformclaw/app/settings/mcp?mcpOAuth=${result}`);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

function redirectMcpOAuthLogin(res: ServerResponse): void {
  const returnTo = "/platformclaw/app/settings/mcp?mcpOAuth=error";
  res.statusCode = 302;
  res.setHeader("Location", `/platformclaw/login?returnTo=${encodeURIComponent(returnTo)}`);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

function methodNotAllowed(res: ServerResponse, allowed: string): void {
  res.statusCode = 405;
  res.setHeader("Allow", allowed);
  res.end("Method Not Allowed");
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class EmployeeMcpService {
  private catalogPromise: Promise<UserMcpServerPolicy[]> | undefined;
  private readonly oauth: McpOAuthService;
  private readonly activeOAuthAgents = new Set<string>();
  private readonly oauthAttempts = new Map<string, number[]>();

  constructor(
    private readonly options: {
      authService: BrowserAuthService;
      store: McpSelfServiceStore;
      vault: McpCredentialVault;
      adminRpc: GatewayAdminRpc;
      publicOrigin: string;
      fetchImpl?: typeof globalThis.fetch;
      now?: () => number;
    },
  ) {
    this.oauth = new McpOAuthService({
      store: options.store,
      vault: options.vault,
      redirectUrl: new URL(PLATFORMCLAW_MCP_OAUTH_CALLBACK_PATH, options.publicOrigin).toString(),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  invalidateCatalog(): void {
    this.catalogPromise = undefined;
  }

  async authenticate(token: string) {
    const auth = await this.options.authService.authenticateToken(token);
    if (auth.status !== "active") {
      return null;
    }
    const binding = await this.options.store.getPersonalAgentBinding(auth.user.id);
    return binding?.state === "active" ? { user: auth.user, binding } : null;
  }

  async getSettings(userId: string) {
    const catalog = await this.catalog();
    return {
      servers: await Promise.all(
        catalog.map(async (policy) => {
          const stored = await this.options.vault.readStatusForUser(userId, policy.serverName);
          const credential = stored?.metadata;
          const payload = stored?.payload;
          const isConfigured =
            policy.credentialMode !== "personal" ||
            Boolean(
              payload &&
              credential?.kind === policy.auth &&
              payload.kind === policy.auth &&
              payload.serverUrl === policy.url &&
              (payload.kind !== "api_key" || payload.headerName === policy.headerName) &&
              (payload.kind !== "oauth" ||
                (payload.scope === policy.scope &&
                  isMcpOAuthCredentialUsable(payload, (this.options.now ?? Date.now)()))),
            );
          const settings = await this.options.vault.readSettingsForUser(userId, policy.serverName);
          let headerError: string | undefined;
          if (
            settings?.payload.serverUrl !== policy.url &&
            Object.keys(settings?.payload.headers ?? {}).length
          ) {
            headerError =
              "The administrator changed the server URL. Enter additional header values again.";
          } else if (settings) {
            try {
              validateAdditionalMcpHeaders(settings.payload.headers, policy);
            } catch {
              headerError =
                "Saved headers conflict with the current connection policy. Remove conflicting headers and save.";
            }
          }
          return {
            serverName: policy.serverName,
            origin: "organization" as const,
            credentialMode: policy.credentialMode,
            policyFingerprint: mcpPolicyFingerprint(policy),
            auth: policy.credentialMode === "personal" ? policy.auth : undefined,
            headerName: policy.credentialMode === "personal" ? policy.headerName : undefined,
            scope: policy.scope,
            globalEnabled: policy.enabled,
            userEnabled: settings?.enabled ?? true,
            settingsRevision: settings?.revision ?? 0,
            headerGuides: policy.headerGuides,
            headers:
              settings?.payload.serverUrl === policy.url
                ? Object.keys(settings.payload.headers)
                    .toSorted()
                    .map((name) => ({ name, configured: true as const }))
                : [],
            headerError,
            configured: isConfigured,
            credentialStored: Boolean(credential),
            credentialFingerprint: stored?.fingerprint ?? null,
            revision: credential?.revision,
            updatedAt: credential?.updatedAt,
          };
        }),
      ),
    };
  }

  async updateSettings(params: {
    userId: string;
    agentId: string;
    serverName: string;
    expectedRevision: number;
    expectedPolicyFingerprint?: string;
    expectedCredentialFingerprint?: string | null;
    enabled?: boolean;
    headers?: unknown;
    credential?: unknown;
  }) {
    if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
      throw new Error("settings revision is required");
    }
    const policy = await this.requirePolicy(params.serverName);
    if (
      (params.headers !== undefined || params.credential !== undefined) &&
      params.expectedPolicyFingerprint !== mcpPolicyFingerprint(policy)
    ) {
      throw new Error(
        "MCP connection policy changed. Reload MCP settings and re-enter changed values before saving.",
      );
    }
    const current = await this.options.vault.readSettingsForUser(params.userId, policy.serverName);
    const enabled = params.enabled ?? current?.enabled ?? true;
    if (enabled && current?.enabled === false && !policy.enabled) {
      throw new Error("The administrator disabled this MCP server");
    }
    const oldHeaders = current?.payload.serverUrl === policy.url ? current.payload.headers : {};
    let headers = oldHeaders;
    if (params.headers !== undefined) {
      if (!Array.isArray(params.headers) || params.headers.length > 32) {
        throw new Error("MCP headers are invalid");
      }
      headers = Object.create(null) as Record<string, string>;
      const seen = new Set<string>();
      for (const raw of params.headers) {
        const row = objectBody(raw);
        if (
          !row ||
          typeof row.name !== "string" ||
          (row.value !== undefined && typeof row.value !== "string")
        ) {
          throw new Error("MCP header is invalid");
        }
        const name = row.name.trim();
        if (!name && (row.value === undefined || row.value === "")) {
          continue;
        }
        const lower = name.toLowerCase();
        if (seen.has(lower)) {
          throw new Error("MCP header names must be unique (case insensitive)");
        }
        seen.add(lower);
        const oldName = Object.keys(oldHeaders).find((entry) => entry.toLowerCase() === lower);
        // A changed organization policy can reserve a previously valid custom
        // name. Deletion must remain possible without authorizing its value.
        if (oldName && row.value === "") {
          continue;
        }
        assertAdditionalMcpHeader(name, protectedMcpHeaders(policy));
        const value =
          row.value === undefined ? (oldName ? (oldHeaders[oldName] ?? "") : "") : row.value;
        if (value !== "") {
          headers[name] = value;
        }
      }
    }
    headers = normalizeMcpAdditionalHeaders(headers);
    if (enabled || params.headers !== undefined) {
      validateAdditionalMcpHeaders(headers, policy);
    }
    const credential = params.credential === undefined ? undefined : objectBody(params.credential);
    if (
      params.credential !== undefined &&
      (!credential ||
        typeof credential.secret !== "string" ||
        (credential.kind !== "bearer" && credential.kind !== "api_key") ||
        credential.kind !== policy.auth ||
        policy.credentialMode !== "personal")
    ) {
      throw new Error("MCP credential is invalid for this server");
    }
    let credentialReplacement:
      | { payload: McpCredentialPayload; expectedFingerprint: string | null }
      | undefined;
    if (credential) {
      const expectedFingerprint = params.expectedCredentialFingerprint;
      if (expectedFingerprint === undefined) {
        throw new Error(
          "MCP credential snapshot is required. Reload settings before replacing it.",
        );
      }
      credentialReplacement = {
        expectedFingerprint,
        payload:
          credential.kind === "bearer"
            ? { kind: "bearer", serverUrl: policy.url, token: credential.secret as string }
            : {
                kind: "api_key",
                serverUrl: policy.url,
                headerName: policy.headerName!,
                value: credential.secret as string,
              },
      };
    }
    await this.options.vault.replaceSettings({
      actorUserId: params.userId,
      userId: params.userId,
      serverName: policy.serverName,
      enabled,
      expectedRevision: params.expectedRevision,
      // Permission-only changes preserve the encrypted destination binding too;
      // switching Off must not erase headers after an administrator URL change.
      payload:
        current && params.headers === undefined && params.credential === undefined
          ? current.payload
          : { serverUrl: policy.url, headers },
      updatedAt: (this.options.now ?? Date.now)(),
      ...(credentialReplacement ? { credential: credentialReplacement } : {}),
    });
    // Preferences and optional credential commit together before retiring the
    // old catalog, so the next run cannot resurrect a disabled tool snapshot.
    try {
      await this.invalidate(params.agentId);
    } catch {
      throw new McpSettingsRefreshError(await this.getSettings(params.userId));
    }
    return await this.getSettings(params.userId);
  }

  async replace(params: {
    userId: string;
    agentId: string;
    serverName: string;
    kind: UserMcpAuthKind;
    secret: string;
  }) {
    const policy = await this.requirePolicy(params.serverName, params.kind);
    if (policy.credentialMode !== "personal" || policy.auth === "oauth") {
      throw new Error("OAuth credentials must use the OAuth authorization flow");
    }
    const payload: McpCredentialPayload =
      policy.auth === "bearer"
        ? { kind: "bearer", serverUrl: policy.url, token: params.secret }
        : {
            kind: "api_key",
            serverUrl: policy.url,
            headerName: policy.headerName!,
            value: params.secret,
          };
    const metadata = await this.options.vault.replace({
      actorUserId: params.userId,
      userId: params.userId,
      serverName: policy.serverName,
      payload,
      updatedAt: (this.options.now ?? Date.now)(),
    });
    await this.invalidate(params.agentId);
    return { serverName: metadata.serverName, revision: metadata.revision };
  }

  async remove(userId: string, agentId: string, serverName: string) {
    await this.requirePolicy(serverName);
    const deleted = await this.options.store.deleteUserMcpCredential({
      actorUserId: userId,
      userId,
      serverName,
      deletedAt: (this.options.now ?? Date.now)(),
    });
    // Revocation is idempotent. Always retry runtime disposal even when the
    // credential row was removed by an earlier request whose RPC failed.
    await this.invalidate(agentId);
    return { deleted };
  }

  async beginOAuth(userId: string, agentId: string, serverName: string) {
    const now = (this.options.now ?? Date.now)();
    const recent = (this.oauthAttempts.get(agentId) ?? []).filter(
      (attempt) => attempt > now - OAUTH_ATTEMPT_WINDOW_MS,
    );
    if (this.activeOAuthAgents.has(agentId) || recent.length >= OAUTH_ATTEMPT_LIMIT) {
      throw new Error("MCP OAuth authorization is already active or was attempted too often");
    }
    recent.push(now);
    this.oauthAttempts.set(agentId, recent);
    this.activeOAuthAgents.add(agentId);
    try {
      const policy = await this.requirePolicy(serverName, "oauth");
      const result = await this.oauth.begin({
        userId,
        serverName: policy.serverName,
        serverUrl: policy.url,
        ...(policy.scope ? { scope: policy.scope } : {}),
      });
      if (result.status === "authorized") {
        await this.invalidate(agentId);
      }
      return result;
    } finally {
      this.activeOAuthAgents.delete(agentId);
    }
  }

  async completeOAuth(params: { userId: string; agentId: string; state: string; code: string }) {
    const flow = await this.oauth.consumeState(params.state);
    if (!flow || flow.userId !== params.userId) {
      throw new Error("MCP OAuth state is invalid or expired");
    }
    const policy = await this.requirePolicy(flow.serverName, "oauth");
    await this.oauth.complete({
      userId: params.userId,
      serverName: policy.serverName,
      serverUrl: policy.url,
      code: params.code,
      ...(policy.scope ? { scope: policy.scope } : {}),
    });
    await this.invalidate(params.agentId);
  }

  async cancelOAuth(userId: string, state: string): Promise<void> {
    const flow = await this.oauth.consumeState(state);
    if (!flow || flow.userId !== userId) {
      throw new Error("MCP OAuth state is invalid or expired");
    }
  }

  async resolveForAgent(agentId: string, serverName: string, serverUrl?: string) {
    const policy = await this.requirePolicy(serverName);
    if (!policy.enabled || (serverUrl !== undefined && policy.url !== serverUrl)) {
      return null;
    }
    const userId = await this.options.store.getActivePersonalMcpOwner(agentId);
    if (!userId) {
      return policy.credentialMode !== "personal" &&
        (await this.options.store.getActiveCommonMcpAgent(agentId))
        ? { headers: {}, revision: 0 }
        : null;
    }
    const settings = await this.options.vault.readSettingsForUser(userId, serverName);
    if (settings?.enabled === false) {
      return null;
    }
    const headers = settings?.payload.serverUrl === policy.url ? settings.payload.headers : {};
    if (
      settings &&
      settings.payload.serverUrl !== policy.url &&
      Object.keys(settings.payload.headers).length
    ) {
      return null;
    }
    try {
      validateAdditionalMcpHeaders(headers, policy);
    } catch {
      return null;
    }
    if (policy.credentialMode !== "personal") {
      return { headers, revision: settings?.revision ?? 0 };
    }
    const stored = await this.options.vault.readForAgent(agentId, serverName);
    if (!stored) {
      return null;
    }
    if (stored.payload.kind !== policy.auth || stored.payload.serverUrl !== policy.url) {
      return null;
    }
    if (stored.payload.kind === "api_key" && stored.payload.headerName !== policy.headerName) {
      return null;
    }
    if (stored.payload.kind === "oauth" && stored.payload.scope !== policy.scope) {
      return null;
    }
    if (stored.payload.kind !== "oauth") {
      const connection = await this.options.vault.resolveForAgent(agentId, serverName);
      return connection ? { ...connection, headers: { ...headers, ...connection.headers } } : null;
    }
    const connection = await this.oauth.resolveForAgent({
      userId: stored.userId,
      serverName,
      serverUrl: policy.url,
      revision: stored.revision,
      payload: stored.payload,
      ...(policy.scope ? { scope: policy.scope } : {}),
    });
    return connection ? { ...connection, headers: { ...headers, ...connection.headers } } : null;
  }

  private async catalog(): Promise<UserMcpServerPolicy[]> {
    if (!this.catalogPromise) {
      // Policy is process-stable between explicit administrator mutations; a
      // transient bootstrap failure may retry without rediscovery polling.
      const pending = this.options.adminRpc
        .call<unknown>("platformclaw-user-mcp.catalog", {})
        .then(parseMcpUserCatalog);
      this.catalogPromise = pending;
      void pending.catch(() => {
        if (this.catalogPromise === pending) {
          this.catalogPromise = undefined;
        }
      });
    }
    return await this.catalogPromise;
  }

  private async requirePolicy(serverName: string, kind?: UserMcpAuthKind) {
    const normalized = serverName.trim();
    const policy = (await this.catalog()).find((entry) => entry.serverName === normalized);
    if (!policy || (kind && (policy.credentialMode !== "personal" || policy.auth !== kind))) {
      throw new Error("MCP server or credential kind is not administrator-approved");
    }
    return policy;
  }

  private async invalidate(agentId: string): Promise<void> {
    await this.options.adminRpc.call("platformclaw-user-mcp.invalidateAgent", { agentId });
  }
}

class McpSettingsRefreshError extends Error {
  constructor(readonly settings: Awaited<ReturnType<EmployeeMcpService["getSettings"]>>) {
    super(
      "MCP settings were saved, but active connections could not be refreshed. Save again to retry.",
    );
  }
}

export async function handlePlatformClawEmployeeMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: EmployeeMcpService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (
    pathname !== PLATFORMCLAW_MCP_SETTINGS_PATH &&
    pathname !== PLATFORMCLAW_MCP_CREDENTIAL_PATH &&
    pathname !== PLATFORMCLAW_MCP_OAUTH_START_PATH &&
    pathname !== PLATFORMCLAW_MCP_OAUTH_CALLBACK_PATH
  ) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : null;
  if (!auth) {
    if (pathname === PLATFORMCLAW_MCP_OAUTH_CALLBACK_PATH) {
      redirectMcpOAuthLogin(res);
    } else {
      sendJson(res, 401, { error: "authentication required" });
    }
    return true;
  }
  const method = (req.method ?? "GET").toUpperCase();
  if (pathname === PLATFORMCLAW_MCP_OAUTH_CALLBACK_PATH) {
    if (method !== "GET") {
      methodNotAllowed(res, "GET");
      return true;
    }
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const state = requestUrl.searchParams.get("state") ?? "";
    const code = requestUrl.searchParams.get("code") ?? "";
    if (requestUrl.searchParams.has("error")) {
      if (state) {
        await options.service.cancelOAuth(auth.user.id, state).catch(() => undefined);
      }
      redirectMcpOAuthResult(res, "error");
      return true;
    }
    if (!state || !code) {
      redirectMcpOAuthResult(res, "error");
      return true;
    }
    try {
      await options.service.completeOAuth({
        userId: auth.user.id,
        agentId: auth.binding.agentId,
        state,
        code,
      });
      redirectMcpOAuthResult(res, "success");
    } catch {
      redirectMcpOAuthResult(res, "error");
    }
    return true;
  }
  if (pathname === PLATFORMCLAW_MCP_SETTINGS_PATH) {
    if (method === "GET") {
      try {
        sendJson(res, 200, await options.service.getSettings(auth.user.id));
      } catch {
        sendJson(res, 503, { error: "MCP settings are unavailable. Try again." });
      }
      return true;
    }
    if (method !== "PUT") {
      methodNotAllowed(res, "GET, PUT");
      return true;
    }
  }
  if (pathname === PLATFORMCLAW_MCP_OAUTH_START_PATH && method !== "POST") {
    methodNotAllowed(res, "POST");
    return true;
  }
  if (pathname === PLATFORMCLAW_MCP_CREDENTIAL_PATH && method !== "PUT" && method !== "DELETE") {
    methodNotAllowed(res, "PUT, DELETE");
    return true;
  }
  if (!options.isMutationOriginAllowed(req)) {
    sendJson(res, 403, { error: "origin not allowed" });
    return true;
  }
  const read = await options.readJsonBody(req, MCP_BODY_LIMIT_BYTES);
  const body = read.ok ? objectBody(read.value) : null;
  if (!body || typeof body.serverName !== "string") {
    sendJson(res, 400, { error: read.ok ? "invalid request" : read.error });
    return true;
  }
  try {
    if (pathname === PLATFORMCLAW_MCP_SETTINGS_PATH) {
      if (
        typeof body.expectedRevision !== "number" ||
        (body.expectedPolicyFingerprint !== undefined &&
          typeof body.expectedPolicyFingerprint !== "string") ||
        (body.expectedCredentialFingerprint !== undefined &&
          body.expectedCredentialFingerprint !== null &&
          typeof body.expectedCredentialFingerprint !== "string") ||
        (body.enabled !== undefined && typeof body.enabled !== "boolean")
      ) {
        sendJson(res, 400, { error: "settings revision and enabled state are invalid" });
        return true;
      }
      sendJson(
        res,
        200,
        await options.service.updateSettings({
          userId: auth.user.id,
          agentId: auth.binding.agentId,
          serverName: body.serverName,
          expectedRevision: body.expectedRevision,
          ...(typeof body.expectedPolicyFingerprint === "string"
            ? { expectedPolicyFingerprint: body.expectedPolicyFingerprint }
            : {}),
          ...(body.expectedCredentialFingerprint === null ||
          typeof body.expectedCredentialFingerprint === "string"
            ? { expectedCredentialFingerprint: body.expectedCredentialFingerprint }
            : {}),
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(body.headers !== undefined ? { headers: body.headers } : {}),
          ...(body.credential !== undefined ? { credential: body.credential } : {}),
        }),
      );
      return true;
    }
    if (pathname === PLATFORMCLAW_MCP_OAUTH_START_PATH) {
      sendJson(
        res,
        200,
        await options.service.beginOAuth(auth.user.id, auth.binding.agentId, body.serverName),
      );
      return true;
    }
    if (method === "DELETE") {
      sendJson(
        res,
        200,
        await options.service.remove(auth.user.id, auth.binding.agentId, body.serverName),
      );
      return true;
    }
    if ((body.kind !== "bearer" && body.kind !== "api_key") || typeof body.secret !== "string") {
      sendJson(res, 400, { error: "invalid credential" });
      return true;
    }
    sendJson(
      res,
      200,
      await options.service.replace({
        userId: auth.user.id,
        agentId: auth.binding.agentId,
        serverName: body.serverName,
        kind: body.kind,
        secret: body.secret,
      }),
    );
  } catch (error) {
    if (error instanceof McpSettingsRefreshError) {
      sendJson(res, 503, { ...error.settings, saved: true, error: error.message });
    } else {
      sendJson(res, 409, { error: error instanceof Error ? error.message : "MCP update failed" });
    }
  }
  return true;
}
