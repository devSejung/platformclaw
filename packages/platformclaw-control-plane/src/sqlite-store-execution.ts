import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import type {
  ControlPlaneExecutionManagementStore,
  ControlPlaneExecutionRuntimeStore,
  PersonalExecutionTarget,
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
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { SqliteControlPlaneAuthStore } from "./sqlite-store-auth.js";
import { required } from "./sqlite-store-core.js";
import type { SafeConnectEndpointRow, VmAllocationRow, VmHostRow } from "./sqlite-store-types.js";

function rowToEndpoint(row: SafeConnectEndpointRow): SafeConnectEndpoint {
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

function rowToVmHost(row: VmHostRow): VmHost {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    label: row.label,
    targetAddress: row.target_address,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAllocation(row: VmAllocationRow): VmAllocation {
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

export abstract class SqliteControlPlaneExecutionStore
  extends SqliteControlPlaneAuthStore
  implements ControlPlaneExecutionManagementStore, ControlPlaneExecutionRuntimeStore
{
  async resolvePersonalExecutionTarget(agentId: string): Promise<PersonalExecutionTarget> {
    const owner = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .innerJoin(
          "personal_execution_profiles",
          "personal_execution_profiles.agent_binding_id",
          "agent_bindings.id",
        )
        .select([
          "agent_bindings.id as binding_id",
          "agent_bindings.agent_id as agent_id",
          "agent_bindings.state as binding_state",
          "platform_users.id as user_id",
          "platform_users.account_id as account_id",
          "platform_users.status as user_status",
          "personal_execution_profiles.active_target as active_target",
          "personal_execution_profiles.active_allocation_id as active_allocation_id",
          "personal_execution_profiles.target_revision as target_revision",
        ])
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal"),
    );
    if (!owner || owner.binding_state !== "active" || owner.user_status !== "active") {
      throw new ControlPlaneStateError("active personal execution target is unavailable");
    }
    if (owner.active_target === "platform_server") {
      return {
        kind: "platform_server",
        agentId: owner.agent_id,
        userId: owner.user_id,
        targetId: "platform-server",
        revision: owner.target_revision,
      };
    }
    if (!owner.active_allocation_id) {
      throw new ControlPlaneStateError("assigned VM execution target is incomplete");
    }
    const vm = takeFirstSync(
      this.db,
      this.query
        .selectFrom("vm_allocations")
        .innerJoin("vm_hosts", "vm_hosts.id", "vm_allocations.vm_host_id")
        .innerJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
        .select([
          "vm_allocations.id as allocation_id",
          "vm_allocations.agent_binding_id as agent_binding_id",
          "vm_allocations.status as allocation_status",
          "vm_allocations.linux_account as linux_account",
          "vm_allocations.remote_workspace_dir as remote_workspace_dir",
          "vm_hosts.status as host_status",
          "vm_hosts.target_address as target_address",
          "safeconnect_endpoints.status as endpoint_status",
          "safeconnect_endpoints.host as endpoint_host",
          "safeconnect_endpoints.port as endpoint_port",
          "safeconnect_endpoints.ad_domain as ad_domain",
          "safeconnect_endpoints.host_key_algorithm as host_key_algorithm",
          "safeconnect_endpoints.host_key_public_key as host_key_public_key",
          "safeconnect_endpoints.host_key_fingerprint as host_key_fingerprint",
        ])
        .where("vm_allocations.id", "=", owner.active_allocation_id),
    );
    if (
      !vm ||
      vm.agent_binding_id !== owner.binding_id ||
      vm.allocation_status !== "ready" ||
      vm.host_status !== "active" ||
      vm.endpoint_status !== "active" ||
      !vm.remote_workspace_dir ||
      !vm.host_key_algorithm ||
      !vm.host_key_public_key ||
      !vm.host_key_fingerprint
    ) {
      throw new ControlPlaneStateError("assigned VM execution target is not ready");
    }
    return {
      kind: "assigned_vm",
      agentId: owner.agent_id,
      userId: owner.user_id,
      targetId: vm.allocation_id,
      revision: owner.target_revision,
      allocationId: vm.allocation_id,
      endpointHost: vm.endpoint_host,
      endpointPort: vm.endpoint_port,
      adDomain: vm.ad_domain,
      adAccount: owner.account_id,
      targetAddress: vm.target_address,
      linuxAccount: vm.linux_account,
      remoteWorkspaceDir: vm.remote_workspace_dir,
      hostKeyAlgorithm: vm.host_key_algorithm,
      hostKeyPublicKey: vm.host_key_public_key,
      hostKeyFingerprint: vm.host_key_fingerprint,
    };
  }

  async createSafeConnectEndpoint(params: {
    actorUserId: string;
    label: string;
    host: string;
    port: number;
    adDomain: string;
    createdAt: number;
  }): Promise<SafeConnectEndpoint> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
        throw new ControlPlaneStateError("SafeConnect port must be an integer from 1 to 65535");
      }
      const host = normalizeSafeConnectHost(params.host);
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .select("id")
          .where("host", "=", host)
          .where("port", "=", params.port),
      );
      if (existing) {
        throw new ControlPlaneConflictError(
          "safeconnect_endpoint_conflict",
          `SafeConnect endpoint already exists: ${host}:${params.port}`,
        );
      }
      const row: SafeConnectEndpointRow = {
        id: nextExecutionResourceId(this.idFactory, "safeconnect-endpoint"),
        label: required(params.label, "endpoint.label"),
        host,
        port: params.port,
        ad_domain: normalizeAdDomain(params.adDomain),
        status: "pending",
        host_key_algorithm: null,
        host_key_public_key: null,
        host_key_fingerprint: null,
        host_key_approved_by_user_id: null,
        host_key_approved_at: null,
        created_by_user_id: params.actorUserId,
        created_at: params.createdAt,
        updated_at: params.createdAt,
      };
      executeSync(this.db, this.query.insertInto("safeconnect_endpoints").values(row));
      this.insertAudit(
        params.actorUserId,
        "safeconnect.endpoint.created",
        "safeconnect-endpoint",
        row.id,
        params.createdAt,
      );
      return rowToEndpoint(row);
    });
  }

  async approveSafeConnectHostKey(params: {
    actorUserId: string;
    endpointId: string;
    algorithm: string;
    publicKey: string;
    fingerprint: string;
    approvedAt: number;
  }): Promise<SafeConnectEndpoint> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .selectAll()
          .where("id", "=", params.endpointId),
      );
      if (!current) {
        throw new ControlPlaneStateError(`SafeConnect endpoint not found: ${params.endpointId}`);
      }
      const hostKey = normalizeOpenSshHostKey({
        algorithm: params.algorithm,
        publicKey: params.publicKey,
        approvedFingerprint: params.fingerprint,
      });
      executeSync(
        this.db,
        this.query
          .updateTable("safeconnect_endpoints")
          .set({
            status: "active",
            host_key_algorithm: hostKey.algorithm,
            host_key_public_key: hostKey.publicKey,
            host_key_fingerprint: hostKey.fingerprint,
            host_key_approved_by_user_id: params.actorUserId,
            host_key_approved_at: params.approvedAt,
            updated_at: params.approvedAt,
          })
          .where("id", "=", current.id),
      );
      this.insertAudit(
        params.actorUserId,
        "safeconnect.host-key.approved",
        "safeconnect-endpoint",
        current.id,
        params.approvedAt,
        { fingerprint: hostKey.fingerprint },
      );
      return rowToEndpoint(
        takeFirstSync(
          this.db,
          this.query.selectFrom("safeconnect_endpoints").selectAll().where("id", "=", current.id),
        )!,
      );
    });
  }

  async createVmHost(params: {
    actorUserId: string;
    endpointId: string;
    label: string;
    targetAddress: string;
    createdAt: number;
  }): Promise<VmHost> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const endpoint = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .selectAll()
          .where("id", "=", params.endpointId),
      );
      if (endpoint?.status !== "active") {
        throw new ControlPlaneStateError("VM host requires an active, pinned SafeConnect endpoint");
      }
      const targetAddress = normalizeVmTargetAddress(params.targetAddress);
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_hosts")
          .select("id")
          .where("endpoint_id", "=", endpoint.id)
          .where("target_address", "=", targetAddress),
      );
      if (existing) {
        throw new ControlPlaneConflictError(
          "vm_host_conflict",
          `VM host already exists for endpoint and target: ${targetAddress}`,
        );
      }
      const row: VmHostRow = {
        id: nextExecutionResourceId(this.idFactory, "vm-host"),
        endpoint_id: endpoint.id,
        label: required(params.label, "vmHost.label"),
        target_address: targetAddress,
        status: "active",
        created_by_user_id: params.actorUserId,
        created_at: params.createdAt,
        updated_at: params.createdAt,
      };
      executeSync(this.db, this.query.insertInto("vm_hosts").values(row));
      this.insertAudit(params.actorUserId, "vm.host.created", "vm-host", row.id, params.createdAt);
      return rowToVmHost(row);
    });
  }

  async assignVmToPersonalAgent(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    assignedAt: number;
  }): Promise<VmAllocation> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const binding = takeFirstSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .selectAll()
          .where("agent_id", "=", params.agentId)
          .where("kind", "=", "personal"),
      );
      if (!binding || binding.state !== "active") {
        throw new ControlPlaneStateError(`active personal agent not found: ${params.agentId}`);
      }
      const host = takeFirstSync(
        this.db,
        this.query.selectFrom("vm_hosts").selectAll().where("id", "=", params.vmHostId),
      );
      if (host?.status !== "active") {
        throw new ControlPlaneStateError(`active VM host not found: ${params.vmHostId}`);
      }
      const linuxAccount = required(params.linuxAccount, "allocation.linuxAccount");
      const agentAllocation = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations")
          .select("id")
          .where("agent_binding_id", "=", binding.id)
          .where("status", "!=", "revoked"),
      );
      const accountAllocation = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations")
          .select("id")
          .where("vm_host_id", "=", host.id)
          .where("linux_account", "=", linuxAccount)
          .where("status", "!=", "revoked"),
      );
      if (agentAllocation || accountAllocation) {
        throw new ControlPlaneConflictError(
          "vm_allocation_conflict",
          "personal agent or VM Linux account already has an active allocation",
        );
      }
      const row: VmAllocationRow = {
        id: nextExecutionResourceId(this.idFactory, "vm-allocation"),
        agent_binding_id: binding.id,
        vm_host_id: host.id,
        linux_account: linuxAccount,
        status: "assigned",
        remote_home_dir: null,
        remote_workspace_dir: null,
        last_connection_check_at: null,
        last_connection_succeeded_at: null,
        failure_code: null,
        created_by_user_id: params.actorUserId,
        created_at: params.assignedAt,
        updated_at: params.assignedAt,
        revoked_at: null,
      };
      executeSync(this.db, this.query.insertInto("vm_allocations").values(row));
      this.insertAudit(
        params.actorUserId,
        "vm.allocation.created",
        "vm-allocation",
        row.id,
        params.assignedAt,
        { agentBindingId: binding.id, vmHostId: host.id, linuxAccount },
      );
      return rowToAllocation(row);
    });
  }

  async getVmAllocationForAgent(agentId: string): Promise<VmAllocation | null> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("vm_allocations")
        .innerJoin("agent_bindings", "agent_bindings.id", "vm_allocations.agent_binding_id")
        .selectAll("vm_allocations")
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("vm_allocations.status", "!=", "revoked"),
    );
    return row ? rowToAllocation(row) : null;
  }
}
