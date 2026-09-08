// Formats ACP diagnostics and runtime error details for command replies.
import { formatAcpRuntimeErrorText } from "@openclaw/acp-core/runtime/error-text";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { resolveAcpAgentPolicyError } from "../../../acp/policy.js";
import { toAcpRuntimeError } from "../../../acp/runtime/errors.js";
import { diagnoseAcpProcessTransport } from "../../../acp/runtime/process-transport.js";
import { getAcpRuntimeBackend, requireAcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import { listAcpSessionEntries, readAcpSessionEntry } from "../../../acp/runtime/session-meta.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import { acpSessionBelongsToAgentScope, resolveAcpCommandAgentScope } from "./agent-scope.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { resolveAcpInstallCommandHint } from "./install-hints.js";
import {
  ACP_DOCTOR_USAGE,
  ACP_INSTALL_USAGE,
  ACP_SESSIONS_USAGE,
  formatAcpCapabilitiesText,
  stopWithText,
} from "./shared.js";
import { resolveBoundAcpThreadSessionKey } from "./targets.js";

const ACP_TRANSPORT_DIAGNOSTIC_MESSAGE_CHARS = 500;

function formatTransportDiagnosticField(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized
    ? sliceUtf16Safe(normalized, 0, ACP_TRANSPORT_DIAGNOSTIC_MESSAGE_CHARS)
    : fallback;
}

function isBackendPluginBlockedByAllowlist(params: {
  cfg: HandleCommandsParams["cfg"];
  backendId: string;
}): boolean {
  const allow = params.cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return false;
  }
  const normalizedBackendId = normalizeLowercaseStringOrEmpty(params.backendId);
  if (!normalizedBackendId) {
    return false;
  }
  return !allow.some(
    (pluginId) => normalizeLowercaseStringOrEmpty(pluginId) === normalizedBackendId,
  );
}

function shouldDeferRuntimeDoctorToIsolatedTarget(
  params: HandleCommandsParams,
  backend: ReturnType<typeof getAcpRuntimeBackend>,
): boolean {
  if (!resolveAcpCommandAgentScope(params) || !backend?.isolatesSandboxedRequesters) {
    return false;
  }
  try {
    return backend.isolatesSandboxedRequesters();
  } catch {
    return false;
  }
}

