// Manages exec approval policy, allowlist entries, and host targeting.
import {
  normalizeExecApprovalsInternal,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsSocketPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsDefaultOverrides } from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile, ExecApprovalsResolved } from "./exec-approvals-core.js";
import { resolveExecApprovalsFromFilePrepared } from "./exec-approvals-resolver.js";
import { ensureExecApprovalsSnapshot, loadExecApprovals } from "./exec-approvals-store.js";
import { expandHomePrefix } from "./home-dir.js";

export * from "./exec-approvals-analysis.js";
export * from "./exec-approvals-allowlist.js";
export * from "./exec-approvals-core.js";
export type { ExecApprovalPolicySnapshot } from "./exec-approval-policy-snapshot.js";
export type { ExecAllowlistEntry } from "./exec-approvals.types.js";
export {
  DEFAULT_EXEC_APPROVAL_ASK_FALLBACK,
  mergeExecApprovalsSocketDefaults,
  resolveExecApprovalsDisplayPath,
  resolveExecApprovalsTranscriptPath,
} from "./exec-approvals-config.js";
export {
  ensureExecApprovalsSnapshot,
  loadExecApprovals,
  loadExecApprovalsAsync,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  updateExecApprovals,
  withAgentExecApprovalsRemoved,
} from "./exec-approvals-store.js";

export function normalizeExecApprovals(file: ExecApprovalsFile): ExecApprovalsFile {
  const socketPath = file.socket?.path?.trim();
  const token = file.socket?.token?.trim();
  return normalizeExecApprovalsInternal({
    ...file,
    socket: { path: socketPath, token },
  });
}

function shapeResolvedExecApprovals(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  socket: "none" | "persisted";
}): ExecApprovalsResolved {
  const defaultSocketPath = resolveExecApprovalsSocketPath();
  return resolveExecApprovalsFromFile({
    file: params.file,
    agentId: params.agentId,
    overrides: params.overrides,
    path: params.filePath,
    socketPath:
      params.socket === "persisted"
        ? expandHomePrefix(params.file.socket?.path ?? defaultSocketPath)
        : defaultSocketPath,
    token: params.socket === "persisted" ? (params.file.socket?.token ?? "") : "",
  });
}

function resolveExecApprovalsWithoutSocket(params: {
  file: ExecApprovalsFile;
  filePath: string;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
}): ExecApprovalsResolved | null {
  const resolved = shapeResolvedExecApprovals({ ...params, socket: "none" });
  const noPrompt =
    (resolved.agent.security === "full" || resolved.agent.security === "deny") &&
    resolved.agent.ask === "off";
  return noPrompt && !params.file.socket?.token?.trim() ? resolved : null;
}

export async function resolveExecApprovalsLocked(
  agentId?: string,
  overrides?: ExecApprovalsDefaultOverrides,
): Promise<ExecApprovalsResolved> {
  const filePath = resolveExecApprovalsDisplayPath();
  if (!overrides?.requireSocket) {
    const file = loadExecApprovals();
    const resolved = resolveExecApprovalsWithoutSocket({
      file,
      filePath,
      agentId,
      overrides,
    });
    if (resolved) {
      return resolved;
    }
  }
  return shapeResolvedExecApprovals({
    file: (await ensureExecApprovalsSnapshot()).file,
    filePath: resolveExecApprovalsDisplayPath(),
    agentId,
    overrides,
    socket: "persisted",
  });
}

export function resolveExecApprovalsFromFile(params: {
  file: ExecApprovalsFile;
  agentId?: string;
  overrides?: ExecApprovalsDefaultOverrides;
  path?: string;
  socketPath?: string;
  token?: string;
}): ExecApprovalsResolved {
  const rawFile = params.file;
  const file = normalizeExecApprovals(params.file);
  return resolveExecApprovalsFromFilePrepared({
    ...params,
    rawFile,
    file,
    token: params.token ?? file.socket?.token ?? "",
  });
}

export {
  commandRequiresSecurityAuditSuppressionApproval,
  maxAsk,
  minSecurity,
  normalizeExecApprovalUnavailableDecisions,
  requiresExecApproval,
  resolveExecApprovalAllowedDecisions,
  resolveExecApprovalRequestAllowedDecisions,
  resolveExecApprovalUnavailableDecisions,
} from "./exec-approvals-policy.js";
export {
  createExecApprovalPolicySnapshot,
  hasDurableExecApproval,
  hasExactCommandDurableExecApproval,
  hasNodeCommandAllowAlwaysMarker,
  isExecApprovalPolicySnapshotCurrent,
  resolveAllowAlwaysPatternCoverage,
  resolveAllowAlwaysPersistenceDecision,
  resolveDurableExecApprovalRequirement,
} from "./exec-approvals-allow-always.js";
export type { AllowAlwaysPersistenceDecision } from "./exec-approvals-contracts.js";
export { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
export type { ExecApprovalUsageAuthorization } from "./exec-approvals-authorization.js";
