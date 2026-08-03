import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import type {
  AssignedVmConnectionTarget,
  ControlPlaneVmSelfServiceStore,
  SafeConnectEndpoint,
  VmAllocation,
  VmHost,
} from "./execution-contracts.js";
import {
  normalizeAdDomain,
  normalizeLinuxAccount,
  normalizeSafeConnectHost,
  normalizeVmTargetAddress,
  parseVmHostExecutionEnvironmentJson,
} from "./execution-validation.js";
import { nextExecutionResourceId } from "./ids.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { SqliteControlPlaneAuthStore } from "./sqlite-store-auth.js";
import { required } from "./sqlite-store-core.js";
import { rowToAllocation, rowToEndpoint, rowToVmHost } from "./sqlite-store-execution-mappers.js";
import type { VmAllocationRow } from "./sqlite-store-types.js";

export abstract class SqliteControlPlaneVmSelfServiceStore
  extends SqliteControlPlaneAuthStore
  implements ControlPlaneVmSelfServiceStore
{
  async getPersonalVmCatalog(params: { actorUserId: string; agentId: string }) {
    const owner = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .select(["agent_bindings.user_id as user_id", "platform_users.account_id as account_id"])
        .where("agent_bindings.agent_id", "=", params.agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active"),
    );
    if (!owner || owner.user_id !== params.actorUserId) {
      throw new ControlPlaneStateError("personal VM catalog is unavailable");
    }
    const hosts = executeSync(
      this.db,
      this.query
        .selectFrom("vm_hosts")
        .innerJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
        .select(["vm_hosts.id as id", "vm_hosts.label as label"])
        .where("vm_hosts.status", "=", "active")
        .where("safeconnect_endpoints.status", "=", "active")
        .orderBy("vm_hosts.label")
        .orderBy("vm_hosts.id"),
    ).rows;
    return { accountId: owner.account_id, hosts };
  }

  async preparePersonalVmCandidate(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
  }): Promise<AssignedVmConnectionTarget> {
    this.ensureVmHostExecutionEnvironmentSchema();
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
        .innerJoin("vm_hosts", (join) =>
          join.on("vm_hosts.id", "=", params.vmHostId).on("vm_hosts.status", "=", "active"),
        )
        .innerJoin("safeconnect_endpoints", (join) =>
          join
            .onRef("safeconnect_endpoints.id", "=", "vm_hosts.endpoint_id")
            .on("safeconnect_endpoints.status", "=", "active"),
        )
        .leftJoin(
          "vm_host_execution_environments",
          "vm_host_execution_environments.vm_host_id",
          "vm_hosts.id",
        )
        .select([
          "agent_bindings.user_id as user_id",
          "platform_users.account_id as account_id",
          "personal_execution_profiles.target_revision as target_revision",
          "vm_hosts.id as vm_host_id",
          "vm_hosts.label as vm_label",
          "vm_hosts.target_address as target_address",
          "safeconnect_endpoints.label as safeconnect_label",
          "safeconnect_endpoints.host as endpoint_host",
          "safeconnect_endpoints.port as endpoint_port",
          "safeconnect_endpoints.ad_domain as ad_domain",
          "safeconnect_endpoints.host_key_algorithm as host_key_algorithm",
          "safeconnect_endpoints.host_key_public_key as host_key_public_key",
          "safeconnect_endpoints.host_key_fingerprint as host_key_fingerprint",
          "vm_host_execution_environments.config_json as execution_environment_json",
        ])
        .where("agent_bindings.agent_id", "=", params.agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active"),
    );
    if (
      !row ||
      row.user_id !== params.actorUserId ||
      !row.host_key_algorithm ||
      !row.host_key_public_key ||
      !row.host_key_fingerprint
    ) {
      throw new ControlPlaneStateError("selected development VM is unavailable");
    }
    const allocationId = `candidate:${row.vm_host_id}`;
    const executionEnvironment = parseVmHostExecutionEnvironmentJson(
      row.execution_environment_json,
    );
    return {
      kind: "assigned_vm",
      agentId: params.agentId,
      userId: row.user_id,
      targetId: allocationId,
      revision: row.target_revision,
      allocationId,
      allocationStatus: "assigned",
      vmLabel: row.vm_label,
      safeConnectLabel: row.safeconnect_label,
      endpointHost: row.endpoint_host,
      endpointPort: row.endpoint_port,
      adDomain: row.ad_domain,
      adAccount: row.account_id,
      targetAddress: row.target_address,
      linuxAccount: normalizeLinuxAccount(params.linuxAccount),
      hostKeyAlgorithm: row.host_key_algorithm,
      hostKeyPublicKey: row.host_key_public_key,
      hostKeyFingerprint: row.host_key_fingerprint,
      ...(executionEnvironment ? { executionEnvironment } : {}),
    };
  }

  async disableSafeConnectEndpoint(params: {
    actorUserId: string;
    endpointId: string;
    disabledAt: number;
  }): Promise<SafeConnectEndpoint> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const endpoint = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .selectAll()
          .where("id", "=", params.endpointId),
      );
      if (!endpoint) {
        throw new ControlPlaneStateError(`SafeConnect endpoint not found: ${params.endpointId}`);
      }
      const activeHost = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_hosts")
          .select("id")
          .where("endpoint_id", "=", endpoint.id)
          .where("status", "=", "active"),
      );
      if (activeHost) {
        throw new ControlPlaneStateError(
          "disable every development VM before disabling its endpoint",
        );
      }
      if (endpoint.status !== "disabled") {
        executeSync(
          this.db,
          this.query
            .updateTable("safeconnect_endpoints")
            .set({ status: "disabled", updated_at: params.disabledAt })
            .where("id", "=", endpoint.id),
        );
        this.insertAudit(
          params.actorUserId,
          "safeconnect.endpoint.disabled",
          "safeconnect-endpoint",
          endpoint.id,
          params.disabledAt,
        );
      }
      return rowToEndpoint({ ...endpoint, status: "disabled", updated_at: params.disabledAt });
    });
  }

  async updateSafeConnectEndpoint(params: {
    actorUserId: string;
    endpointId: string;
    label: string;
    host: string;
    port: number;
    adDomain: string;
    updatedAt: number;
  }): Promise<SafeConnectEndpoint> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const endpoint = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .selectAll()
          .where("id", "=", params.endpointId),
      );
      if (!endpoint) {
        throw new ControlPlaneStateError(`SafeConnect endpoint not found: ${params.endpointId}`);
      }
      if (endpoint.status === "active") {
        throw new ControlPlaneStateError("disable this SafeConnect endpoint before editing it");
      }
      if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
        throw new ControlPlaneStateError("SafeConnect port must be an integer from 1 to 65535");
      }
      const host = normalizeSafeConnectHost(params.host);
      const duplicate = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .select("id")
          .where("host", "=", host)
          .where("port", "=", params.port)
          .where("id", "!=", endpoint.id),
      );
      if (duplicate) {
        throw new ControlPlaneConflictError(
          "safeconnect_endpoint_conflict",
          `SafeConnect endpoint already exists: ${host}:${params.port}`,
        );
      }
      const addressChanged = endpoint.host !== host || endpoint.port !== params.port;
      const update = {
        label: required(params.label, "endpoint.label"),
        host,
        port: params.port,
        ad_domain: normalizeAdDomain(params.adDomain),
        ...(addressChanged
          ? {
              status: "pending" as const,
              host_key_algorithm: null,
              host_key_public_key: null,
              host_key_fingerprint: null,
              host_key_approved_by_user_id: null,
              host_key_approved_at: null,
            }
          : {}),
        updated_at: params.updatedAt,
      };
      executeSync(
        this.db,
        this.query.updateTable("safeconnect_endpoints").set(update).where("id", "=", endpoint.id),
      );
      this.insertAudit(
        params.actorUserId,
        "safeconnect.endpoint.updated",
        "safeconnect-endpoint",
        endpoint.id,
        params.updatedAt,
        { addressChanged },
      );
      return rowToEndpoint(
        takeFirstSync(
          this.db,
          this.query.selectFrom("safeconnect_endpoints").selectAll().where("id", "=", endpoint.id),
        )!,
      );
    });
  }

  async enableSafeConnectEndpoint(params: {
    actorUserId: string;
    endpointId: string;
    enabledAt: number;
  }): Promise<SafeConnectEndpoint> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const endpoint = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .selectAll()
          .where("id", "=", params.endpointId),
      );
      if (!endpoint) {
        throw new ControlPlaneStateError(`SafeConnect endpoint not found: ${params.endpointId}`);
      }
      if (
        !endpoint.host_key_algorithm ||
        !endpoint.host_key_public_key ||
        !endpoint.host_key_fingerprint
      ) {
        throw new ControlPlaneStateError("approve the SafeConnect host key before enabling it");
      }
      if (endpoint.status !== "active") {
        executeSync(
          this.db,
          this.query
            .updateTable("safeconnect_endpoints")
            .set({ status: "active", updated_at: params.enabledAt })
            .where("id", "=", endpoint.id),
        );
        this.insertAudit(
          params.actorUserId,
          "safeconnect.endpoint.enabled",
          "safeconnect-endpoint",
          endpoint.id,
          params.enabledAt,
        );
      }
      return rowToEndpoint({ ...endpoint, status: "active", updated_at: params.enabledAt });
    });
  }

  async disableVmHost(params: {
    actorUserId: string;
    vmHostId: string;
    disabledAt: number;
  }): Promise<VmHost> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const host = takeFirstSync(
        this.db,
        this.query.selectFrom("vm_hosts").selectAll().where("id", "=", params.vmHostId),
      );
      if (!host) {
        throw new ControlPlaneStateError(`VM host not found: ${params.vmHostId}`);
      }
      const allocation = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations")
          .select("id")
          .where("vm_host_id", "=", host.id)
          .where("status", "!=", "revoked"),
      );
      if (allocation) {
        throw new ControlPlaneStateError(
          "release every active assignment before disabling this VM",
        );
      }
      if (host.status !== "disabled") {
        executeSync(
          this.db,
          this.query
            .updateTable("vm_hosts")
            .set({ status: "disabled", updated_at: params.disabledAt })
            .where("id", "=", host.id),
        );
        this.insertAudit(
          params.actorUserId,
          "vm.host.disabled",
          "vm-host",
          host.id,
          params.disabledAt,
        );
      }
      return rowToVmHost({ ...host, status: "disabled", updated_at: params.disabledAt });
    });
  }

  async updateVmHost(params: {
    actorUserId: string;
    vmHostId: string;
    endpointId: string;
    label: string;
    targetAddress: string;
    updatedAt: number;
  }): Promise<VmHost> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const host = takeFirstSync(
        this.db,
        this.query.selectFrom("vm_hosts").selectAll().where("id", "=", params.vmHostId),
      );
      if (!host) {
        throw new ControlPlaneStateError(`VM host not found: ${params.vmHostId}`);
      }
      if (host.status !== "disabled") {
        throw new ControlPlaneStateError("disable this development VM before editing it");
      }
      const allocation = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations")
          .select("id")
          .where("vm_host_id", "=", host.id)
          .where("status", "!=", "revoked"),
      );
      if (allocation) {
        throw new ControlPlaneStateError("release every active assignment before editing this VM");
      }
      const endpoint = takeFirstSync(
        this.db,
        this.query
          .selectFrom("safeconnect_endpoints")
          .select("id")
          .where("id", "=", params.endpointId)
          .where("status", "=", "active"),
      );
      if (!endpoint) {
        throw new ControlPlaneStateError("VM host requires an active, pinned SafeConnect endpoint");
      }
      const targetAddress = normalizeVmTargetAddress(params.targetAddress);
      const duplicate = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_hosts")
          .select("id")
          .where("endpoint_id", "=", endpoint.id)
          .where("target_address", "=", targetAddress)
          .where("id", "!=", host.id),
      );
      if (duplicate) {
        throw new ControlPlaneConflictError(
          "vm_host_conflict",
          `VM host already exists for endpoint and target: ${targetAddress}`,
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("vm_hosts")
          .set({
            endpoint_id: endpoint.id,
            label: required(params.label, "vmHost.label"),
            target_address: targetAddress,
            updated_at: params.updatedAt,
          })
          .where("id", "=", host.id),
      );
      this.insertAudit(params.actorUserId, "vm.host.updated", "vm-host", host.id, params.updatedAt);
      return rowToVmHost(
        takeFirstSync(
          this.db,
          this.query.selectFrom("vm_hosts").selectAll().where("id", "=", host.id),
        )!,
      );
    });
  }

  async enableVmHost(params: {
    actorUserId: string;
    vmHostId: string;
    enabledAt: number;
  }): Promise<VmHost> {
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const host = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_hosts")
          .innerJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
          .selectAll("vm_hosts")
          .select("safeconnect_endpoints.status as endpoint_status")
          .where("vm_hosts.id", "=", params.vmHostId),
      );
      if (!host) {
        throw new ControlPlaneStateError(`VM host not found: ${params.vmHostId}`);
      }
      if (host.endpoint_status !== "active") {
        throw new ControlPlaneStateError("enable the SafeConnect endpoint before enabling this VM");
      }
      if (host.status !== "active") {
        executeSync(
          this.db,
          this.query
            .updateTable("vm_hosts")
            .set({ status: "active", updated_at: params.enabledAt })
            .where("id", "=", host.id),
        );
        this.insertAudit(
          params.actorUserId,
          "vm.host.enabled",
          "vm-host",
          host.id,
          params.enabledAt,
        );
      }
      return rowToVmHost({ ...host, status: "active", updated_at: params.enabledAt });
    });
  }

  async replacePersonalVmAllocation(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    remoteHomeDir: string;
    remoteWorkspaceDir: string;
    replacedAt: number;
  }): Promise<VmAllocation> {
    return runImmediateTransaction(this.db, () =>
      this.replacePersonalVmAllocationInTransaction(params),
    );
  }

  protected replacePersonalVmAllocationInTransaction(params: {
    actorUserId: string;
    agentId: string;
    vmHostId: string;
    linuxAccount: string;
    remoteHomeDir: string;
    remoteWorkspaceDir: string;
    replacedAt: number;
  }): VmAllocation {
    const owner = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin(
          "personal_execution_profiles",
          "personal_execution_profiles.agent_binding_id",
          "agent_bindings.id",
        )
        .select([
          "agent_bindings.id as binding_id",
          "agent_bindings.user_id as user_id",
          "personal_execution_profiles.active_target as active_target",
        ])
        .where("agent_bindings.agent_id", "=", params.agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active"),
    );
    if (!owner || owner.user_id !== params.actorUserId) {
      throw new ControlPlaneStateError("personal VM assignment is unavailable");
    }
    if (owner.active_target !== "platform_server") {
      throw new ControlPlaneStateError(
        "switch to the Basic workspace before changing development VM",
      );
    }
    const host = takeFirstSync(
      this.db,
      this.query
        .selectFrom("vm_hosts")
        .innerJoin("safeconnect_endpoints", "safeconnect_endpoints.id", "vm_hosts.endpoint_id")
        .select(["vm_hosts.id as id"])
        .where("vm_hosts.id", "=", params.vmHostId)
        .where("vm_hosts.status", "=", "active")
        .where("safeconnect_endpoints.status", "=", "active"),
    );
    if (!host) {
      throw new ControlPlaneStateError("selected development VM is unavailable");
    }
    const linuxAccount = normalizeLinuxAccount(params.linuxAccount);
    const current = takeFirstSync(
      this.db,
      this.query
        .selectFrom("vm_allocations")
        .selectAll()
        .where("agent_binding_id", "=", owner.binding_id)
        .where("status", "!=", "revoked"),
    );
    const conflict = takeFirstSync(
      this.db,
      this.query
        .selectFrom("vm_allocations")
        .select("id")
        .where("vm_host_id", "=", host.id)
        .where("linux_account", "=", linuxAccount)
        .where("status", "!=", "revoked")
        .$if(Boolean(current), (query) => query.where("id", "!=", current?.id ?? "")),
    );
    if (conflict) {
      throw new ControlPlaneConflictError(
        "vm_allocation_conflict",
        "this VM Linux account is already assigned",
      );
    }
    if (current) {
      executeSync(
        this.db,
        this.query
          .updateTable("vm_allocations")
          .set({
            status: "revoked",
            revoked_at: params.replacedAt,
            updated_at: params.replacedAt,
          })
          .where("id", "=", current.id),
      );
    }
    const row: VmAllocationRow = {
      id: nextExecutionResourceId(this.idFactory, "vm-allocation"),
      agent_binding_id: owner.binding_id,
      vm_host_id: host.id,
      linux_account: linuxAccount,
      status: "ready",
      remote_home_dir: required(params.remoteHomeDir, "allocation.remoteHomeDir"),
      remote_workspace_dir: required(params.remoteWorkspaceDir, "allocation.remoteWorkspaceDir"),
      last_connection_check_at: params.replacedAt,
      last_connection_succeeded_at: params.replacedAt,
      failure_code: null,
      created_by_user_id: params.actorUserId,
      created_at: params.replacedAt,
      updated_at: params.replacedAt,
      revoked_at: null,
    };
    executeSync(this.db, this.query.insertInto("vm_allocations").values(row));
    this.insertAudit(
      params.actorUserId,
      current ? "vm.allocation.replaced" : "vm.allocation.created",
      "vm-allocation",
      row.id,
      params.replacedAt,
      {
        agentBindingId: owner.binding_id,
        vmHostId: host.id,
        linuxAccount,
        ...(current ? { previousAllocationId: current.id } : {}),
      },
    );
    return rowToAllocation(row);
  }

  async releasePersonalVmAllocation(params: {
    actorUserId: string;
    agentId: string;
    releasedAt: number;
  }): Promise<VmAllocation> {
    return runImmediateTransaction(this.db, () =>
      this.revokePersonalVmAllocationInTransaction({ ...params, requireAdmin: false }),
    );
  }

  async revokeVmAllocationAsAdmin(params: {
    actorUserId: string;
    allocationId: string;
    revokedAt: number;
  }): Promise<VmAllocation> {
    this.requireAdmin(params.actorUserId);
    return runImmediateTransaction(this.db, () =>
      this.revokePersonalVmAllocationInTransaction({
        actorUserId: params.actorUserId,
        allocationId: params.allocationId,
        releasedAt: params.revokedAt,
        requireAdmin: true,
      }),
    );
  }

  protected revokePersonalVmAllocationInTransaction(params: {
    actorUserId: string;
    agentId?: string;
    allocationId?: string;
    releasedAt: number;
    requireAdmin: boolean;
  }): VmAllocation {
    if (params.requireAdmin) {
      this.requireAdmin(params.actorUserId);
    }
    let query = this.query
      .selectFrom("vm_allocations")
      .innerJoin("agent_bindings", "agent_bindings.id", "vm_allocations.agent_binding_id")
      .innerJoin(
        "personal_execution_profiles",
        "personal_execution_profiles.agent_binding_id",
        "agent_bindings.id",
      )
      .selectAll("vm_allocations")
      .select([
        "agent_bindings.agent_id as agent_id",
        "agent_bindings.user_id as user_id",
        "personal_execution_profiles.active_target as active_target",
      ])
      .where("vm_allocations.status", "!=", "revoked");
    if (params.allocationId) {
      query = query.where("vm_allocations.id", "=", params.allocationId);
    }
    if (params.agentId) {
      query = query.where("agent_bindings.agent_id", "=", params.agentId);
    }
    const row = takeFirstSync(this.db, query);
    if (!row || (!params.requireAdmin && row.user_id !== params.actorUserId)) {
      throw new ControlPlaneStateError("active VM assignment is unavailable");
    }
    if (row.active_target !== "platform_server") {
      throw new ControlPlaneStateError(
        "switch to the Basic workspace before releasing development VM",
      );
    }
    executeSync(
      this.db,
      this.query
        .updateTable("vm_allocations")
        .set({ status: "revoked", revoked_at: params.releasedAt, updated_at: params.releasedAt })
        .where("id", "=", row.id),
    );
    this.insertAudit(
      params.actorUserId,
      params.requireAdmin ? "vm.allocation.admin-revoked" : "vm.allocation.released",
      "vm-allocation",
      row.id,
      params.releasedAt,
      { agentId: row.agent_id },
    );
    return rowToAllocation({
      ...row,
      status: "revoked",
      revoked_at: params.releasedAt,
      updated_at: params.releasedAt,
    });
  }
}