export async function handleAcpDoctorAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (restTokens.length > 1) {
    return stopWithText(`⚠️ ${ACP_DOCTOR_USAGE}`);
  }

  const backendId = normalizeOptionalString(params.cfg.acp?.backend) ?? "acpx";
  const installHint = resolveAcpInstallCommandHint(params.cfg);
  const registeredBackend = getAcpRuntimeBackend(backendId);
  const managerSnapshot = getAcpSessionManager().getObservabilitySnapshot();
  const lines = ["ACP doctor:", "-----", `configuredBackend: ${backendId}`];
  lines.push(`activeRuntimeSessions: ${managerSnapshot.runtimeCache.activeSessions}`);
  lines.push(`runtimeIdleTtlMs: ${managerSnapshot.runtimeCache.idleTtlMs}`);
  lines.push(`evictedIdleRuntimes: ${managerSnapshot.runtimeCache.evictedTotal}`);
  lines.push(`activeTurns: ${managerSnapshot.turns.active}`);
  lines.push(`queueDepth: ${managerSnapshot.turns.queueDepth}`);
  lines.push(
    `turnLatencyMs: avg=${managerSnapshot.turns.averageLatencyMs}, max=${managerSnapshot.turns.maxLatencyMs}`,
  );
  lines.push(
    `turnCounts: completed=${managerSnapshot.turns.completed}, failed=${managerSnapshot.turns.failed}`,
  );
  const errorStatsText =
    Object.entries(managerSnapshot.errorsByCode)
      .map(([code, count]) => `${code}=${count}`)
      .join(", ") || "(none)";
  lines.push(`errorCodes: ${errorStatsText}`);
  if (registeredBackend) {
    lines.push(`registeredBackend: ${registeredBackend.id}`);
  } else {
    lines.push("registeredBackend: (none)");
  }
  const backendBlockedByAllowlist = isBackendPluginBlockedByAllowlist({
    cfg: params.cfg,
    backendId,
  });
  if (backendBlockedByAllowlist) {
    lines.push(`pluginActivation: blocked (${backendId} is missing from plugins.allow)`);
  }

  const runtimeDoctorDeferred = shouldDeferRuntimeDoctorToIsolatedTarget(params, registeredBackend);
  let transportDiagnosticReady = false;
  if (runtimeDoctorDeferred) {
    // Browser attribution identifies a personal execution target. Probing the
    // Gateway host would test the wrong adapter and may trigger local installation.
    const executionOwnerAgentId = resolveAcpCommandAgentScope(params)!;
    const agent = normalizeLowercaseStringOrEmpty(restTokens[0] ?? params.cfg.acp?.defaultAgent);
    if (!agent) {
      lines.push("runtimeDoctor: deferred (isolated process transport)");
      lines.push("transportDiagnostic: unverified (no ACP agent selected)");
      lines.push("next: pass `/acp doctor <agent>` or configure `acp.defaultAgent`.");
    } else {
      const policyError = resolveAcpAgentPolicyError(params.cfg, agent);
      if (policyError) {
        lines.push(`transportDiagnostic: blocked (${policyError.message})`);
      } else {
        try {
          const report = await diagnoseAcpProcessTransport({
            executionOwnerAgentId,
            agent,
          });
          if (report) {
            transportDiagnosticReady = report.ok && report.stage === "ready";
            lines.push(
              `transportDiagnostic: ${report.ok ? "ok" : "error"} (${formatTransportDiagnosticField(report.message, "No diagnostic detail was provided.")})`,
            );
            lines.push(`transportStage: ${report.stage}`);
            lines.push(`transportCode: ${formatTransportDiagnosticField(report.code, "unknown")}`);
          } else {
            lines.push("transportDiagnostic: unverified (provider has no diagnostic hook)");
          }
        } catch {
          lines.push("transportDiagnostic: error (Assigned VM ACP diagnostic failed.)");
          lines.push("transportStage: routing");
          lines.push("transportCode: diagnostic_failed");
        }
      }
    }
  } else if (registeredBackend?.runtime.doctor) {
    try {
      const report = await registeredBackend.runtime.doctor();
      lines.push(`runtimeDoctor: ${report.ok ? "ok" : "error"} (${report.message})`);
      if (report.code) {
        lines.push(`runtimeDoctorCode: ${report.code}`);
      }
      if (report.installCommand) {
        lines.push(`runtimeDoctorInstall: ${report.installCommand}`);
      }
      for (const detail of report.details ?? []) {
        lines.push(`runtimeDoctorDetail: ${detail}`);
      }
    } catch (error) {
      lines.push(
        `runtimeDoctor: error (${
          toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "Runtime doctor failed.",
          }).message
        })`,
      );
    }
  }

  try {
    const backend = requireAcpRuntimeBackend(backendId);
    const capabilities = backend.runtime.getCapabilities
      ? await backend.runtime.getCapabilities({})
      : { controls: [] as string[], configOptionKeys: [] as string[] };
    lines.push(
      runtimeDoctorDeferred && !transportDiagnosticReady
        ? "healthy: unverified (isolated target is validated when an ACP session starts)"
        : "healthy: yes",
    );
    lines.push(`capabilities: ${formatAcpCapabilitiesText(capabilities.controls ?? [])}`);
    if ((capabilities.configOptionKeys?.length ?? 0) > 0) {
      lines.push(`configKeys: ${capabilities.configOptionKeys?.join(", ")}`);
    }
    if (runtimeDoctorDeferred && !transportDiagnosticReady) {
      lines.push("next: use /acp spawn <agent> to validate the personal execution target.");
    }
    return stopWithText(lines.join("\n"));
  } catch (error) {
    const acpError = toAcpRuntimeError({
      error,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP backend doctor failed.",
    });
    lines.push("healthy: no");
    lines.push(formatAcpRuntimeErrorText(acpError));
    if (backendBlockedByAllowlist) {
      lines.push(`next: add "${backendId}" to plugins.allow or unset plugins.allow.`);
    }
    lines.push(`next: ${installHint}`);
    lines.push(`next: openclaw config set plugins.entries.${backendId}.enabled true`);
    if (normalizeLowercaseStringOrEmpty(backendId) === "acpx") {
      lines.push("next: verify acpx is installed (`acpx --help`).");
    }
    return stopWithText(lines.join("\n"));
  }
}

