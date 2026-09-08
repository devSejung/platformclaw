import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
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
}): boolean {
  const agentScope = normalizeLowercaseStringOrEmpty(params.agentScope);
  const executionOwner = normalizeLowercaseStringOrEmpty(params.acp?.executionOwnerAgentId);
  if (executionOwner) {
    return executionOwner === agentScope;
  }
  for (const key of [params.entry?.spawnedBy, params.entry?.parentSessionKey]) {
    if (key && resolveAgentIdFromSessionKey(key) === agentScope) {
      return true;
    }
  }
  return false;
}
