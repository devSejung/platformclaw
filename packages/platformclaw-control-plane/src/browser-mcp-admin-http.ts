import type { IncomingMessage, ServerResponse } from "node:http";
import { redactSensitiveUrl } from "@openclaw/net-policy/redact-sensitive-url";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readPlatformClawSessionCookie, type JsonBodyReader } from "./browser-auth-http.js";
import type { BrowserAuthService } from "./browser-auth-service.js";
import { ControlPlaneStateError } from "./contracts.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";

export const PLATFORMCLAW_MCP_ADMIN_PATH = "/platformclaw/api/admin/mcp";
const BODY_LIMIT_BYTES = 48 * 1024;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const INVALIDATION_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 4_000, 4_000] as const;

type ConfigSnapshot = { config: Record<string, unknown>; hash: string };
type AgentSummary = { id?: unknown };
type AgentsListResult = { agents?: unknown };
type CredentialMode = "none" | "shared" | "personal";
type PersonalAuth = "bearer" | "api_key" | "oauth";

type AdminMcpServer = {
  name: string;
  enabled: boolean;
  transport: "sse" | "streamable-http" | "stdio" | "invalid";
  target: string;
  editable: boolean;
  credentialMode: CredentialMode;
  personalAuth?: PersonalAuth;
  headerName?: string;
  scope?: string;
  toolPolicy: "all" | "blocked" | "allowlist" | "custom";
  blockedTools: string[];
};

type BrowserToolFilter = {
  editable: boolean;
  policy: AdminMcpServer["toolPolicy"];
  blockedTools: string[];
};

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function objectBody(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) {
    throw new ControlPlaneStateError("invalid request body");
  }
  return record;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlPlaneStateError(`${name} is required`);
  }
  return value.trim();
}

function secretField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new ControlPlaneStateError(`${name} is required`);
  }
  return value;
}

function serverNameField(body: Record<string, unknown>): string {
  const name = stringField(body, "name");
  if (name.length > 128 || !SERVER_NAME_PATTERN.test(name)) {
    throw new ControlPlaneStateError("MCP server name is invalid");
  }
  return name;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new ControlPlaneStateError(`${label} must be a string array`);
  }
  const normalized = Array.from(
    new Set(value.map((entry) => entry.trim()).filter(Boolean)),
  ).toSorted((left, right) => left.localeCompare(right));
  if (normalized.length > 256 || normalized.some((entry) => entry.length > 256)) {
    throw new ControlPlaneStateError(`${label} is too large`);
  }
  return normalized;
}

function personalPolicies(config: Record<string, unknown>): Record<string, unknown> {
  const plugins = asRecord(config.plugins);
  const entries = asRecord(plugins?.entries);
  const plugin = asRecord(entries?.["platformclaw-user-mcp"]);
  const pluginConfig = asRecord(plugin?.config);
  return asRecord(pluginConfig?.servers) ?? {};
}

function configuredServers(config: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(config.mcp)?.servers) ?? {};
}

function browserRemoteUrl(value: unknown): URL | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function browserToolFilter(server: Record<string, unknown>): BrowserToolFilter {
  if (server.toolFilter === undefined || server.toolFilter === null) {
    return { editable: true, policy: "all", blockedTools: [] };
  }
  const filter = asRecord(server.toolFilter);
  if (!filter) {
    return { editable: false, policy: "custom", blockedTools: [] };
  }
  if (Object.hasOwn(filter, "include")) {
    return { editable: false, policy: "allowlist", blockedTools: [] };
  }
  if (Object.keys(filter).some((key) => key !== "exclude")) {
    return { editable: false, policy: "custom", blockedTools: [] };
  }
  if (filter.exclude === undefined) {
    return { editable: true, policy: "all", blockedTools: [] };
  }
  if (
    !Array.isArray(filter.exclude) ||
    !filter.exclude.every((entry) => typeof entry === "string")
  ) {
    return { editable: false, policy: "custom", blockedTools: [] };
  }
  return {
    editable: true,
    policy: filter.exclude.length > 0 ? "blocked" : "all",
    blockedTools: filter.exclude,
  };
}

