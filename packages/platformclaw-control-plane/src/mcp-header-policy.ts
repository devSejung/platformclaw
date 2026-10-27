import { ControlPlaneStateError } from "./contracts.js";

export type McpHeaderGuide = { name: string; description?: string };

// SDK 1.x merges requestInit after its session/version headers. Overriding
// transport framing or those SDK-owned headers breaks the MCP connection.
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

export function assertAdditionalMcpHeader(name: string, protectedNames: readonly string[]): void {
  const lower = name.toLowerCase();
  if (
    !name ||
    name.length > 128 ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
    TRANSPORT_HEADERS.has(lower) ||
    protectedNames.some((entry) => entry.toLowerCase() === lower)
  ) {
    throw new ControlPlaneStateError(
      `MCP header ${name} is invalid or reserved by the connection policy`,
    );
  }
}

export function parseMcpHeaderGuides(
  value: unknown,
  protectedNames: readonly string[],
): McpHeaderGuide[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new ControlPlaneStateError("MCP header guides are invalid");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const guide = raw as { name?: unknown; description?: unknown } | null;
    const name = typeof guide?.name === "string" ? guide.name.trim() : "";
    const description = typeof guide?.description === "string" ? guide.description.trim() : "";
    assertAdditionalMcpHeader(name, protectedNames);
    if (
      seen.has(name.toLowerCase()) ||
      (guide?.description !== undefined && typeof guide.description !== "string") ||
      description.length > 512 ||
      description.includes("\0") ||
      description.includes("\r") ||
      description.includes("\n")
    ) {
      throw new ControlPlaneStateError("MCP header guide is invalid or duplicated");
    }
    seen.add(name.toLowerCase());
    const result: McpHeaderGuide = { name };
    if (description) {
      result.description = description;
    }
    return result;
  });
}
