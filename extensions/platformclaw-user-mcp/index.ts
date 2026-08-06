import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseUserMcpServerPolicies } from "./src/config.js";
import { createUserMcpConnectionRuntime } from "./src/runtime.js";

export function configuredRemoteUrl(
  config: unknown,
  serverName: string,
  auth: "bearer" | "api_key" | "oauth",
): string {
  const root = config as { mcp?: { servers?: Record<string, unknown> } };
  const raw = root.mcp?.servers?.[serverName];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`MCP server ${serverName} is not declared in mcp.servers`);
  }
  const url = (raw as Record<string, unknown>).url;
  if (typeof url !== "string" || url.length > 2_048) {
    throw new Error(`MCP server ${serverName} must use an HTTP(S) URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`MCP server ${serverName} must use an HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`MCP server ${serverName} must use a safe HTTP(S) URL`);
  }
  if (auth === "oauth" && parsed.protocol !== "https:") {
    throw new Error(`OAuth MCP server ${serverName} must use an HTTPS URL`);
  }
  return parsed.toString();
}

export default definePluginEntry({
  id: "platformclaw-user-mcp",
  name: "PlatformClaw User MCP",
  description: "Per-user credentials for administrator-approved MCP servers.",
  register(api) {
    if (api.registrationMode !== "full") {
      return;
    }
    const policies = parseUserMcpServerPolicies(api.pluginConfig);
    const catalog = policies.map((policy) => ({
      ...policy,
      url: configuredRemoteUrl(api.config, policy.serverName, policy.auth),
    }));
    const runtime = policies.length > 0 ? createUserMcpConnectionRuntime() : undefined;
    for (const policy of policies) {
      const url = catalog.find((entry) => entry.serverName === policy.serverName)!.url;
      api.registerMcpServerConnectionResolver({
        serverName: policy.serverName,
        resolve: async () => null,
        resolveForAgent: async ({ agentId }) => {
          const connection = await runtime?.resolve(agentId, policy.serverName, url);
          return connection
            ? { url, headers: connection.headers, expiresAt: connection.expiresAt }
            : null;
        },
      });
    }
    api.registerGatewayMethod(
      "platformclaw-user-mcp.catalog",
      ({ respond }) => respond(true, { servers: catalog }),
      { scope: "operator.admin" },
    );
    api.registerGatewayMethod(
      "platformclaw-user-mcp.invalidateAgent",
      async ({ params, respond }) => {
        const input = params as Record<string, unknown>;
        const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
        if (!agentId) {
          respond(false, undefined, { code: "INVALID_REQUEST", message: "agentId is required" });
          return;
        }
        respond(true, { disposed: await api.runtime.mcp.disposeAgentConnections({ agentId }) });
      },
      { scope: "operator.admin" },
    );
  },
});