function projectServer(name: string, raw: unknown, rawPolicy: unknown): AdminMcpServer {
  const server = asRecord(raw) ?? {};
  const policy = asRecord(rawPolicy);
  const rawUrl = typeof server.url === "string" ? server.url : "";
  const url = browserRemoteUrl(rawUrl);
  const command = typeof server.command === "string" ? server.command : "";
  const transport = command
    ? "stdio"
    : url && (server.transport === undefined || server.transport === "sse")
      ? "sse"
      : url && server.transport === "streamable-http"
        ? "streamable-http"
        : "invalid";
  const personalAuth =
    policy?.auth === "bearer" || policy?.auth === "api_key" || policy?.auth === "oauth"
      ? policy.auth
      : undefined;
  const headers = asRecord(server.headers);
  const headerNames = Object.keys(headers ?? {});
  const sharedHeaderName = headerNames.length === 1 ? headerNames[0] : undefined;
  const toolFilter = browserToolFilter(server);
  const hasAdvancedTls = ["sslVerify", "clientCert", "clientKey"].some((key) =>
    Object.hasOwn(server, key),
  );
  const credentialMode: CredentialMode = personalAuth
    ? "personal"
    : server.auth === "oauth" || (headers && Object.keys(headers).length > 0)
      ? "shared"
      : "none";
  return {
    name,
    enabled: server.enabled !== false,
    transport,
    target: url?.toString() || command,
    editable:
      Boolean(url) &&
      transport !== "invalid" &&
      server.auth !== "oauth" &&
      headerNames.length <= 1 &&
      toolFilter.editable &&
      !hasAdvancedTls,
    credentialMode,
    ...(personalAuth ? { personalAuth } : {}),
    ...(typeof policy?.headerName === "string"
      ? { headerName: policy.headerName }
      : sharedHeaderName
        ? { headerName: sharedHeaderName }
        : {}),
    ...(typeof policy?.scope === "string" ? { scope: policy.scope } : {}),
    toolPolicy: toolFilter.policy,
    blockedTools: toolFilter.blockedTools,
  };
}

function configSnapshot(value: unknown): ConfigSnapshot {
  const response = asRecord(value);
  const config = asRecord(response?.config);
  const hash = response?.hash;
  if (!config || typeof hash !== "string" || !hash) {
    throw new Error("Gateway returned an invalid MCP configuration snapshot");
  }
  return { config, hash };
}

function configWriteResult(value: unknown): Record<string, unknown> {
  const response = asRecord(value);
  const config = asRecord(response?.config);
  if (!config) {
    throw new Error("Gateway returned an invalid MCP configuration write result");
  }
  return config;
}

function clearRecordKeys(value: unknown): Record<string, null> {
  const record = asRecord(value);
  return record ? Object.fromEntries(Object.keys(record).map((key) => [key, null])) : {};
}

export class McpAdministrationService {
  constructor(
    private readonly options: { authService: BrowserAuthService; adminRpc: GatewayAdminRpc },
  ) {}

  async authenticate(token: string) {
    const result = await this.options.authService.authenticateToken(token);
    return result.status === "active" ? result : null;
  }

