import path from "node:path";
import { parseCodingAgentConfiguration } from "@platformclaw/coding-agent-contract";
import type { PlatformClawExecutionTargetSnapshot } from "./backend.js";
import { parseExecutionEnvironment, requireString } from "./execution-target-validation.js";

function requireSshToken(value: unknown, label: string): string {
  const token = requireString(value, label);
  if (/\s/u.test(token)) {
    throw new Error(`${label} is invalid`);
  }
  return token;
}

function requireAbsoluteRemotePath(value: unknown, label: string): string {
  const raw = requireString(value, label);
  const normalized = path.posix.normalize(raw);
  if (!path.posix.isAbsolute(raw) || normalized !== raw) {
    throw new Error(`${label} is invalid`);
  }
  return raw;
}

export function parseTarget(
  value: unknown,
  options: { allowMissingCredentialRevision?: boolean } = {},
): PlatformClawExecutionTargetSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("execution target is invalid");
  }
  const target = value as Record<string, unknown>;
  const base = {
    kind: target.kind,
    agentId: requireString(target.agentId, "agent id"),
    targetId: requireString(target.targetId, "target id"),
    revision: Number(target.revision),
  };
  if (target.kind === "platform_server") {
    return base as PlatformClawExecutionTargetSnapshot;
  }
  if (target.kind !== "assigned_vm") {
    throw new Error("execution target kind is invalid");
  }
  const credentialRevision = Number(target.credentialRevision ?? 0);
  if (
    !Number.isSafeInteger(credentialRevision) ||
    credentialRevision < (options.allowMissingCredentialRevision ? 0 : 1)
  ) {
    throw new Error("credential revision is invalid");
  }
  const remoteHomeDir = requireAbsoluteRemotePath(target.remoteHomeDir, "remote home");
  const remoteWorkspaceDir = requireAbsoluteRemotePath(
    target.remoteWorkspaceDir,
    "remote workspace",
  );
  if (
    remoteHomeDir !== "/" &&
    remoteWorkspaceDir !== remoteHomeDir &&
    !remoteWorkspaceDir.startsWith(`${remoteHomeDir}/`)
  ) {
    throw new Error("remote workspace is outside the remote home");
  }
  if (!Array.isArray(target.codingAgents)) {
    throw new Error("coding agent configurations are invalid");
  }
  const codingAgents = target.codingAgents.map(parseCodingAgentConfiguration);
  if (codingAgents.length !== 3 || new Set(codingAgents.map((entry) => entry.agent)).size !== 3) {
    throw new Error("coding agent configurations are incomplete");
  }
  return {
    ...base,
    kind: "assigned_vm",
    allocationId: requireString(target.allocationId, "allocation id"),
    credentialRevision,
    vmLabel: requireString(target.vmLabel, "VM label"),
    safeConnectLabel: requireString(target.safeConnectLabel, "SafeConnect label"),
    endpointHost: requireSshToken(target.endpointHost, "endpoint host"),
    endpointPort: Number(target.endpointPort),
    adDomain: requireSshToken(target.adDomain, "AD domain"),
    adAccount: requireSshToken(target.adAccount, "AD account"),
    targetAddress: requireSshToken(target.targetAddress, "VM address"),
    linuxAccount: requireSshToken(target.linuxAccount, "Linux account"),
    remoteHomeDir,
    remoteWorkspaceDir,
    hostKeyAlgorithm: requireSshToken(target.hostKeyAlgorithm, "host key algorithm"),
    hostKeyPublicKey: requireSshToken(target.hostKeyPublicKey, "host public key"),
    hostKeyFingerprint: requireString(target.hostKeyFingerprint, "host key fingerprint"),
    ...(target.executionEnvironment === undefined
      ? {}
      : { executionEnvironment: parseExecutionEnvironment(target.executionEnvironment) }),
    codingAgents,
  };
}
