export type SafeConnectEndpointStatus = "pending" | "active" | "disabled";
export type VmHostStatus = "active" | "disabled";
export type VmAllocationStatus = "assigned" | "ready" | "connection_required" | "revoked";
export type { VmHostExecutionEnvironment } from "./execution-validation.js";
import type { VmHostExecutionEnvironment } from "./execution-validation.js";

export type SafeConnectEndpoint = {
  id: string;
  label: string;
  host: string;
  port: number;
  adDomain: string;
  status: SafeConnectEndpointStatus;
  hostKeyAlgorithm?: string;
  hostKeyPublicKey?: string;
  hostKeyFingerprint?: string;
  hostKeyApprovedByUserId?: string;
  hostKeyApprovedAt?: number;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type VmHost = {
  id: string;
  endpointId: string;
  label: string;
  targetAddress: string;
  status: VmHostStatus;
  executionEnvironment?: VmHostExecutionEnvironment;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
};

export type VmAllocation = {
  id: string;
  agentBindingId: string;
  vmHostId: string;
  linuxAccount: string;
  status: VmAllocationStatus;
  remoteHomeDir?: string;
  remoteWorkspaceDir?: string;
  lastConnectionCheckAt?: number;
  lastConnectionSucceededAt?: number;
  failureCode?: string;
  createdByUserId: string;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
};

export type ExecutionResourceKind =
  | "safeconnect-endpoint"
  | "vm-host"
  | "vm-allocation"
  | "ssh-credential";

export type PlatformServerExecutionTarget = {
  kind: "platform_server";
  agentId: string;
  userId: string;
  targetId: "platform-server";
  revision: number;
};

export type AssignedVmExecutionTarget = {
  kind: "assigned_vm";
  agentId: string;
  userId: string;
  targetId: string;
  revision: number;
  allocationId: string;
  credentialRevision: number;
  vmLabel: string;
  safeConnectLabel: string;
  endpointHost: string;
  endpointPort: number;
  adDomain: string;
  adAccount: string;
  targetAddress: string;
  linuxAccount: string;
  remoteHomeDir: string;
  remoteWorkspaceDir: string;
  hostKeyAlgorithm: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  executionEnvironment?: VmHostExecutionEnvironment;
};

export type PersonalExecutionTarget = PlatformServerExecutionTarget | AssignedVmExecutionTarget;

export type RoomExecutionTarget = Omit<PlatformServerExecutionTarget, "userId">;
export type ExecutionTarget = PersonalExecutionTarget | RoomExecutionTarget;

export type AssignedVmConnectionTarget = Omit<
  AssignedVmExecutionTarget,
  "credentialRevision" | "remoteHomeDir" | "remoteWorkspaceDir"
> & {
  allocationStatus: VmAllocationStatus;
  remoteHomeDir?: string;
  remoteWorkspaceDir?: string;
};

export type PersonalExecutionSettings = {
  agentId: string;
  userId: string;
  activeTarget: "platform_server" | "assigned_vm";
  targetRevision: number;
  allocation?: {
    id: string;
    vmHostId: string;
    status: VmAllocationStatus;
    vmLabel: string;
    safeConnectLabel: string;
    linuxAccount: string;
    remoteHomeDir?: string;
    remoteWorkspaceDir?: string;
    lastConnectionCheckAt?: number;
    lastConnectionSucceededAt?: number;
    failureCode?: string;
  };
};

export type AvailableVmHost = {
  id: string;
  label: string;
};

export type PersonalVmCatalog = {
  accountId: string;
  hosts: AvailableVmHost[];
};

export type VmAdministrationAgent = {
  userId: string;
  accountId: string;
  agentId: string;
  displayName?: string;
  department?: string;
  allocationId?: string;
};

export type VmAdministrationAllocation = VmAllocation & {
  agentId: string;
  accountId: string;
  displayName?: string;
  vmLabel: string;
};

export type VmAdministrationSnapshot = {
  endpoints: SafeConnectEndpoint[];
  hosts: VmHost[];
  agents: VmAdministrationAgent[];
  allocations: VmAdministrationAllocation[];
};

export interface ControlPlaneExecutionRuntimeStore {
  resolveExecutionTarget(agentId: string): Promise<ExecutionTarget>;
  resolvePersonalExecutionTarget(agentId: string): Promise<PersonalExecutionTarget>;
}

export interface ControlPlaneExecutionTargetStore extends ControlPlaneExecutionRuntimeStore {
  resolveAssignedVmConnectionTarget(agentId: string): Promise<AssignedVmConnectionTarget>;
  changePersonalExecutionTarget(params: {
    agentId: string;
    target: "platform_server" | "assigned_vm";
    expectedRevision: number;
    changedAt: number;
  }): Promise<PersonalExecutionTarget>;
}

export interface ControlPlaneEmployeeExecutionStore {
  getPersonalExecutionSettings(agentId: string): Promise<PersonalExecutionSettings | null>;
  recordVmConnectionResult(params: {
    actorUserId: string;
    agentId: string;
    expectedAllocationId: string;
    expectedTargetRevision: number;
    checkedAt: number;
    result:
      | { status: "ready"; remoteHomeDir: string; remoteWorkspaceDir: string }
      | { status: "connection_required"; failureCode: string };
  }): Promise<VmAllocation>;
}

export interface ControlPlaneExecutionManagementStore {
  createSafeConnectEndpoint(params: {
    actorUserId: string;
    label: string;
    host: string;
    port: number;
    adDomain: string;
    createdAt: number;
  }): Promise<SafeConnectEndpoint>;
  approveSafeConnectHostKey(params: {
    actorUserId: string;
    endpointId: string;
    algorithm: string;
    publicKey: string;
    fingerprint: string;
    approvedAt: number;
  }): Promise<SafeConnectEndpoint>;
  createVmHost(params: {
    actorUserId: string;
    endpointId: string;
    label: string;
    targetAddress: string;
    executionEnvironment?: VmHostExecutionEnvironment;
    createdAt: number;
  }): Promise<VmHost>;
  assignVmToPersonalAgent(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    assignedAt: number;
  }): Promise<VmAllocation>;
  getVmAllocationForAgent(agentId: string): Promise<VmAllocation | null>;
  getVmAdministrationSnapshot(actorUserId: string): Promise<VmAdministrationSnapshot>;
}

