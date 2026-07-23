import {
  ControlPlaneConflictError,
  ControlPlaneStateError,
  type ControlPlaneIdFactory,
  type PersonalAgentBinding,
} from "./contracts.js";
import type {
  ControlPlaneExecutionManagementStore,
  SafeConnectEndpoint,
  VmAllocation,
  VmHost,
} from "./execution-contracts.js";
import {
  normalizeAdDomain,
  normalizeOpenSshHostKey,
  normalizeSafeConnectHost,
  normalizeVmTargetAddress,
} from "./execution-validation.js";
import { nextExecutionResourceId } from "./ids.js";

type InMemoryExecutionManagementStoreOptions = {
  idFactory: ControlPlaneIdFactory;
  requireAdmin(actorUserId: string): void;
  getPersonalBinding(agentId: string): PersonalAgentBinding | null;
  recordAudit(params: {
    actorUserId: string;
    eventType: string;
    targetType: string;
    targetId: string;
    createdAt: number;
    details?: Record<string, unknown>;
  }): void;
};

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ControlPlaneStateError(`${field} must not be empty`);
  }
  return normalized;
}

export class InMemoryExecutionManagementStore implements ControlPlaneExecutionManagementStore {
  private readonly endpoints = new Map<string, SafeConnectEndpoint>();
  private readonly endpointIdByAddress = new Map<string, string>();
  private readonly hosts = new Map<string, VmHost>();
  private readonly hostIdByTarget = new Map<string, string>();
  private readonly allocations = new Map<string, VmAllocation>();
  private readonly allocationIdByAgentBindingId = new Map<string, string>();
  private readonly allocationIdByLinuxAccount = new Map<string, string>();

  constructor(private readonly options: InMemoryExecutionManagementStoreOptions) {}

