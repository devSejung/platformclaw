import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import type { SessionAcpMeta, SessionEntry } from "../../../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import type { HandleCommandsParams } from "../commands-types.js";

/** Returns the personal-agent boundary asserted by a privileged browser proxy. */
export function resolveAcpCommandAgentScope(params: HandleCommandsParams): string | undefined {
  const scope = normalizeLowercaseStringOrEmpty(params.ctx.SenderAgentId);
  return scope || undefined;
}

/** Keeps attributed browser users inside ACP sessions owned by their personal agent. */
export function acpSessionBelongsToAgentScope(params: {
  agentScope: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  requireExecutionOwner?: boolean;
}): boolean {
  const agentScope = normalizeLowercaseStringOrEmpty(params.agentScope);
  const executionOwner = normalizeLowercaseStringOrEmpty(params.acp?.executionOwnerAgentId);
  if (executionOwner) {
    return executionOwner === agentScope;
  }
  if (params.requireExecutionOwner) {
    return false;
  }
  for (const key of [params.entry?.spawnedBy, params.entry?.parentSessionKey]) {
    if (key && resolveAgentIdFromSessionKey(key) === agentScope) {
      return true;
    }
  }
  return false;
}

/** An attributed execution owner must never fall back to a Gateway-host runtime. */
export function supportsAcpAgentScope(backend: AcpRuntimeBackend | null): boolean {
  try {
    return backend?.isolatesSandboxedRequesters?.() === true;
  } catch {
    return false;
  }
}