  async snapshot() {
    const snapshot = configSnapshot(await this.options.adminRpc.call("config.get", {}));
    const policies = personalPolicies(snapshot.config);
    return {
      servers: Object.entries(configuredServers(snapshot.config))
        .map(([name, server]) => projectServer(name, server, policies[name]))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async mutate(action: string, body: Record<string, unknown>) {
    const snapshot = configSnapshot(await this.options.adminRpc.call("config.get", {}));
    const name = serverNameField(body);
    const servers = configuredServers(snapshot.config);
    const current = asRecord(servers[name]);
    let patch: Record<string, unknown>;

    if (action === "remove-server") {
      // Removal stays idempotent so a retry can finish post-write connection
      // invalidation when the first request committed but lost its final response.
      patch = {
        mcp: { servers: { [name]: null } },
        plugins: {
          entries: { "platformclaw-user-mcp": { config: { servers: { [name]: null } } } },
        },
      };
    } else if (action === "toggle-server") {
      if (!current || typeof body.enabled !== "boolean") {
        throw new ControlPlaneStateError("MCP server and enabled state are required");
      }
      patch = { mcp: { servers: { [name]: { enabled: body.enabled ? null : false } } } };
    } else if (action === "save-server") {
      const urlValue = stringField(body, "url");
      const url = browserRemoteUrl(urlValue);
      if (!url) {
        throw new ControlPlaneStateError("MCP server URL is invalid");
      }
      if (redactSensitiveUrl(url.toString()) !== url.toString()) {
        throw new ControlPlaneStateError(
          "MCP server URL must not embed credentials; use the credential policy fields",
        );
      }
      const transport = body.transport;
      if (transport !== "sse" && transport !== "streamable-http") {
        throw new ControlPlaneStateError("MCP transport is invalid");
      }
      const mode = body.credentialMode;
      if (mode !== "none" && mode !== "shared" && mode !== "personal") {
        throw new ControlPlaneStateError("MCP credential mode is invalid");
      }
      if (mode === "personal" && body.auth === "oauth" && url.protocol !== "https:") {
        throw new ControlPlaneStateError("MCP OAuth servers must use HTTPS");
      }
      if (!current && Object.hasOwn(servers, name)) {
        throw new ControlPlaneStateError("MCP server configuration is invalid");
      }
      if (
        current &&
        !projectServer(name, current, personalPolicies(snapshot.config)[name]).editable
      ) {
        throw new ControlPlaneStateError("advanced MCP servers must be edited with the server CLI");
      }
      const blockedTools = stringArray(body.blockedTools ?? [], "blockedTools");
      const enabled = body.enabled !== false;
      const serverPatch: Record<string, unknown> = {
        url: url.toString(),
        transport,
        enabled: enabled ? null : false,
        command: null,
        args: null,
        env: null,
        cwd: null,
        auth: null,
        oauth: null,
        toolFilter: blockedTools.length > 0 ? { exclude: blockedTools } : null,
      };
      let personalPolicy: Record<string, unknown> | null = null;
      if (mode === "shared") {
        const auth = body.auth;
        const secret = secretField(body, "secret");
        const headerName = auth === "bearer" ? "Authorization" : stringField(body, "headerName");
        if ((auth !== "bearer" && auth !== "api_key") || !HEADER_NAME_PATTERN.test(headerName)) {
          throw new ControlPlaneStateError("shared credential type or header is invalid");
        }
        serverPatch.headers = {
          ...clearRecordKeys(current?.headers),
          [headerName]: auth === "bearer" ? `Bearer ${secret}` : secret,
        };
      } else {
        serverPatch.headers = current ? clearRecordKeys(current.headers) : null;
      }
      if (mode === "personal") {
        const auth = body.auth;
        if (auth !== "bearer" && auth !== "api_key" && auth !== "oauth") {
          throw new ControlPlaneStateError("personal credential type is invalid");
        }
        personalPolicy = { auth, headerName: null, scope: null };
        if (auth === "api_key") {
          const headerName = stringField(body, "headerName");
          if (!HEADER_NAME_PATTERN.test(headerName)) {
            throw new ControlPlaneStateError("personal API-key header is invalid");
          }
          personalPolicy.headerName = headerName;
        }
        if (auth === "oauth" && typeof body.scope === "string" && body.scope.trim()) {
          const scope = body.scope.trim();
          if (
            scope.length > 2_048 ||
            scope.includes("\0") ||
            scope.includes("\r") ||
            scope.includes("\n")
          ) {
            throw new ControlPlaneStateError("personal OAuth scope is invalid");
          }
          personalPolicy.scope = scope;
        }
      }
      patch = {
        mcp: { servers: { [name]: serverPatch } },
        plugins: {
          entries: {
            "platformclaw-user-mcp": { config: { servers: { [name]: personalPolicy } } },
          },
        },
      };
    } else {
      throw new ControlPlaneStateError("unknown MCP administration action");
    }

    // Dispose live requester-scoped connections before changing their policy.
    // config.patch may restart the Gateway, so post-write invalidation can race shutdown.
    await this.invalidateAgentConnections();
    const updatedConfig = configWriteResult(
      await this.options.adminRpc.call("config.patch", {
        raw: JSON.stringify(patch),
        baseHash: snapshot.hash,
        note: `PlatformClaw MCP administration: ${action} ${name}`,
      }),
    );
    await this.invalidateAgentConnectionsAfterWrite();
    const policies = personalPolicies(updatedConfig);
    return {
      servers: Object.entries(configuredServers(updatedConfig))
        .map(([serverName, server]) => projectServer(serverName, server, policies[serverName]))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  }

  private async invalidateAgentConnections(): Promise<void> {
    const result = await this.options.adminRpc.call<AgentsListResult>("agents.list", {});
    if (!Array.isArray(result.agents)) {
      throw new Error("Gateway returned an invalid Agent list for MCP administration");
    }
    const agentIds = Array.from(
      new Set(
        result.agents
          .map((entry: AgentSummary) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
          .filter(Boolean),
      ),
    ).toSorted((left, right) => left.localeCompare(right));
    await Promise.all(
      agentIds.map(async (agentId) => {
        await this.options.adminRpc.call("platformclaw-user-mcp.invalidateAgent", { agentId });
      }),
    );
  }

  private async invalidateAgentConnectionsAfterWrite(): Promise<void> {
    for (const retryDelayMs of INVALIDATION_RETRY_DELAYS_MS) {
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
      try {
        await this.invalidateAgentConnections();
        return;
      } catch (error) {
        if (!(error instanceof GatewayAdminRpcError) || error.code !== "UNAVAILABLE") {
          throw error;
        }
      }
    }
    throw new GatewayAdminRpcError(
      "Gateway MCP connection invalidation did not recover after the configuration update",
      "UNAVAILABLE",
    );
  }
}

export async function handlePlatformClawMcpAdministrationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    service: McpAdministrationService;
    readJsonBody: JsonBodyReader;
    isMutationOriginAllowed(req: IncomingMessage): boolean;
  },
): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== PLATFORMCLAW_MCP_ADMIN_PATH) {
    return false;
  }
  const token = readPlatformClawSessionCookie(req);
  const auth = token ? await options.service.authenticate(token) : null;
  if (!auth) {
    sendJson(res, 401, { error: "authentication required" });
    return true;
  }
  if (auth.user.globalRole !== "admin") {
    sendJson(res, 403, { error: "administrator access required" });
    return true;
  }
  const method = (req.method ?? "GET").toUpperCase();
  try {
    if (method === "GET") {
      sendJson(res, 200, await options.service.snapshot());
      return true;
    }
    if (method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, POST");
      res.end("Method Not Allowed");
      return true;
    }
    if (!options.isMutationOriginAllowed(req)) {
      sendJson(res, 403, { error: "origin not allowed" });
      return true;
    }
    const read = await options.readJsonBody(req, BODY_LIMIT_BYTES);
    if (!read.ok) {
      sendJson(res, 400, { error: read.error });
      return true;
    }
    const body = objectBody(read.value);
    sendJson(res, 200, await options.service.mutate(stringField(body, "action"), body));
  } catch (error) {
    sendJson(res, error instanceof ControlPlaneStateError ? 400 : 503, {
      error: error instanceof Error ? error.message : "request failed",
    });
  }
  return true;
}