  async createSafeConnectEndpoint(params: {
    actorUserId: string;
    label: string;
    host: string;
    port: number;
    adDomain: string;
    createdAt: number;
  }): Promise<SafeConnectEndpoint> {
    this.options.requireAdmin(params.actorUserId);
    if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
      throw new ControlPlaneStateError("SafeConnect port must be an integer from 1 to 65535");
    }
    const host = normalizeSafeConnectHost(params.host);
    const addressKey = `${host}\0${params.port}`;
    if (this.endpointIdByAddress.has(addressKey)) {
      throw new ControlPlaneConflictError(
        "safeconnect_endpoint_conflict",
        `SafeConnect endpoint already exists: ${host}:${params.port}`,
      );
    }
    const endpoint: SafeConnectEndpoint = {
      id: nextExecutionResourceId(this.options.idFactory, "safeconnect-endpoint"),
      label: required(params.label, "endpoint.label"),
      host,
      port: params.port,
      adDomain: normalizeAdDomain(params.adDomain),
      status: "pending",
      createdByUserId: params.actorUserId,
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    };
    this.endpoints.set(endpoint.id, endpoint);
    this.endpointIdByAddress.set(addressKey, endpoint.id);
    this.options.recordAudit({
      actorUserId: params.actorUserId,
      eventType: "safeconnect.endpoint.created",
      targetType: "safeconnect-endpoint",
      targetId: endpoint.id,
      createdAt: params.createdAt,
    });
    return { ...endpoint };
  }

  async approveSafeConnectHostKey(params: {
    actorUserId: string;
    endpointId: string;
    algorithm: string;
    publicKey: string;
    fingerprint: string;
    approvedAt: number;
  }): Promise<SafeConnectEndpoint> {
    this.options.requireAdmin(params.actorUserId);
    const endpoint = this.endpoints.get(params.endpointId);
    if (!endpoint) {
      throw new ControlPlaneStateError(`SafeConnect endpoint not found: ${params.endpointId}`);
    }
    const hostKey = normalizeOpenSshHostKey({
      algorithm: params.algorithm,
      publicKey: params.publicKey,
      approvedFingerprint: params.fingerprint,
    });
    endpoint.hostKeyAlgorithm = hostKey.algorithm;
    endpoint.hostKeyPublicKey = hostKey.publicKey;
    endpoint.hostKeyFingerprint = hostKey.fingerprint;
    endpoint.hostKeyApprovedByUserId = params.actorUserId;
    endpoint.hostKeyApprovedAt = params.approvedAt;
    endpoint.status = "active";
    endpoint.updatedAt = params.approvedAt;
    this.options.recordAudit({
      actorUserId: params.actorUserId,
      eventType: "safeconnect.host-key.approved",
      targetType: "safeconnect-endpoint",
      targetId: endpoint.id,
      createdAt: params.approvedAt,
      details: { fingerprint: endpoint.hostKeyFingerprint },
    });
    return { ...endpoint };
  }

  async createVmHost(params: {
    actorUserId: string;
    endpointId: string;
    label: string;
    targetAddress: string;
    createdAt: number;
  }): Promise<VmHost> {
    this.options.requireAdmin(params.actorUserId);
    const endpoint = this.endpoints.get(params.endpointId);
    if (endpoint?.status !== "active") {
      throw new ControlPlaneStateError("VM host requires an active, pinned SafeConnect endpoint");
    }
    const targetAddress = normalizeVmTargetAddress(params.targetAddress);
    const targetKey = `${endpoint.id}\0${targetAddress}`;
    if (this.hostIdByTarget.has(targetKey)) {
      throw new ControlPlaneConflictError(
        "vm_host_conflict",
        `VM host already exists for endpoint and target: ${targetAddress}`,
      );
    }
    const host: VmHost = {
      id: nextExecutionResourceId(this.options.idFactory, "vm-host"),
      endpointId: endpoint.id,
      label: required(params.label, "vmHost.label"),
      targetAddress,
      status: "active",
      createdByUserId: params.actorUserId,
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    };
    this.hosts.set(host.id, host);
    this.hostIdByTarget.set(targetKey, host.id);
    this.options.recordAudit({
      actorUserId: params.actorUserId,
      eventType: "vm.host.created",
      targetType: "vm-host",
      targetId: host.id,
      createdAt: params.createdAt,
    });
    return { ...host };
  }

  async assignVmToPersonalAgent(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    assignedAt: number;
  }): Promise<VmAllocation> {
    this.options.requireAdmin(params.actorUserId);
    const binding = this.options.getPersonalBinding(params.agentId);
    if (!binding || binding.state !== "active") {
      throw new ControlPlaneStateError(`active personal agent not found: ${params.agentId}`);
    }
    const host = this.hosts.get(params.vmHostId);
    if (host?.status !== "active") {
      throw new ControlPlaneStateError(`active VM host not found: ${params.vmHostId}`);
    }
    if (this.allocationIdByAgentBindingId.has(binding.id)) {
      throw new ControlPlaneConflictError(
        "vm_allocation_conflict",
        `personal agent already has an active VM allocation: ${params.agentId}`,
      );
    }
    const linuxAccount = required(params.linuxAccount, "allocation.linuxAccount");
    const accountKey = `${host.id}\0${linuxAccount}`;
    if (this.allocationIdByLinuxAccount.has(accountKey)) {
      throw new ControlPlaneConflictError(
        "vm_allocation_conflict",
        `VM Linux account already has an active allocation: ${host.id}`,
      );
    }
    const allocation: VmAllocation = {
      id: nextExecutionResourceId(this.options.idFactory, "vm-allocation"),
      agentBindingId: binding.id,
      vmHostId: host.id,
      linuxAccount,
      status: "assigned",
      createdByUserId: params.actorUserId,
      createdAt: params.assignedAt,
      updatedAt: params.assignedAt,
    };
    this.allocations.set(allocation.id, allocation);
    this.allocationIdByAgentBindingId.set(binding.id, allocation.id);
    this.allocationIdByLinuxAccount.set(accountKey, allocation.id);
    this.options.recordAudit({
      actorUserId: params.actorUserId,
      eventType: "vm.allocation.created",
      targetType: "vm-allocation",
      targetId: allocation.id,
      createdAt: params.assignedAt,
      details: {
        agentBindingId: binding.id,
        vmHostId: host.id,
        linuxAccount,
      },
    });
    return { ...allocation };
  }

  async getVmAllocationForAgent(agentId: string): Promise<VmAllocation | null> {
    const binding = this.options.getPersonalBinding(agentId);
    const allocationId = binding ? this.allocationIdByAgentBindingId.get(binding.id) : undefined;
    const allocation = allocationId ? this.allocations.get(allocationId) : undefined;
    return allocation ? { ...allocation } : null;
  }
}
