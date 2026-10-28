import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import type {
  AssignedVmConnectionTarget,
  ControlPlaneSavedVmConnectionStore,
} from "./execution-contracts.js";
import { normalizeLinuxAccount } from "./execution-validation.js";
import { nextExecutionResourceId } from "./ids.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { SqliteControlPlaneCredentialStore } from "./sqlite-store-credentials.js";
import { rowToSavedVmConnection } from "./sqlite-store-saved-vm-mappers.js";
import type { SavedVmConnectionRow, VmAllocationRow } from "./sqlite-store-types.js";
import { validateSshCredentialEnvelope } from "./ssh-credential-validation.js";

function candidateIdentity(candidate: AssignedVmConnectionTarget): string {
  return JSON.stringify([
    candidate.endpointHost,
    candidate.endpointPort,
    candidate.adDomain,
    candidate.hostKeyAlgorithm,
    candidate.hostKeyPublicKey,
    candidate.hostKeyFingerprint,
    candidate.targetAddress,
  ]);
}

export abstract class SqliteControlPlaneSavedVmConnectionStore
  extends SqliteControlPlaneCredentialStore
  implements ControlPlaneSavedVmConnectionStore
{
  private savedVmOwner(agentId: string, actorUserId?: string, includeInactive = false) {
    const owner = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings as b")
        .innerJoin("platform_users as u", "u.id", "b.user_id")
        .innerJoin("personal_execution_profiles as p", "p.agent_binding_id", "b.id")
        .select([
          "b.id as binding_id",
          "b.user_id as user_id",
          "b.state as binding_state",
          "u.status as user_status",
          "p.active_target",
          "p.active_allocation_id",
          "p.target_revision",
        ])
        .where("b.agent_id", "=", agentId)
        .where("b.kind", "=", "personal")
        .$if(!includeInactive, (query) =>
          query.where("b.state", "=", "active").where("u.status", "=", "active"),
        ),
    );
    if (!owner?.user_id || (actorUserId && owner.user_id !== actorUserId)) {
      throw new ControlPlaneStateError("owned personal VM connections are unavailable");
    }
    return { ...owner, user_id: owner.user_id };
  }

  private savedVmRows(bindingId: string) {
    return executeSync(
      this.db,
      this.query
        .selectFrom("saved_vm_connections as s")
        .innerJoin("vm_hosts as h", "h.id", "s.vm_host_id")
        .innerJoin("safeconnect_endpoints as e", "e.id", "h.endpoint_id")
        .selectAll("s")
        .select([
          "h.label as vm_label",
          "e.label as safeconnect_label",
          "h.status as host_status",
          "e.status as endpoint_status",
          "e.host",
          "e.port",
          "e.ad_domain",
          "e.host_key_algorithm",
          "e.host_key_public_key",
          "e.host_key_fingerprint",
          "h.target_address",
        ])
        .where("s.agent_binding_id", "=", bindingId)
        .orderBy("h.label")
        .orderBy("s.id"),
    ).rows;
  }

  async getPersonalSavedVmConnections(
    params: Parameters<ControlPlaneSavedVmConnectionStore["getPersonalSavedVmConnections"]>[0],
  ) {
    const owner = this.savedVmOwner(params.agentId, params.actorUserId);
    return this.savedVmRows(owner.binding_id).map((row) =>
      rowToSavedVmConnection(row, owner.active_allocation_id),
    );
  }

  async getSavedVmConnectionCredential(
    params: Parameters<ControlPlaneSavedVmConnectionStore["getSavedVmConnectionCredential"]>[0],
  ) {
    const owner = this.savedVmOwner(params.agentId, params.actorUserId);
    const row = this.savedVmRows(owner.binding_id).find(
      (entry) => entry.id === params.connectionId,
    );
    const connection = row && rowToSavedVmConnection(row, owner.active_allocation_id);
    if (
      !row ||
      connection?.status !== "ready" ||
      !row.credential_ciphertext ||
      !row.credential_nonce ||
      !row.credential_auth_tag ||
      !row.credential_key_id ||
      row.credential_format_version !== 1
    ) {
      throw new ControlPlaneStateError(
        "saved VM requires connection or authentication; reconnect this VM",
      );
    }
    const candidate = await this.preparePersonalVmCandidate({
      actorUserId: params.actorUserId,
      agentId: params.agentId,
      vmHostId: row.vm_host_id,
      linuxAccount: row.linux_account,
    });
    const currentOwner = this.savedVmOwner(params.agentId, params.actorUserId);
    const current = this.savedVmRows(currentOwner.binding_id).find(
      (entry) => entry.id === params.connectionId,
    );
    if (
      !current ||
      current.revision !== row.revision ||
      candidate.revision !== currentOwner.target_revision ||
      candidate.linuxAccount !== current.linux_account ||
      candidateIdentity(candidate) !== current.endpoint_identity ||
      rowToSavedVmConnection(current, currentOwner.active_allocation_id).status !== "ready"
    ) {
      throw new ControlPlaneConflictError(
        "execution_target_conflict",
        "saved VM authority changed before credential resolution; reload and retry",
      );
    }
    return {
      connection,
      candidate,
      credentialEnvelope: {
        ciphertext: row.credential_ciphertext.slice(),
        nonce: row.credential_nonce.slice(),
        authTag: row.credential_auth_tag.slice(),
        keyId: row.credential_key_id,
        formatVersion: 1 as const,
      },
    };
  }

  async savePersonalVmConnection(
    params: Parameters<ControlPlaneSavedVmConnectionStore["savePersonalVmConnection"]>[0],
  ) {
    const connectionId = runImmediateTransaction(this.db, () => {
      const owner = this.savedVmOwner(params.agentId, params.actorUserId);
      if (
        owner.target_revision !== params.expectedRevision ||
        params.candidate.revision !== params.expectedRevision ||
        params.candidate.agentId !== params.agentId ||
        params.candidate.userId !== params.actorUserId
      ) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "execution target changed during VM verification",
        );
      }
      validateSshCredentialEnvelope(params.credentialEnvelope);
      const host = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_hosts as h")
          .innerJoin("safeconnect_endpoints as e", "e.id", "h.endpoint_id")
          .select([
            "h.target_address",
            "e.host",
            "e.port",
            "e.ad_domain",
            "e.host_key_algorithm",
            "e.host_key_public_key",
            "e.host_key_fingerprint",
          ])
          .where("h.id", "=", params.vmHostId)
          .where("h.status", "=", "active")
          .where("e.status", "=", "active"),
      );
      const identity =
        host &&
        JSON.stringify([
          host.host,
          host.port,
          host.ad_domain,
          host.host_key_algorithm,
          host.host_key_public_key,
          host.host_key_fingerprint,
          host.target_address,
        ]);
      const linuxAccount = normalizeLinuxAccount(params.linuxAccount);
      if (
        !host ||
        !identity ||
        !host.host_key_fingerprint ||
        identity !== candidateIdentity(params.candidate) ||
        params.candidate.linuxAccount !== linuxAccount ||
        params.candidate.allocationId !== `candidate:${params.vmHostId}`
      ) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "VM configuration changed during connection verification",
        );
      }
      if (
        !params.remoteHomeDir.startsWith("/") ||
        params.remoteHomeDir === "/" ||
        !params.remoteWorkspaceDir.startsWith(`${params.remoteHomeDir}/`)
      ) {
        throw new ControlPlaneStateError(
          "connection-verified remote workspace must be inside the Linux account home",
        );
      }
      const allocationConflict = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations")
          .select("id")
          .where("vm_host_id", "=", params.vmHostId)
          .where("linux_account", "=", linuxAccount)
          .where("agent_binding_id", "!=", owner.binding_id)
          .where("status", "!=", "revoked"),
      );
      const reserved = takeFirstSync(
        this.db,
        this.query
          .selectFrom("saved_vm_connections")
          .select("id")
          .where("vm_host_id", "=", params.vmHostId)
          .where("linux_account", "=", linuxAccount)
          .where("agent_binding_id", "!=", owner.binding_id),
      );
      if (allocationConflict || reserved) {
        throw new ControlPlaneConflictError(
          "vm_allocation_conflict",
          "this VM Linux account is already assigned",
        );
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("saved_vm_connections")
          .selectAll()
          .where("agent_binding_id", "=", owner.binding_id)
          .where("vm_host_id", "=", params.vmHostId),
      );
      if (
        existing &&
        (existing.linux_account !== linuxAccount ||
          existing.endpoint_identity !== identity ||
          (existing.remote_home_dir !== null &&
            existing.remote_home_dir !== params.remoteHomeDir) ||
          (existing.remote_workspace_dir !== null &&
            existing.remote_workspace_dir !== params.remoteWorkspaceDir))
      ) {
        throw new ControlPlaneStateError(
          "VM identity changed; remove this saved connection and register it again",
        );
      }
      const row: SavedVmConnectionRow = {
        id: existing?.id ?? nextExecutionResourceId(this.idFactory, "vm-allocation"),
        revision: (existing?.revision ?? 0) + 1,
        agent_binding_id: owner.binding_id,
        vm_host_id: params.vmHostId,
        linux_account: linuxAccount,
        allocation_id: existing?.allocation_id ?? null,
        endpoint_identity: identity,
        remote_home_dir: params.remoteHomeDir,
        remote_workspace_dir: params.remoteWorkspaceDir,
        last_connection_succeeded_at: params.verifiedAt,
        credential_ciphertext: params.credentialEnvelope.ciphertext.slice(),
        credential_nonce: params.credentialEnvelope.nonce.slice(),
        credential_auth_tag: params.credentialEnvelope.authTag.slice(),
        credential_key_id: params.credentialEnvelope.keyId,
        credential_format_version: 1,
        credential_status: "current",
        connection_status: "ready",
        failure_code: null,
        created_at: existing?.created_at ?? params.verifiedAt,
        updated_at: params.verifiedAt,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("saved_vm_connections")
          .values(row)
          .onConflict((conflict) =>
            conflict.columns(["agent_binding_id", "vm_host_id"]).doUpdateSet(row),
          ),
      );
      this.insertAudit(
        params.actorUserId,
        "vm.connection.saved",
        "saved-vm-connection",
        row.id,
        params.verifiedAt,
      );
      return row.id;
    });
    const connections = await this.getPersonalSavedVmConnections(params);
    const saved = connections.find((entry) => entry.id === connectionId);
    if (!saved) {
      throw new ControlPlaneStateError("saved VM connection is unavailable");
    }
    return saved;
  }

  async activatePersonalVmConnection(
    params: Parameters<ControlPlaneSavedVmConnectionStore["activatePersonalVmConnection"]>[0],
  ) {
    runImmediateTransaction(this.db, () => {
      const owner = this.savedVmOwner(params.agentId);
      const saved = this.savedVmRows(owner.binding_id).find(
        (entry) => entry.id === params.connectionId,
      );
      const connection = saved && rowToSavedVmConnection(saved, owner.active_allocation_id);
      if (
        !saved ||
        owner.target_revision !== params.expectedRevision ||
        saved.revision !== params.expectedConnectionRevision
      ) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "VM connection changed during switch; reload and retry",
        );
      }
      if (
        connection?.status !== "ready" ||
        !saved.remote_home_dir ||
        !saved.remote_workspace_dir ||
        !saved.credential_ciphertext ||
        !saved.credential_nonce ||
        !saved.credential_auth_tag ||
        !saved.credential_key_id
      ) {
        throw new ControlPlaneStateError("saved VM is not ready; reconnect this VM");
      }
      const current = this.getVmAllocationForAgentInTransaction(params.agentId);
      // Detach saved registrations before revoking the projection; administrator
      // revocation intentionally deletes a still-linked registration instead.
      if (current) {
        executeSync(
          this.db,
          this.query
            .updateTable("saved_vm_connections")
            .set({ allocation_id: null })
            .where("allocation_id", "=", current.id),
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("personal_execution_profiles")
          .set({ active_target: "platform_server", active_allocation_id: null })
          .where("agent_binding_id", "=", owner.binding_id),
      );
      if (current) {
        executeSync(
          this.db,
          this.query
            .updateTable("vm_allocations")
            .set({ status: "revoked", revoked_at: params.changedAt, updated_at: params.changedAt })
            .where("id", "=", current.id),
        );
      }
      const allocation: VmAllocationRow = {
        id: nextExecutionResourceId(this.idFactory, "vm-allocation"),
        agent_binding_id: owner.binding_id,
        vm_host_id: saved.vm_host_id,
        linux_account: saved.linux_account,
        status: "ready",
        remote_home_dir: saved.remote_home_dir,
        remote_workspace_dir: saved.remote_workspace_dir,
        last_connection_check_at: params.changedAt,
        last_connection_succeeded_at: params.changedAt,
        failure_code: null,
        created_by_user_id: owner.user_id,
        created_at: params.changedAt,
        updated_at: params.changedAt,
        revoked_at: null,
      };
      executeSync(this.db, this.query.insertInto("vm_allocations").values(allocation));
      const credential = takeFirstSync(
        this.db,
        this.query
          .selectFrom("encrypted_user_ssh_credentials")
          .selectAll()
          .where("user_id", "=", owner.user_id),
      );
      const projectedCredential = {
        id: credential?.id ?? nextExecutionResourceId(this.idFactory, "ssh-credential"),
        user_id: owner.user_id,
        ciphertext: saved.credential_ciphertext,
        nonce: saved.credential_nonce,
        auth_tag: saved.credential_auth_tag,
        key_id: saved.credential_key_id,
        format_version: 1,
        revision: (credential?.revision ?? 0) + 1,
        status: "current" as const,
        last_auth_failure_at: null,
        created_at: credential?.created_at ?? params.changedAt,
        updated_at: params.changedAt,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("encrypted_user_ssh_credentials")
          .values(projectedCredential)
          .onConflict((conflict) => conflict.column("user_id").doUpdateSet(projectedCredential)),
      );
      const configurations = executeSync(
        this.db,
        this.query
          .selectFrom("saved_vm_coding_agent_settings")
          .selectAll()
          .where("connection_id", "=", saved.id),
      ).rows;
      if (configurations.length > 0) {
        executeSync(
          this.db,
          this.query.insertInto("vm_allocation_coding_agent_settings").values(
            configurations.map(({ connection_id: _connectionId, ...configuration }) =>
              Object.assign(configuration, {
                allocation_id: allocation.id,
              }),
            ),
          ),
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("personal_execution_profiles")
          .set({
            active_target: "assigned_vm",
            active_allocation_id: allocation.id,
            target_revision: owner.target_revision + 1,
            updated_at: params.changedAt,
          })
          .where("agent_binding_id", "=", owner.binding_id)
          .where("target_revision", "=", params.expectedRevision),
      );
      this.insertAudit(
        owner.user_id,
        "execution.target.changed",
        "agent-binding",
        owner.binding_id,
        params.changedAt,
        { target: "assigned_vm", revision: owner.target_revision + 1, connectionId: saved.id },
      );
    });
    return this.resolvePersonalExecutionTarget(params.agentId);
  }

  async removePersonalSavedVmConnection(
    params: Parameters<ControlPlaneSavedVmConnectionStore["removePersonalSavedVmConnection"]>[0],
  ) {
    runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      const administrativeRemoval = actor.global_role === "admin";
      if (administrativeRemoval) {
        this.requireAdmin(params.actorUserId);
      }
      const owner = administrativeRemoval
        ? this.savedVmOwner(params.agentId, undefined, true)
        : this.savedVmOwner(params.agentId, params.actorUserId);
      const saved = takeFirstSync(
        this.db,
        this.query
          .selectFrom("saved_vm_connections")
          .selectAll()
          .where("id", "=", params.connectionId)
          .where("agent_binding_id", "=", owner.binding_id),
      );
      if (!saved) {
        throw new ControlPlaneStateError("saved VM connection is unavailable");
      }
      if (saved.allocation_id !== null && saved.allocation_id === owner.active_allocation_id) {
        throw new ControlPlaneStateError("switch work location before removing this VM");
      }
      if (saved.allocation_id) {
        const current = this.getVmAllocationForAgentInTransaction(params.agentId);
        if (owner.active_target !== "platform_server" || current?.id !== saved.allocation_id) {
          throw new ControlPlaneConflictError(
            "execution_target_conflict",
            "work location changed before removing its VM connection",
          );
        }
        // Only the sole selected allocation in Basic can use the existing release
        // policy. Detached registrations never erase another target's credential.
        if (owner.user_status === "active" && owner.binding_state === "active") {
          this.releasePersonalVmAccessInTransaction({
            actorUserId: owner.user_id,
            agentId: params.agentId,
            releasedAt: params.removedAt,
          });
        } else {
          this.revokePersonalVmAllocationInTransaction({
            actorUserId: params.actorUserId,
            allocationId: saved.allocation_id,
            releasedAt: params.removedAt,
            requireAdmin: true,
          });
        }
      }
      executeSync(
        this.db,
        this.query.deleteFrom("saved_vm_connections").where("id", "=", saved.id),
      );
      this.insertAudit(
        params.actorUserId,
        "vm.connection.removed",
        "saved-vm-connection",
        saved.id,
        params.removedAt,
      );
    });
  }

  async markSavedVmConnectionUpdateRequired(
    params: Parameters<
      ControlPlaneSavedVmConnectionStore["markSavedVmConnectionUpdateRequired"]
    >[0],
  ) {
    runImmediateTransaction(this.db, () => {
      const owner = this.savedVmOwner(params.agentId, params.actorUserId);
      const saved = takeFirstSync(
        this.db,
        this.query
          .selectFrom("saved_vm_connections")
          .select("revision")
          .where("id", "=", params.connectionId)
          .where("agent_binding_id", "=", owner.binding_id),
      );
      if (!saved || saved.revision !== params.expectedConnectionRevision) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "saved VM credential changed during authentication",
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("saved_vm_connections")
          .set({
            credential_status: "update_required",
            connection_status: "connection_required",
            failure_code: "vm_authentication_failed",
            revision: saved.revision + 1,
            updated_at: params.failedAt,
          })
          .where("id", "=", params.connectionId),
      );
    });
  }
}
