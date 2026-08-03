import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import type {
  AssignedVmConnectionTarget,
  ControlPlaneEmployeeExecutionStore,
  ControlPlaneExecutionManagementStore,
  ControlPlaneExecutionTargetStore,
  PersonalExecutionTarget,
  PersonalExecutionSettings,
  SafeConnectEndpoint,
  VmAllocation,
  VmAdministrationSnapshot,
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
import { required } from "./sqlite-store-core.js";
import { readVmAdministrationSnapshot } from "./sqlite-store-execution-admin.js";
import {
  rowToAllocation,
  rowToEndpoint,
  rowToPersonalExecutionSettings,
  rowToVmHost,
} from "./sqlite-store-execution-mappers.js";
import { hasCompleteAssignedVmExecutionFields } from "./sqlite-store-execution-readiness.js";
import { SqliteControlPlaneExecutionTargetStore } from "./sqlite-store-execution-target.js";
import type { SafeConnectEndpointRow, VmAllocationRow, VmHostRow } from "./sqlite-store-types.js";

export abstract class SqliteControlPlaneExecutionStore
  extends SqliteControlPlaneExecutionTargetStore
  implements
    ControlPlaneExecutionManagementStore,
    ControlPlaneExecutionTargetStore,
    ControlPlaneEmployeeExecutionStore
{
  async getVmAdministrationSnapshot(actorUserId: string): Promise<VmAdministrationSnapshot> {
    return readVmAdministrationSnapshot({
      db: this.db,
      query: this.query,
      requireAdmin: () => this.requireAdmin(actorUserId),
    });
  }

  async resolveAssignedVmConnectionTarget(agentId: string): Promise<AssignedVmConnectionTarget> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .innerJoin(
          "personal_execution_profiles",
          "personal_execution_profiles.agent_binding_id",
          "agent_bindings.id",
        )
        .innerJoin("vm_allocations", "vm_allocations.agent_binding_id", "agent_bindings.id")
        .innerJoin("vm_hosts", "vm_hosts.id", "vm_allocations.vm_host_id")
        .innerJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
        .select([
          "agent_bindings.agent_id as agent_id",
          "agent_bindings.state as binding_state",
          "platform_users.id as user_id",
          "platform_users.account_id as account_id",
          "platform_users.status as user_status",
          "personal_execution_profiles.target_revision as target_revision",
          "vm_allocations.id as allocation_id",
          "vm_allocations.status as allocation_status",
          "vm_allocations.linux_account as linux_account",
          "vm_allocations.remote_home_dir as remote_home_dir",
          "vm_allocations.remote_workspace_dir as remote_workspace_dir",
          "vm_hosts.status as host_status",
          "vm_hosts.label as vm_label",
          "vm_hosts.target_address as target_address",
          "safeconnect_endpoints.status as endpoint_status",
          "safeconnect_endpoints.label as safeconnect_label",
          "safeconnect_endpoints.host as endpoint_host",
          "safeconnect_endpoints.port as endpoint_port",
          "safeconnect_endpoints.ad_domain as ad_domain",
          "safeconnect_endpoints.host_key_algorithm as host_key_algorithm",
          "safeconnect_endpoints.host_key_public_key as host_key_public_key",
          "safeconnect_endpoints.host_key_fingerprint as host_key_fingerprint",
        ])
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("vm_allocations.status", "!=", "revoked"),
    );
    if (
      !row ||
      row.binding_state !== "active" ||
      row.user_status !== "active" ||
      row.host_status !== "active" ||
      row.endpoint_status !== "active" ||
      !hasCompleteAssignedVmExecutionFields(row, false)
    ) {
      throw new ControlPlaneStateError("assigned VM connection target is unavailable");
    }
    return {
      kind: "assigned_vm",
      agentId: row.agent_id,
      userId: row.user_id,
      targetId: row.allocation_id,
      revision: row.target_revision,
      allocationId: row.allocation_id,
      allocationStatus: row.allocation_status,
      vmLabel: row.vm_label,
      safeConnectLabel: row.safeconnect_label,
      endpointHost: row.endpoint_host,
      endpointPort: row.endpoint_port,
      adDomain: row.ad_domain,
      adAccount: row.account_id,
      targetAddress: row.target_address,
      linuxAccount: row.linux_account,
      ...(row.remote_home_dir ? { remoteHomeDir: row.remote_home_dir } : {}),
      ...(row.remote_workspace_dir ? { remoteWorkspaceDir: row.remote_workspace_dir } : {}),
      hostKeyAlgorithm: row.host_key_algorithm,
      hostKeyPublicKey: row.host_key_public_key,
      hostKeyFingerprint: row.host_key_fingerprint,
    };
  }

  async changePersonalExecutionTarget(params: {
    agentId: string;
    target: "platform_server" | "assigned_vm";
    expectedRevision: number;
    changedAt: number;
  }): Promise<PersonalExecutionTarget> {
    runImmediateTransaction(this.db, () => {
      const profile = takeFirstSync(
        this.db,
        this.query
          .selectFrom("personal_execution_profiles")
          .innerJoin(
            "agent_bindings",
            "agent_bindings.id",
            "personal_execution_profiles.agent_binding_id",
          )
          .select([
            "personal_execution_profiles.agent_binding_id as binding_id",
            "personal_execution_profiles.target_revision as target_revision",
            "agent_bindings.user_id as user_id",
          ])
          .where("agent_bindings.agent_id", "=", params.agentId)
          .where("agent_bindings.kind", "=", "personal")
          .where("agent_bindings.state", "=", "active"),
      );
      if (!profile || profile.target_revision !== params.expectedRevision) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "execution target changed before the requested update",
        );
      }
      const allocation =
        params.target === "assigned_vm"
          ? takeFirstSync(
              this.db,
              this.query
                .selectFrom("vm_allocations")
                .innerJoin("vm_hosts", "vm_hosts.id", "vm_allocations.vm_host_id")
                .innerJoin(
                  "safeconnect_endpoints",
                  "safeconnect_endpoints.id",
                  "vm_hosts.endpoint_id",
                )
                .select([
                  "vm_allocations.id as id",
                  "vm_allocations.status as status",
                  "vm_allocations.remote_workspace_dir as remote_workspace_dir",
                  "vm_hosts.status as host_status",
                  "safeconnect_endpoints.status as endpoint_status",
                  "safeconnect_endpoints.host_key_algorithm as host_key_algorithm",
                  "safeconnect_endpoints.host_key_public_key as host_key_public_key",
                  "safeconnect_endpoints.host_key_fingerprint as host_key_fingerprint",
                ])
                .where("vm_allocations.agent_binding_id", "=", profile.binding_id)
                .where("vm_allocations.status", "!=", "revoked"),
            )
          : undefined;
      if (
        params.target === "assigned_vm" &&
        (allocation?.status !== "ready" ||
          allocation.host_status !== "active" ||
          allocation.endpoint_status !== "active" ||
          !allocation.remote_workspace_dir ||
          !allocation.host_key_algorithm ||
          !allocation.host_key_public_key ||
          !allocation.host_key_fingerprint)
      ) {
        throw new ControlPlaneStateError("assigned VM is not ready");
      }
      executeSync(
        this.db,
        this.query
          .updateTable("personal_execution_profiles")
          .set({
            active_target: params.target,
            active_allocation_id: allocation?.id ?? null,
            target_revision: profile.target_revision + 1,
            updated_at: params.changedAt,
          })
          .where("agent_binding_id", "=", profile.binding_id)
          .where("target_revision", "=", profile.target_revision),
      );
      this.insertAudit(
        profile.user_id,
        "execution.target.changed",
        "agent-binding",
        profile.binding_id,
        params.changedAt,
        { target: params.target, revision: profile.target_revision + 1 },
      );
    });
    return await this.resolvePersonalExecutionTarget(params.agentId);
  }

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
        .leftJoin("encrypted_user_ssh_credentials", (join) =>
          join.on("encrypted_user_ssh_credentials.user_id", "=", owner.user_id),
        )
        .select([
          "vm_allocations.id as allocation_id",
          "vm_allocations.agent_binding_id as agent_binding_id",
          "vm_allocations.status as allocation_status",
          "vm_allocations.linux_account as linux_account",
          "vm_allocations.remote_home_dir as remote_home_dir",
          "vm_allocations.remote_workspace_dir as remote_workspace_dir",
          "vm_hosts.status as host_status",
          "vm_hosts.label as vm_label",
          "vm_hosts.target_address as target_address",
          "safeconnect_endpoints.status as endpoint_status",
          "safeconnect_endpoints.label as safeconnect_label",
          "safeconnect_endpoints.host as endpoint_host",
          "safeconnect_endpoints.port as endpoint_port",
          "safeconnect_endpoints.ad_domain as ad_domain",
          "safeconnect_endpoints.host_key_algorithm as host_key_algorithm",
          "safeconnect_endpoints.host_key_public_key as host_key_public_key",
          "safeconnect_endpoints.host_key_fingerprint as host_key_fingerprint",
          "encrypted_user_ssh_credentials.revision as credential_revision",
          "encrypted_user_ssh_credentials.status as credential_status",
        ])
        .where("vm_allocations.id", "=", owner.active_allocation_id),
    );
    if (
      !vm ||
      vm.agent_binding_id !== owner.binding_id ||
      vm.allocation_status !== "ready" ||
      vm.host_status !== "active" ||
      vm.endpoint_status !== "active" ||
      vm.credential_status !== "current" ||
      typeof vm.credential_revision !== "number" ||
      !Number.isSafeInteger(vm.credential_revision) ||
      vm.credential_revision < 1 ||
      !hasCompleteAssignedVmExecutionFields(vm, true)
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
      credentialRevision: vm.credential_revision,
      vmLabel: vm.vm_label,
      safeConnectLabel: vm.safeconnect_label,
      endpointHost: vm.endpoint_host,
      endpointPort: vm.endpoint_port,
      adDomain: vm.ad_domain,
      adAccount: owner.account_id,
      targetAddress: vm.target_address,
      linuxAccount: vm.linux_account,
      remoteHomeDir: vm.remote_home_dir,
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
      if (current.status === "active") {
        if (
          current.host_key_algorithm === hostKey.algorithm &&
          current.host_key_public_key === hostKey.publicKey &&
          current.host_key_fingerprint === hostKey.fingerprint
        ) {
          return rowToEndpoint(current);
        }
        throw new ControlPlaneStateError(
          "disable this SafeConnect endpoint before replacing its host key",
        );
      }
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
    return this.getVmAllocationForAgentInTransaction(agentId);
  }

  protected getVmAllocationForAgentInTransaction(agentId: string): VmAllocation | null {
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

  async getPersonalExecutionSettings(agentId: string): Promise<PersonalExecutionSettings | null> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin(
          "personal_execution_profiles",
          "personal_execution_profiles.agent_binding_id",
          "agent_bindings.id",
        )
        .leftJoin("vm_allocations", (join) =>
          join
            .onRef("vm_allocations.agent_binding_id", "=", "agent_bindings.id")
            .on("vm_allocations.status", "!=", "revoked"),
        )
        .leftJoin("vm_hosts", "vm_hosts.id", "vm_allocations.vm_host_id")
        .leftJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
        .select([
          "agent_bindings.agent_id as agent_id",
          "agent_bindings.user_id as user_id",
          "personal_execution_profiles.active_target as active_target",
          "personal_execution_profiles.target_revision as target_revision",
          "vm_allocations.id as allocation_id",
          "vm_allocations.vm_host_id as vm_host_id",
          "vm_allocations.status as allocation_status",
          "vm_allocations.linux_account as linux_account",
          "vm_allocations.remote_home_dir as remote_home_dir",
          "vm_allocations.remote_workspace_dir as remote_workspace_dir",
          "vm_allocations.last_connection_check_at as last_connection_check_at",
          "vm_allocations.last_connection_succeeded_at as last_connection_succeeded_at",
          "vm_allocations.failure_code as failure_code",
          "vm_hosts.label as vm_label",
          "safeconnect_endpoints.label as safeconnect_label",
        ])
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active"),
    );
    return row ? rowToPersonalExecutionSettings(row) : null;
  }

  async recordVmConnectionResult(params: {
    actorUserId: string;
    agentId: string;
    expectedAllocationId: string;
    expectedTargetRevision: number;
    checkedAt: number;
    result:
      | { status: "ready"; remoteHomeDir: string; remoteWorkspaceDir: string }
      | { status: "connection_required"; failureCode: string };
  }): Promise<VmAllocation> {
    return runImmediateTransaction(this.db, () => {
      const row = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations")
          .innerJoin("agent_bindings", "agent_bindings.id", "vm_allocations.agent_binding_id")
          .innerJoin(
            "personal_execution_profiles",
            "personal_execution_profiles.agent_binding_id",
            "agent_bindings.id",
          )
          .select(["vm_allocations.id as allocation_id", "agent_bindings.user_id as user_id"])
          .where("agent_bindings.agent_id", "=", params.agentId)
          .where("agent_bindings.kind", "=", "personal")
          .where("vm_allocations.id", "=", params.expectedAllocationId)
          .where("personal_execution_profiles.target_revision", "=", params.expectedTargetRevision)
          .where("vm_allocations.status", "!=", "revoked"),
      );
      if (!row) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "execution target changed before the connection result was stored",
        );
      }
      if (row.user_id !== params.actorUserId) {
        this.requireAdmin(params.actorUserId);
      }
      const update =
        params.result.status === "ready"
          ? {
              status: "ready" as const,
              remote_home_dir: required(params.result.remoteHomeDir, "allocation.remoteHomeDir"),
              remote_workspace_dir: required(
                params.result.remoteWorkspaceDir,
                "allocation.remoteWorkspaceDir",
              ),
              last_connection_check_at: params.checkedAt,
              last_connection_succeeded_at: params.checkedAt,
              failure_code: null,
              updated_at: params.checkedAt,
            }
          : {
              status: "connection_required" as const,
              last_connection_check_at: params.checkedAt,
              failure_code: required(params.result.failureCode, "allocation.failureCode"),
              updated_at: params.checkedAt,
            };
      executeSync(
        this.db,
        this.query.updateTable("vm_allocations").set(update).where("id", "=", row.allocation_id),
      );
      this.insertAudit(
        params.actorUserId,
        params.result.status === "ready" ? "vm.connection.succeeded" : "vm.connection.failed",
        "vm-allocation",
        row.allocation_id,
        params.checkedAt,
        params.result.status === "connection_required"
          ? { failureCode: params.result.failureCode }
          : undefined,
      );
      return rowToAllocation(
        takeFirstSync(
          this.db,
          this.query.selectFrom("vm_allocations").selectAll().where("id", "=", row.allocation_id),
        )!,
      );
    });
  }
}

/* oxlint-disable max-lines -- TODO: split this now-oversized execution store by query owner. */
