import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { parseUserMcpServerPolicies, type UserMcpServerPolicy } from "./src/config.js";
import { createUserMcpConnectionRuntime } from "./src/runtime.js";

export function configuredRemoteUrl(
  config: unknown,
  serverName: string,
  auth?: "bearer" | "api_key" | "oauth",
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
    const personalPolicies = parseUserMcpServerPolicies(api.pluginConfig);
    const declared =
      (
        api.config as {
          mcp?: {
            servers?: Record<
              string,
              { url?: string; command?: string; headers?: Record<string, string>; auth?: string }
            >;
          };
        }
      ).mcp?.servers ?? {};
    const policies = new Map(personalPolicies.map((policy) => [policy.serverName, policy]));
    // Adopt existing common remote declarations at startup. Personal settings
    // must cover shared/no-auth servers too, rather than leaving a static bypass.
    for (const [serverName, server] of Object.entries(declared)) {
      if (policies.has(serverName) || !server.url || server.command) {
        continue;
      }
      configuredRemoteUrl(api.config, serverName);
      policies.set(serverName, {
        serverName,
        credentialMode:
          server.auth === "oauth" || Object.keys(server.headers ?? {}).length ? "shared" : "none",
        headerGuides: [],
      });
    }
    const serverForConfig = (config: unknown, serverName: string) =>
      (
        config as {
          mcp?: {
            servers?: Record<
              string,
              { enabled?: boolean; headers?: Record<string, string>; auth?: string }
            >;
          };
        }
      ).mcp?.servers?.[serverName];
    const projectPolicy = (config: unknown, policy: UserMcpServerPolicy) => ({
      ...policy,
      url: configuredRemoteUrl(config, policy.serverName, policy.auth),
      enabled: serverForConfig(config, policy.serverName)?.enabled !== false,
      commonHeaderNames: Object.keys(serverForConfig(config, policy.serverName)?.headers ?? {}),
      configuredOAuth: serverForConfig(config, policy.serverName)?.auth === "oauth",
    });
    const catalogForConfig = (config: unknown) =>
      Array.from(policies.values())
        .toSorted((a, b) => a.serverName.localeCompare(b.serverName))
        .map((policy) => projectPolicy(config, policy));
    catalogForConfig(api.config);
    const runtime = policies.size > 0 ? createUserMcpConnectionRuntime() : undefined;
    for (const policy of policies.values()) {
      api.registerMcpServerConnectionResolver({
        serverName: policy.serverName,
        resolve: async () => null,
        resolveForAgent: async ({ agentId }) => {
          // MCP definitions hot-reload without replacing plugin registrations.
          // Pin one current URL across the broker request and its credential result.
          const config = api.runtime.config.current();
          const server = serverForConfig(config, policy.serverName);
          const url = configuredRemoteUrl(config, policy.serverName, policy.auth);
          // Upstream session overrides can enable a default-disabled server.
          // Organization Off remains authoritative at the connection owner.
          if (server?.enabled === false) {
            return null;
          }
          const connection = await runtime?.resolve(agentId, policy.serverName, url);
          const headers = new Headers(server?.headers);
          for (const [name, value] of Object.entries(connection?.headers ?? {})) {
            headers.set(name, value);
          }
          return connection
            ? {
                url,
                headers: Object.fromEntries(headers),
                expiresAt: connection.expiresAt,
                ...(server?.auth === "oauth" && policy.credentialMode === "shared"
                  ? { preserveConfiguredAuth: true }
                  : {}),
              }
            : null;
        },
      });
    }
    api.registerGatewayMethod(
      "platformclaw-user-mcp.catalog",
      ({ context, respond }) =>
        respond(true, { servers: catalogForConfig(context.getRuntimeConfig()) }),
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
        respond(true, {
          disposed: await api.runtime.mcp.disposeAgentConnections({
            agentId,
            retireSessionCatalog: true,
          }),
        });
      },
      { scope: "operator.admin" },
    );
  },
});
