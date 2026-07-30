type UserMcpAuthKind = "bearer" | "api_key" | "oauth";

type UserMcpServerPolicy = {
  serverName: string;
  auth: UserMcpAuthKind;
  headerName?: string;
  scope?: string;
};

function requireHeaderName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("API-key MCP server requires headerName");
  }
  const headerName = value.trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(headerName)) {
    throw new Error("API-key MCP server headerName is invalid");
  }
  return headerName;
}

export function parseUserMcpServerPolicies(
  pluginConfig: Record<string, unknown> | undefined,
): UserMcpServerPolicy[] {
  const rawServers = pluginConfig?.servers;
  if (rawServers === undefined) {
    return [];
  }
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    throw new Error("platformclaw-user-mcp servers config is invalid");
  }
  return Object.entries(rawServers)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([serverName, raw]) => {
      const normalizedName = serverName.trim();
      if (!normalizedName || normalizedName !== serverName || normalizedName.length > 128) {
        throw new Error("platformclaw-user-mcp server name is invalid");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`platformclaw-user-mcp policy for ${serverName} is invalid`);
      }
      const value = raw as Record<string, unknown>;
      const auth = value.auth;
      if (auth !== "bearer" && auth !== "api_key" && auth !== "oauth") {
        throw new Error(`platformclaw-user-mcp auth for ${serverName} is invalid`);
      }
      if (auth === "api_key") {
        return { serverName, auth, headerName: requireHeaderName(value.headerName) };
      }
      if (auth === "oauth") {
        const scope = typeof value.scope === "string" ? value.scope.trim() : "";
        if (
          scope.length > 2_048 ||
          scope.includes("\0") ||
          scope.includes("\r") ||
          scope.includes("\n")
        ) {
          throw new Error(`platformclaw-user-mcp scope for ${serverName} is invalid`);
        }
        return scope ? { serverName, auth, scope } : { serverName, auth };
      }
      return { serverName, auth };
    });
}
