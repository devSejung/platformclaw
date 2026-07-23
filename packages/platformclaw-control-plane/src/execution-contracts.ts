export type SafeConnectEndpointStatus = "pending" | "active" | "disabled";
export type VmHostStatus = "active" | "disabled";
export type VmAllocationStatus = "assigned" | "ready" | "connection_required" | "revoked";

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

export type ExecutionResourceKind = "safeconnect-endpoint" | "vm-host" | "vm-allocation";

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
}
