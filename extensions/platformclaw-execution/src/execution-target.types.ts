import type { CodingAgentConfiguration } from "@platformclaw/coding-agent-contract";

type ExecutionTargetBase = {
  agentId: string;
  revision: number;
  targetId: string;
};

export type PlatformServerTargetSnapshot = ExecutionTargetBase & {
  kind: "platform_server";
};

export type AssignedVmTargetSnapshot = ExecutionTargetBase & {
  kind: "assigned_vm";
  allocationId: string;
  credentialRevision: number;
  vmLabel: string;
  safeConnectLabel: string;
  remoteHomeDir: string;
  remoteWorkspaceDir: string;
  endpointHost: string;
  endpointPort: number;
  adDomain: string;
  adAccount: string;
  targetAddress: string;
  linuxAccount: string;
  hostKeyAlgorithm: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  executionEnvironment?: {
    pathPrepend: readonly string[];
    variables: Readonly<Record<string, string>>;
  };
  codingAgents: readonly CodingAgentConfiguration[];
};

export type PlatformClawExecutionTargetSnapshot =
  | PlatformServerTargetSnapshot
  | AssignedVmTargetSnapshot;
