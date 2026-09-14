/** Applies persisted ACP runtime metadata to agent runtime classification. */
import { isAcpSessionKey } from "../routing/session-key.js";

export type AgentRuntimeMetadata = {
  id: string;
  kind?: "acp";
  source: "implicit" | "model" | "provider" | "session" | "session-key";
};

export function applyAcpRuntimeOverlay(
  meta: AgentRuntimeMetadata,
  sessionKey: string | undefined | null,
  acpRuntime: boolean | undefined,
  acpBackend?: string,
): AgentRuntimeMetadata {
  if (acpRuntime !== true) {
    return meta;
  }
  const id = acpBackend && acpBackend.length > 0 ? acpBackend : "acpx";
  // ACP metadata is authoritative. Key shape only preserves the legacy source
  // label for existing ACP-keyed rows; it never identifies an ACP runtime.
  const source = isAcpSessionKey(sessionKey) ? "session-key" : "session";
  return { id, kind: "acp", source };
}