export function handleAcpInstallAction(
  params: HandleCommandsParams,
  restTokens: string[],
): CommandHandlerResult {
  if (restTokens.length > 0) {
    return stopWithText(`⚠️ ${ACP_INSTALL_USAGE}`);
  }
  const backendId = normalizeOptionalString(params.cfg.acp?.backend) ?? "acpx";
  const installHint = resolveAcpInstallCommandHint(params.cfg);
  const lines = [
    "ACP install:",
    "-----",
    `configuredBackend: ${backendId}`,
    `run: ${installHint}`,
    `then: openclaw config set plugins.entries.${backendId}.enabled true`,
    "then: /acp doctor",
  ];
  return stopWithText(lines.join("\n"));
}

function formatAcpSessionLine(params: {
  key: string;
  entry: SessionEntry;
  acp: SessionAcpMeta;
  currentSessionKey?: string;
  threadId?: string;
}): string {
  const acp = params.acp;
  const marker = params.currentSessionKey === params.key ? "*" : " ";
  const label = normalizeOptionalString(params.entry.label) || acp.agent;
  const threadText = params.threadId ? `, thread:${params.threadId}` : "";
  return `${marker} ${label} (${acp.mode}, ${acp.state}, backend:${acp.backend}${threadText}) -> ${params.key}`;
}

export async function handleAcpSessionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (restTokens.length > 0) {
    return stopWithText(ACP_SESSIONS_USAGE);
  }

  const currentSessionKey = resolveBoundAcpThreadSessionKey(params) || params.sessionKey;
  if (!currentSessionKey) {
    return stopWithText("⚠️ Missing session key.");
  }

  const bindingContext = resolveAcpCommandBindingContext(params);
  const normalizedChannel = bindingContext.channel;
  const normalizedAccountId = bindingContext.accountId || undefined;
  const bindingService = getSessionBindingService();
  const currentEntry = params.command.senderIsOwner
    ? null
    : readAcpSessionEntry({ cfg: params.cfg, sessionKey: currentSessionKey });
  const agentScope = resolveAcpCommandAgentScope(params);
  const visibleEntries = agentScope
    ? (await listAcpSessionEntries({ cfg: params.cfg })).filter((stored) =>
        acpSessionBelongsToAgentScope({
          agentScope,
          entry: stored.entry,
          acp: stored.acp,
        }),
      )
    : params.command.senderIsOwner
      ? await listAcpSessionEntries({ cfg: params.cfg })
      : currentEntry?.entry && currentEntry.acp
        ? [currentEntry]
        : [];

  const rows = visibleEntries
    .toSorted((a, b) => (b.entry?.updatedAt ?? 0) - (a.entry?.updatedAt ?? 0))
    .slice(0, 20)
    .map(({ storeSessionKey, entry, acp }) => {
      if (!entry || !acp) {
        return "";
      }
      const bindingThreadId = bindingService
        .listBySession(storeSessionKey)
        .find(
          (binding) =>
            (!normalizedChannel || binding.conversation.channel === normalizedChannel) &&
            (!normalizedAccountId || binding.conversation.accountId === normalizedAccountId),
        )?.conversation.conversationId;
      return formatAcpSessionLine({
        key: storeSessionKey,
        entry,
        acp,
        currentSessionKey,
        threadId: bindingThreadId,
      });
    })
    .filter(Boolean);

  if (rows.length === 0) {
    return stopWithText("ACP sessions:\n-----\n(none)");
  }

  return stopWithText(["ACP sessions:", "-----", ...rows].join("\n"));
}
