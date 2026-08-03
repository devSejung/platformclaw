import type {
  AssignedVmExecutionTarget,
  PersonalExecutionSettings,
  SafeConnectEndpoint,
  VmAllocation,
  VmAllocationStatus,
  VmHost,
} from "./execution-contracts.js";
import { parseVmHostExecutionEnvironmentJson } from "./execution-validation.js";
import type { SafeConnectEndpointRow, VmAllocationRow, VmHostRow } from "./sqlite-store-types.js";

type AssignedVmExecutionTargetRow = {
  allocation_id: string;
  credential_revision: number;
  vm_label: string;
  safeconnect_label: string;
  endpoint_host: string;
  endpoint_port: number;
  ad_domain: string;
  target_address: string;
  linux_account: string;
  remote_home_dir: string;
  remote_workspace_dir: string;
  host_key_algorithm: string;
  host_key_public_key: string;
  host_key_fingerprint: string;
  execution_environment_json: string | null;
};

export function rowToAssignedVmExecutionTarget(params: {
  agentId: string;
  userId: string;
  accountId: string;
  targetRevision: number;
  row: AssignedVmExecutionTargetRow;
}): AssignedVmExecutionTarget {
  const { row } = params;
  const executionEnvironment = parseVmHostExecutionEnvironmentJson(row.execution_environment_json);
  return {
    kind: "assigned_vm",
    agentId: params.agentId,
    userId: params.userId,
    targetId: row.allocation_id,
    revision: params.targetRevision,
    allocationId: row.allocation_id,
    credentialRevision: row.credential_revision,
    vmLabel: row.vm_label,
    safeConnectLabel: row.safeconnect_label,
    endpointHost: row.endpoint_host,
    endpointPort: row.endpoint_port,
    adDomain: row.ad_domain,
    adAccount: params.accountId,
    targetAddress: row.target_address,
    linuxAccount: row.linux_account,
    remoteHomeDir: row.remote_home_dir,
    remoteWorkspaceDir: row.remote_workspace_dir,
    hostKeyAlgorithm: row.host_key_algorithm,
    hostKeyPublicKey: row.host_key_public_key,
    hostKeyFingerprint: row.host_key_fingerprint,
    ...(executionEnvironment ? { executionEnvironment } : {}),
  };
}

export function rowToEndpoint(row: SafeConnectEndpointRow): SafeConnectEndpoint {
  return {
    id: row.id,
    label: row.label,
    host: row.host,
    port: row.port,
    adDomain: row.ad_domain,
    status: row.status,
    ...(row.host_key_algorithm ? { hostKeyAlgorithm: row.host_key_algorithm } : {}),
    ...(row.host_key_public_key ? { hostKeyPublicKey: row.host_key_public_key } : {}),
    ...(row.host_key_fingerprint ? { hostKeyFingerprint: row.host_key_fingerprint } : {}),
    ...(row.host_key_approved_by_user_id
      ? { hostKeyApprovedByUserId: row.host_key_approved_by_user_id }
      : {}),
    ...(row.host_key_approved_at === null ? {} : { hostKeyApprovedAt: row.host_key_approved_at }),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToVmHost(
  row: VmHostRow & { execution_environment_json?: string | null },
): VmHost {
  const executionEnvironment = parseVmHostExecutionEnvironmentJson(row.execution_environment_json);
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    label: row.label,
    targetAddress: row.target_address,
    status: row.status,
    ...(executionEnvironment ? { executionEnvironment } : {}),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToAllocation(row: VmAllocationRow): VmAllocation {
  return {
    id: row.id,
    agentBindingId: row.agent_binding_id,
    vmHostId: row.vm_host_id,
    linuxAccount: row.linux_account,
    status: row.status,
    ...(row.remote_home_dir ? { remoteHomeDir: row.remote_home_dir } : {}),
    ...(row.remote_workspace_dir ? { remoteWorkspaceDir: row.remote_workspace_dir } : {}),
    ...(row.last_connection_check_at === null
      ? {}
      : { lastConnectionCheckAt: row.last_connection_check_at }),
    ...(row.last_connection_succeeded_at === null
      ? {}
      : { lastConnectionSucceededAt: row.last_connection_succeeded_at }),
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

type PersonalExecutionSettingsRow = {
  agent_id: string;
  user_id: string | null;
  active_target: "platform_server" | "assigned_vm";
  target_revision: number;
  allocation_id: string | null;
  vm_host_id: string | null;
  allocation_status: VmAllocationStatus | null;
  linux_account: string | null;
  remote_home_dir: string | null;
  remote_workspace_dir: string | null;
  last_connection_check_at: number | null;
  last_connection_succeeded_at: number | null;
  failure_code: string | null;
  vm_label: string | null;
  safeconnect_label: string | null;
};

export function rowToPersonalExecutionSettings(
  row: PersonalExecutionSettingsRow,
): PersonalExecutionSettings | null {
  if (!row.user_id) {
    return null;
  }
  const base = {
    agentId: row.agent_id,
    userId: row.user_id,
    activeTarget: row.active_target,
    targetRevision: row.target_revision,
  };
  if (
    !row.allocation_id ||
    !row.vm_host_id ||
    !row.allocation_status ||
    !row.linux_account ||
    !row.vm_label ||
    !row.safeconnect_label
  ) {
    return base;
  }
  return {
    ...base,
    allocation: {
      id: row.allocation_id,
      vmHostId: row.vm_host_id,
      status: row.allocation_status,
      vmLabel: row.vm_label,
      safeConnectLabel: row.safeconnect_label,
      linuxAccount: row.linux_account,
      ...(row.remote_home_dir ? { remoteHomeDir: row.remote_home_dir } : {}),
      ...(row.remote_workspace_dir ? { remoteWorkspaceDir: row.remote_workspace_dir } : {}),
      ...(row.last_connection_check_at === null
        ? {}
        : { lastConnectionCheckAt: row.last_connection_check_at }),
      ...(row.last_connection_succeeded_at === null
        ? {}
        : { lastConnectionSucceededAt: row.last_connection_succeeded_at }),
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    },
  };
}
