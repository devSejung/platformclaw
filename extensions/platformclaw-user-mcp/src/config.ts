export type UserMcpAuthKind = "bearer" | "api_key" | "oauth";
export type McpHeaderGuide = { name: string; description?: string };

export type UserMcpServerPolicy = {
  serverName: string;
  credentialMode: "none" | "shared" | "personal";
  auth?: UserMcpAuthKind;
  headerName?: string;
  scope?: string;
  headerGuides: McpHeaderGuide[];
};

// Match Control's transport-header policy at this separate plugin config boundary.
// API keys must not replace SDK framing or session headers on the MCP wire.
const TRANSPORT_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "accept",
  "connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

function requireHeaderName(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("API-key MCP server requires headerName");
  }
  const headerName = value.trim();
  if (
    headerName.length > 128 ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(headerName) ||
    TRANSPORT_HEADERS.has(headerName.toLowerCase())
  ) {
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
    .map(([serverName, raw]): UserMcpServerPolicy => {
      const normalizedName = serverName.trim();
      if (!normalizedName || normalizedName !== serverName || normalizedName.length > 128) {
        throw new Error("platformclaw-user-mcp server name is invalid");
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`platformclaw-user-mcp policy for ${serverName} is invalid`);
      }
      const value = raw as Record<string, unknown>;
      // Existing personal policies already carry auth. Common policies do not
      // manufacture a personal credential kind just to store optional guides.
      const credentialMode = value.credentialMode ?? "personal";
      if (
        credentialMode !== "none" &&
        credentialMode !== "shared" &&
        credentialMode !== "personal"
      ) {
        throw new Error(`platformclaw-user-mcp credential mode for ${serverName} is invalid`);
      }
      const auth = value.auth;
      if (
        (credentialMode === "personal" &&
          auth !== "bearer" &&
          auth !== "api_key" &&
          auth !== "oauth") ||
        (credentialMode === "shared" &&
          auth !== undefined &&
          auth !== "bearer" &&
          auth !== "api_key") ||
        (credentialMode === "none" && auth !== undefined)
      ) {
        throw new Error(`platformclaw-user-mcp auth for ${serverName} is invalid`);
      }
      const guides = value.headerGuides ?? [];
      if (!Array.isArray(guides) || guides.length > 32) {
        throw new Error("MCP header guides are invalid");
      }
      const seen = new Set<string>();
      const headerGuides = guides.map((rawGuide): McpHeaderGuide => {
        const guide = rawGuide as { name?: unknown; description?: unknown } | null;
        const name = typeof guide?.name === "string" ? guide.name.trim() : "";
        const description = typeof guide?.description === "string" ? guide.description.trim() : "";
        if (
          !name ||
          name.length > 128 ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
          seen.has(name.toLowerCase()) ||
          (guide?.description !== undefined && typeof guide.description !== "string") ||
          description.length > 512 ||
          description.includes("\0") ||
          description.includes("\r") ||
          description.includes("\n")
        ) {
          throw new Error("MCP header guide is invalid or duplicated");
        }
        seen.add(name.toLowerCase());
        const headerGuide: McpHeaderGuide = { name };
        if (description) {
          headerGuide.description = description;
        }
        return headerGuide;
      });
      const policy: UserMcpServerPolicy = { serverName, credentialMode, headerGuides };
      if (auth === "api_key") {
        policy.auth = auth;
        policy.headerName = requireHeaderName(value.headerName);
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
        policy.auth = auth;
        if (scope) {
          policy.scope = scope;
        }
      }
      if (auth === "bearer") {
        policy.auth = auth;
      }
      return policy;
    });
}
