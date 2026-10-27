// Resolves ACP command target sessions from user text and active state.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import { readAcpSessionEntry } from "../../../acp/runtime/session-meta.js";
import { callGateway } from "../../../gateway/call.js";
import { SESSION_ID_RE } from "../../../sessions/session-id.js";
import { resolvePersonalAgentCommandScope } from "../../sender-identity.js";
import { resolveEffectiveResetTargetSessionKey } from "../acp-reset-target.js";
import { resolveRequesterSessionKey } from "../commands-subagents/shared.js";
import type { HandleCommandsParams } from "../commands-types.js";
import {
  acpSessionBelongsToAgentScope,
  resolveAcpCommandAgentScope,
  supportsAcpAgentScope,
} from "./agent-scope.js";
import { resolveAcpCommandBindingContext } from "./context.js";

function scopeResolvedTarget(
  commandParams: HandleCommandsParams,
  sessionKey: string,
  allowUnavailableBackendForCleanup = false,
): { ok: true; sessionKey: string } | { ok: false; error: string } {
  const agentScope = resolveAcpCommandAgentScope(commandParams);
  if (!agentScope) {
    return { ok: true, sessionKey };
  }
  const personalAgentScope = resolvePersonalAgentCommandScope(commandParams.ctx);
  const stored = readAcpSessionEntry({ cfg: commandParams.cfg, sessionKey, clone: false });
  if (
    !stored ||
    !acpSessionBelongsToAgentScope({
      agentScope,
      entry: stored.entry,
      acp: stored.acp,
      requireExecutionOwner: Boolean(personalAgentScope),
    })
  ) {
    return { ok: false, error: "ACP session is outside this personal agent boundary." };
  }
  if (personalAgentScope) {
    const backend = getAcpRuntimeBackend(stored.acp?.backend ?? commandParams.cfg.acp?.backend);
    if (!(allowUnavailableBackendForCleanup && !backend) && !supportsAcpAgentScope(backend)) {
      return {
        ok: false,
        error:
          "The personal ACP session's isolated runtime is unavailable. Ask a Gateway administrator to restore it and retry.",
      };
    }
  }
  return { ok: true, sessionKey };
}

async function resolveSessionKeyByToken(token: string): Promise<string | null> {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const attempts: Array<Record<string, string>> = [{ key: trimmed }];
  if (SESSION_ID_RE.test(trimmed)) {
    attempts.push({ sessionId: trimmed });
  }
  attempts.push({ label: trimmed });

  for (const params of attempts) {
    try {
      const resolved = await callGateway({
        method: "sessions.resolve",
        params,
        timeoutMs: 8_000,
      });
      const key = normalizeOptionalString(resolved?.key) ?? "";
      if (key) {
        return key;
      }
    } catch {
      // Try next resolver strategy.
    }
  }
  return null;
}

export function resolveBoundAcpThreadSessionKey(params: HandleCommandsParams): string | undefined {
  const commandTargetSessionKey = normalizeOptionalString(params.ctx.CommandTargetSessionKey) ?? "";
  const activeSessionKey =
    commandTargetSessionKey || (normalizeOptionalString(params.sessionKey) ?? "");
  const bindingContext = resolveAcpCommandBindingContext(params);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    parentConversationId: bindingContext.parentConversationId,
    activeSessionKey,
    allowNonAcpBindingSessionKey: true,
    skipConfiguredFallbackWhenActiveSessionNonAcp: false,
  });
}

export async function resolveAcpTargetSessionKey(params: {
  commandParams: HandleCommandsParams;
  token?: string;
  /** Existing cancel/close cleanup may retire an owned record without a backend. */
  allowUnavailableBackendForCleanup?: boolean;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; error: string }> {
  const token = normalizeOptionalString(params.token) ?? "";
  if (token) {
    const resolved = await resolveSessionKeyByToken(token);
    if (resolved) {
      const scoped = scopeResolvedTarget(
        params.commandParams,
        resolved,
        params.allowUnavailableBackendForCleanup,
      );
      return scoped.ok
        ? scoped
        : { ok: false, error: `Unable to resolve session target: ${token}` };
    }
    // Token was supplied but could not be resolved as a session key/id/label.
    // Fall through to thread-bound resolution so that callers that auto-fill
    // the current thread ID as the token (e.g. Discord slash commands) still
    // reach the correct session via the binding context.
  }

  const threadBound = resolveBoundAcpThreadSessionKey(params.commandParams);
  if (threadBound) {
    return scopeResolvedTarget(
      params.commandParams,
      threadBound,
      params.allowUnavailableBackendForCleanup,
    );
  }

  if (token) {
    return {
      ok: false,
      error: `Unable to resolve session target: ${token}`,
    };
  }

  const fallback = resolveRequesterSessionKey(params.commandParams, {
    preferCommandTarget: true,
  });
  if (!fallback) {
    return {
      ok: false,
      error: "Missing session key.",
    };
  }
  return scopeResolvedTarget(
    params.commandParams,
    fallback,
    params.allowUnavailableBackendForCleanup,
  );
}
