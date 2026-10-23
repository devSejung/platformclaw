import type { McpCredentialMode, McpHeaderGuide, McpSecretDraft } from "./mcp-workspace.ts";

export type AdminMcpServer = {
  name: string;
  enabled: boolean;
  transport: "sse" | "streamable-http" | "stdio" | "invalid";
  target: string;
  editable: boolean;
  credentialMode: McpCredentialMode;
  personalAuth?: "bearer" | "api_key" | "oauth";
  sharedAuth?: "bearer" | "api_key";
  sharedConfigured: boolean;
  headerName?: string;
  scope?: string;
  headerGuides: McpHeaderGuide[];
  toolPolicy: "all" | "blocked" | "allowlist" | "custom";
  blockedTools: string[];
};
export type AdminMcpDraft = {
  name: string;
  url: string;
  transport: "sse" | "streamable-http";
  credentialMode: McpCredentialMode;
  auth: "bearer" | "api_key" | "oauth";
  headerName: string;
  scope: string;
  secret: McpSecretDraft;
  blockedTools: string;
  headerGuides: McpHeaderGuide[];
  error: string;
  message: string;
};

export function createAdminMcpDraft(server?: AdminMcpServer): AdminMcpDraft {
  return {
    name: server?.name ?? "",
    url: server?.target ?? "",
    transport: server?.transport === "sse" ? "sse" : "streamable-http",
    credentialMode: server?.credentialMode ?? "none",
    auth: server?.personalAuth ?? server?.sharedAuth ?? "bearer",
    headerName: server?.headerName ?? "X-API-Key",
    scope: server?.scope ?? "",
    secret: server?.sharedConfigured ? { kind: "stored" } : { kind: "editing", value: "" },
    blockedTools: server?.blockedTools.join("\n") ?? "",
    headerGuides: server?.headerGuides.map((guide) => ({ ...guide })) ?? [],
    error: "",
    message: "",
  };
}

export function canPreserveSharedMcpSecret(
  server: AdminMcpServer | undefined,
  draft: AdminMcpDraft,
): boolean {
  let url: string;
  try {
    url = new URL(draft.url).toString();
  } catch {
    return false;
  }
  return (
    server?.credentialMode === "shared" &&
    server.sharedConfigured &&
    url === server.target &&
    draft.credentialMode === "shared" &&
    draft.auth === server.sharedAuth &&
    (draft.auth === "bearer" || draft.headerName.toLowerCase() === server.headerName?.toLowerCase())
  );
}
