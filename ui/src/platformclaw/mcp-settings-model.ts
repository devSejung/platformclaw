import type { McpCredentialMode, McpHeaderGuide, McpSecretDraft } from "./mcp-workspace.ts";

export type McpServerSetting = {
  serverName: string;
  origin: "organization";
  credentialMode: McpCredentialMode;
  auth?: "bearer" | "api_key" | "oauth";
  headerName?: string;
  scope?: string;
  globalEnabled: boolean;
  userEnabled: boolean;
  settingsRevision: number;
  policyFingerprint: string;
  configured: boolean;
  credentialStored: boolean;
  credentialFingerprint: string | null;
  headerGuides: McpHeaderGuide[];
  headers: Array<{ name: string; configured: true }>;
  headerError?: string;
};
export type HeaderDraft = {
  id: number;
  name: string;
  description?: string;
  guided: boolean;
  // Saved identity belongs to the original snapshot, never to an editable name.
  savedName?: string;
  value: McpSecretDraft;
};
export type SettingsDraft = {
  revision: number;
  policyFingerprint: string;
  credentialFingerprint: string | null;
  dirty: boolean;
  credential: McpSecretDraft;
  headers: HeaderDraft[];
  error: string;
  message: string;
};

export function createMcpSettingsDraft(
  server: McpServerSetting,
  nextId: () => number,
): SettingsDraft {
  const saved = new Map(server.headers.map((header) => [header.name.toLowerCase(), header.name]));
  const guided = new Set(server.headerGuides.map((header) => header.name.toLowerCase()));
  return {
    revision: server.settingsRevision,
    policyFingerprint: server.policyFingerprint,
    credentialFingerprint: server.credentialFingerprint,
    dirty: false,
    credential: server.configured ? { kind: "stored" } : { kind: "editing", value: "" },
    headers: [
      ...server.headerGuides.map(
        (guide): HeaderDraft => ({
          id: nextId(),
          ...guide,
          guided: true,
          savedName: saved.get(guide.name.toLowerCase()),
          value: saved.has(guide.name.toLowerCase())
            ? { kind: "stored" }
            : { kind: "editing", value: "" },
        }),
      ),
      ...server.headers
        .filter((header) => !guided.has(header.name.toLowerCase()))
        .map(
          (header): HeaderDraft => ({
            id: nextId(),
            name: header.name,
            savedName: header.name,
            guided: false,
            value: { kind: "stored" },
          }),
        ),
    ],
    error: "",
    message: "",
  };
}
