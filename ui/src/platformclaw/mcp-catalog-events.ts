export const PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT = "platformclaw:mcp-catalog-changed";

export function notifyPlatformClawMcpCatalogChanged(): void {
  window.dispatchEvent(new Event(PLATFORMCLAW_MCP_CATALOG_CHANGED_EVENT));
}
