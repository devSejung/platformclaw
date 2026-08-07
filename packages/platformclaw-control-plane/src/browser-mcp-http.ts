import type { IncomingMessage, ServerResponse } from "node:http";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneStore } from "./contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type {
  McpCredentialPayload,
  ControlPlaneMcpCredentialStore,
} from "./mcp-credential-contracts.js";
import type { McpCredentialVault } from "./mcp-credential-vault.js";
import { isMcpOAuthCredentialUsable, McpOAuthService } from "./mcp-oauth-service.js";

export const PLATFORMCLAW_MCP_SETTINGS_PATH = "/platformclaw/api/mcp";
export const PLATFORMCLAW_MCP_CREDENTIAL_PATH = "/platformclaw/api/mcp/credential";
export const PLATFORMCLAW_MCP_OAUTH_START_PATH = "/platformclaw/api/mcp/oauth/start";
export const PLATFORMCLAW_MCP_OAUTH_CALLBACK_PATH = "/platformclaw/api/mcp/oauth/callback";
const MCP_BODY_LIMIT_BYTES = 40 * 1024;
const OAUTH_ATTEMPT_WINDOW_MS = 5 * 60_000;
const OAUTH_ATTEMPT_LIMIT = 5;

type McpSelfServiceStore = Pick<ControlPlaneStore, "getPersonalAgentBinding"> &
  ControlPlaneMcpCredentialStore;

type UserMcpAuthKind = "bearer" | "api_key" | "oauth";
type UserMcpServerPolicy = {
  serverName: string;
  auth: UserMcpAuthKind;
  headerName?: string;
  scope?: string;
  url: string;
};

type CatalogResponse = { servers: UserMcpServerPolicy[] };

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

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validPolicy(value: unknown): value is UserMcpServerPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.serverName === "string" &&
    policy.serverName.length > 0 &&
    policy.serverName.length <= 128 &&
    policy.serverName.trim() === policy.serverName &&
    isSafeHttpUrl(policy.url) &&
    (policy.auth === "bearer" || policy.auth === "api_key" || policy.auth === "oauth") &&
    (policy.auth !== "api_key" ||
      (typeof policy.headerName === "string" &&
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(policy.headerName))) &&
    (policy.scope === undefined ||
      (typeof policy.scope === "string" &&
        policy.scope.length <= 2_048 &&
        !policy.scope.includes("\0") &&
        !policy.scope.includes("\r") &&
        !policy.scope.includes("\n")))
  );
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
    const [catalog, credentials] = await Promise.all([
      this.catalog(),
      this.options.store.listUserMcpCredentials(userId),
    ]);
    const configured = new Map(
      credentials.map((credential) => [credential.serverName, credential]),
    );
    return {
      servers: await Promise.all(
        catalog.map(async (policy) => {
          const { url: _url, ...publicPolicy } = policy;
          const credential = configured.get(policy.serverName);
          const stored = credential
            ? await this.options.vault.readForUser(userId, policy.serverName).catch(() => null)
            : null;
          const payload = stored?.payload;
          const isConfigured =
            credential?.kind !== policy.auth || payload?.kind !== policy.auth
              ? false
              : payload.serverUrl !== policy.url
                ? false
                : payload.kind === "api_key" && payload.headerName !== policy.headerName
                  ? false
                  : payload.kind === "oauth"
                    ? payload.scope === policy.scope &&
                      isMcpOAuthCredentialUsable(payload, (this.options.now ?? Date.now)())
                    : true;
          return {
            serverName: publicPolicy.serverName,
            auth: publicPolicy.auth,
            headerName: publicPolicy.headerName,
            scope: publicPolicy.scope,
            configured: isConfigured,
            revision: credential?.revision,
            updatedAt: credential?.updatedAt,
          };
        }),
      ),
    };
  }

  async replace(params: {
    userId: string;
    agentId: string;
    serverName: string;
    kind: UserMcpAuthKind;
    secret: string;
  }) {
    const policy = await this.requirePolicy(params.serverName, params.kind);
    if (policy.auth === "oauth") {
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
    if (serverUrl !== undefined && policy.url !== serverUrl) {
      return null;
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
      return await this.options.vault.resolveForAgent(agentId, serverName);
    }
    return await this.oauth.resolveForAgent({
      userId: stored.userId,
      serverName,
      serverUrl: policy.url,
      revision: stored.revision,
      payload: stored.payload,
      ...(policy.scope ? { scope: policy.scope } : {}),
    });
  }

  private async catalog(): Promise<UserMcpServerPolicy[]> {
    if (!this.catalogPromise) {
      // Policy is process-stable between explicit administrator mutations; a
      // transient bootstrap failure may retry without rediscovery polling.
      const pending = this.options.adminRpc
        .call<CatalogResponse>("platformclaw-user-mcp.catalog", {})
        .then((result) => {
          if (!Array.isArray(result.servers) || !result.servers.every(validPolicy)) {
            throw new Error("MCP catalog response is invalid");
          }
          return result.servers;
        });
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
    if (!policy || (kind && policy.auth !== kind)) {
      throw new Error("MCP server or credential kind is not administrator-approved");
    }
    return policy;
  }

  private async invalidate(agentId: string): Promise<void> {
    await this.options.adminRpc.call("platformclaw-user-mcp.invalidateAgent", { agentId });
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
    if (method !== "GET") {
      methodNotAllowed(res, "GET");
    } else {
      sendJson(res, 200, await options.service.getSettings(auth.user.id));
    }
    return true;
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
    sendJson(res, 409, { error: error instanceof Error ? error.message : "MCP update failed" });
  }
  return true;
}