export interface ControlPlaneVmLifecycleStore {
  updateVmHostExecutionEnvironment(params: {
    actorUserId: string;
    vmHostId: string;
    executionEnvironment?: VmHostExecutionEnvironment;
    updatedAt: number;
  }): Promise<VmHost>;
  updateSafeConnectEndpoint(params: {
    actorUserId: string;
    endpointId: string;
    label: string;
    host: string;
    port: number;
    adDomain: string;
    updatedAt: number;
  }): Promise<SafeConnectEndpoint>;
  enableSafeConnectEndpoint(params: {
    actorUserId: string;
    endpointId: string;
    enabledAt: number;
  }): Promise<SafeConnectEndpoint>;
  disableSafeConnectEndpoint(params: {
    actorUserId: string;
    endpointId: string;
    disabledAt: number;
  }): Promise<SafeConnectEndpoint>;
  updateVmHost(params: {
    actorUserId: string;
    vmHostId: string;
    endpointId: string;
    label: string;
    targetAddress: string;
    updatedAt: number;
  }): Promise<VmHost>;
  enableVmHost(params: {
    actorUserId: string;
    vmHostId: string;
    enabledAt: number;
  }): Promise<VmHost>;
  disableVmHost(params: {
    actorUserId: string;
    vmHostId: string;
    disabledAt: number;
  }): Promise<VmHost>;
  revokeVmAllocationAsAdmin(params: {
    actorUserId: string;
    allocationId: string;
    revokedAt: number;
  }): Promise<VmAllocation>;
}

export interface ControlPlaneVmSelfServiceStore {
  getPersonalVmCatalog(params: {
    actorUserId: string;
    agentId: string;
  }): Promise<PersonalVmCatalog>;
  preparePersonalVmCandidate(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
  }): Promise<AssignedVmConnectionTarget>;
  replacePersonalVmAllocation(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    remoteHomeDir: string;
    remoteWorkspaceDir: string;
    replacedAt: number;
  }): Promise<VmAllocation>;
  releasePersonalVmAllocation(params: {
    actorUserId: string;
    agentId: string;
    releasedAt: number;
  }): Promise<VmAllocation>;
}

export interface ControlPlaneAtomicVmCredentialStore {
  commitPersonalVmSelection(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    remoteHomeDir: string;
    remoteWorkspaceDir: string;
    credentialEnvelope: SshCredentialEnvelope;
    committedAt: number;
  }): Promise<VmAllocation>;
  releasePersonalVmAccess(params: {
    actorUserId: string;
    agentId: string;
    releasedAt: number;
  }): Promise<VmAllocation | null>;
}
import type { SshCredentialEnvelope } from "./ssh-credential-contracts.js";
