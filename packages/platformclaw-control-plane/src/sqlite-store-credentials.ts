import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import type {
  ControlPlaneAtomicVmCredentialStore,
  ControlPlaneVmAuthenticationFailureStore,
} from "./execution-contracts.js";
import { nextExecutionResourceId } from "./ids.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { rowToAllocation } from "./sqlite-store-execution-mappers.js";
import { SqliteControlPlaneExecutionStore } from "./sqlite-store-execution.js";
import type { EncryptedUserSshCredentialRow } from "./sqlite-store-types.js";
import type {
  ControlPlaneSshCredentialEnvelopeStore,
  StoredUserSshCredential,
  UserSshCredentialMetadata,
} from "./ssh-credential-contracts.js";
import { validateSshCredentialEnvelope } from "./ssh-credential-validation.js";

function rowToStored(row: EncryptedUserSshCredentialRow): StoredUserSshCredential {
  if (row.format_version !== 1) {
    throw new ControlPlaneStateError(
      `unsupported SSH credential format version: ${row.format_version}`,
    );
  }
  return {
    id: row.id,
    userId: row.user_id,
    ciphertext: row.ciphertext.slice(),
    nonce: row.nonce.slice(),
    authTag: row.auth_tag.slice(),
    keyId: row.key_id,
    formatVersion: 1,
    revision: row.revision,
    status: row.status,
    ...(row.last_auth_failure_at === null ? {} : { lastAuthFailureAt: row.last_auth_failure_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMetadata(row: EncryptedUserSshCredentialRow): UserSshCredentialMetadata {
  const { ciphertext: _ciphertext, nonce: _nonce, authTag: _authTag, ...result } = rowToStored(row);
  return result;
}

export abstract class SqliteControlPlaneCredentialStore
  extends SqliteControlPlaneExecutionStore
  implements
    ControlPlaneSshCredentialEnvelopeStore,
    ControlPlaneAtomicVmCredentialStore,
    ControlPlaneVmAuthenticationFailureStore
{
  async commitPersonalVmCredential(
    params: Parameters<ControlPlaneAtomicVmCredentialStore["commitPersonalVmCredential"]>[0],
  ) {
    return runImmediateTransaction(this.db, () => {
      const allocation = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations as a")
          .innerJoin("agent_bindings as b", "b.id", "a.agent_binding_id")
          .innerJoin("platform_users as u", "u.id", "b.user_id")
          .innerJoin("personal_execution_profiles as p", "p.agent_binding_id", "b.id")
          .innerJoin("vm_hosts as h", "h.id", "a.vm_host_id")
          .innerJoin("safeconnect_endpoints as e", "e.id", "h.endpoint_id")
          .innerJoin("browser_sessions as s", "s.user_id", "u.id")
          .leftJoin("encrypted_user_ssh_credentials as c", "c.user_id", "u.id")
          .selectAll("a")
          .select("c.revision as credential_revision")
          .where("a.id", "=", params.expectedAllocationId)
          .where("a.status", "!=", "revoked")
          .where("b.agent_id", "=", params.agentId)
          .where("b.kind", "=", "personal")
          .where("b.state", "=", "active")
          .where("b.user_id", "=", params.actorUserId)
          .where("b.id", "=", params.expectedBindingId)
          .where("u.status", "=", "active")
          .where("h.status", "=", "active")
          .where("e.status", "=", "active")
          .where("s.id", "=", params.expectedSessionId)
          .where("s.revoked_at", "is", null)
          .where("s.idle_expires_at", ">", params.checkedAt)
          .where("s.absolute_expires_at", ">", params.checkedAt)
          .where("p.target_revision", "=", params.expectedTargetRevision),
      );
      if (!allocation || allocation.credential_revision !== params.expectedCredentialRevision) {
        throw new ControlPlaneConflictError(
          "execution_target_conflict",
          "execution target changed before credential verification was committed",
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
      this.replaceCredentialInTransaction({
        actorUserId: params.actorUserId,
        userId: params.actorUserId,
        envelope: params.credentialEnvelope,
        replacedAt: params.checkedAt,
      });
      const { credential_revision: _credentialRevision, ...allocationRow } = allocation;
      const updated = {
        ...allocationRow,
        status: "ready" as const,
        remote_home_dir: params.remoteHomeDir,
        remote_workspace_dir: params.remoteWorkspaceDir,
        last_connection_check_at: params.checkedAt,
        last_connection_succeeded_at: params.checkedAt,
        failure_code: null,
        updated_at: params.checkedAt,
      };
      executeSync(
        this.db,
        this.query.updateTable("vm_allocations").set(updated).where("id", "=", allocation.id),
      );
      this.insertAudit(
        params.actorUserId,
        "vm.connection.succeeded",
        "vm-allocation",
        allocation.id,
        params.checkedAt,
      );
      return rowToAllocation(updated);
    });
  }

  async recordVmAuthenticationFailure(
    params: Parameters<
      ControlPlaneVmAuthenticationFailureStore["recordVmAuthenticationFailure"]
    >[0],
  ): Promise<{ recorded: boolean }> {
    return runImmediateTransaction(this.db, () => {
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("vm_allocations as a")
          .innerJoin("agent_bindings as b", "b.id", "a.agent_binding_id")
          .innerJoin("platform_users as u", "u.id", "b.user_id")
          .innerJoin("personal_execution_profiles as p", "p.agent_binding_id", "b.id")
          .innerJoin("encrypted_user_ssh_credentials as c", "c.user_id", "u.id")
          .innerJoin("vm_hosts as h", "h.id", "a.vm_host_id")
          .innerJoin("safeconnect_endpoints as e", "e.id", "h.endpoint_id")
          .select(["u.id as user_id", "c.id as credential_id"])
          .where("a.id", "=", params.allocationId)
          .where("a.status", "!=", "revoked")
          .where("b.agent_id", "=", params.agentId)
          .where("b.kind", "=", "personal")
          .where("b.state", "=", "active")
          .where("u.status", "=", "active")
          .where("h.status", "=", "active")
          .where("e.status", "=", "active")
          .where("p.active_target", "=", "assigned_vm")
          .where("p.active_allocation_id", "=", params.allocationId)
          .where("p.target_revision", "=", params.targetRevision)
          .where("c.revision", "=", params.credentialRevision)
          .where("c.status", "=", "current"),
      );
      if (!current) {
        return { recorded: false };
      }
      // Existing saved-VM triggers project both writes inside this same commit.
      // A delayed failure must never poison a newer credential or a different VM.
      executeSync(
        this.db,
        this.query
          .updateTable("encrypted_user_ssh_credentials")
          .set({
            status: "update_required",
            last_auth_failure_at: params.failedAt,
            updated_at: params.failedAt,
          })
          .where("id", "=", current.credential_id),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("vm_allocations")
          .set({
            status: "connection_required",
            failure_code: "vm_authentication_failed",
            last_connection_check_at: params.failedAt,
            updated_at: params.failedAt,
          })
          .where("id", "=", params.allocationId),
      );
      this.insertAudit(
        null,
        "ssh-credential.update-required",
        "ssh-credential",
        current.credential_id,
        params.failedAt,
        { revision: params.credentialRevision },
      );
      this.insertAudit(
        null,
        "vm.connection.failed",
        "vm-allocation",
        params.allocationId,
        params.failedAt,
        { failureCode: "vm_authentication_failed" },
      );
      return { recorded: true };
    });
  }

  async replaceEncryptedUserSshCredential(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["replaceEncryptedUserSshCredential"]
    >[0],
  ): Promise<UserSshCredentialMetadata> {
    return runImmediateTransaction(this.db, () => this.replaceCredentialInTransaction(params));
  }

  async commitPersonalVmSelection(
    params: Parameters<ControlPlaneAtomicVmCredentialStore["commitPersonalVmSelection"]>[0],
  ) {
    return runImmediateTransaction(this.db, () => {
      const allocation = this.replacePersonalVmAllocationInTransaction({
        actorUserId: params.actorUserId,
        agentId: params.agentId,
        vmHostId: params.vmHostId,
        linuxAccount: params.linuxAccount,
        remoteHomeDir: params.remoteHomeDir,
        remoteWorkspaceDir: params.remoteWorkspaceDir,
        replacedAt: params.committedAt,
      });
      this.replaceCredentialInTransaction({
        actorUserId: params.actorUserId,
        userId: params.actorUserId,
        envelope: params.credentialEnvelope,
        replacedAt: params.committedAt,
      });
      return allocation;
    });
  }

  async releasePersonalVmAccess(
    params: Parameters<ControlPlaneAtomicVmCredentialStore["releasePersonalVmAccess"]>[0],
  ) {
    return runImmediateTransaction(this.db, () =>
      this.releasePersonalVmAccessInTransaction(params),
    );
  }

  protected releasePersonalVmAccessInTransaction(
    params: Parameters<ControlPlaneAtomicVmCredentialStore["releasePersonalVmAccess"]>[0],
  ) {
    const current = this.getVmAllocationForAgentInTransaction(params.agentId);
    const allocation = current
      ? this.revokePersonalVmAllocationInTransaction({
          actorUserId: params.actorUserId,
          agentId: params.agentId,
          releasedAt: params.releasedAt,
          requireAdmin: false,
        })
      : null;
    this.deleteCredentialInTransaction({
      actorUserId: params.actorUserId,
      userId: params.actorUserId,
      deletedAt: params.releasedAt,
    });
    return allocation;
  }

  async getUserSshCredentialMetadata(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["getUserSshCredentialMetadata"]>[0],
  ): Promise<UserSshCredentialMetadata | null> {
    this.requireSelf(params.actorUserId, params.userId);
    const user = this.requireUserRow(params.userId);
    if (user.status !== "active") {
      throw new ControlPlaneStateError("active user required for SSH credential management");
    }
    const row = this.selectCredential(params.userId);
    return row ? rowToMetadata(row) : null;
  }

  async readEncryptedUserSshCredential(userId: string): Promise<StoredUserSshCredential | null> {
    const row = this.selectCredential(userId);
    if (row && this.requireUserRow(userId).status !== "active") {
      throw new ControlPlaneStateError("active user required for SSH credential resolution");
    }
    return row ? rowToStored(row) : null;
  }

  async markUserSshCredentialUpdateRequired(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["markUserSshCredentialUpdateRequired"]
    >[0],
  ): Promise<UserSshCredentialMetadata | null> {
    return runImmediateTransaction(this.db, () => {
      const row = this.selectCredential(params.userId);
      if (!row) {
        return null;
      }
      if (row.revision !== params.revision) {
        return rowToMetadata(row);
      }
      executeSync(
        this.db,
        this.query
          .updateTable("encrypted_user_ssh_credentials")
          .set({
            status: "update_required",
            last_auth_failure_at: params.failedAt,
            updated_at: params.failedAt,
          })
          .where("id", "=", row.id),
      );
      const updated = {
        ...row,
        status: "update_required" as const,
        last_auth_failure_at: params.failedAt,
        updated_at: params.failedAt,
      };
      this.insertAudit(
        null,
        "ssh-credential.update-required",
        "ssh-credential",
        row.id,
        params.failedAt,
        { revision: row.revision },
      );
      return rowToMetadata(updated);
    });
  }

  async deleteUserSshCredential(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["deleteUserSshCredential"]>[0],
  ): Promise<boolean> {
    return runImmediateTransaction(this.db, () => this.deleteCredentialInTransaction(params));
  }

  private replaceCredentialInTransaction(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["replaceEncryptedUserSshCredential"]
    >[0],
  ): UserSshCredentialMetadata {
    this.requireSelf(params.actorUserId, params.userId);
    const user = this.requireUserRow(params.userId);
    if (user.status !== "active") {
      throw new ControlPlaneStateError("active user required for SSH credential management");
    }
    validateSshCredentialEnvelope(params.envelope);
    const existing = this.selectCredential(params.userId);
    const row: EncryptedUserSshCredentialRow = {
      id: existing?.id ?? nextExecutionResourceId(this.idFactory, "ssh-credential"),
      user_id: params.userId,
      ciphertext: params.envelope.ciphertext.slice(),
      nonce: params.envelope.nonce.slice(),
      auth_tag: params.envelope.authTag.slice(),
      key_id: params.envelope.keyId,
      format_version: params.envelope.formatVersion,
      revision: (existing?.revision ?? 0) + 1,
      status: "current",
      last_auth_failure_at: null,
      created_at: existing?.created_at ?? params.replacedAt,
      updated_at: params.replacedAt,
    };
    if (existing) {
      executeSync(
        this.db,
        this.query
          .updateTable("encrypted_user_ssh_credentials")
          .set(row)
          .where("id", "=", existing.id),
      );
    } else {
      executeSync(this.db, this.query.insertInto("encrypted_user_ssh_credentials").values(row));
    }
    this.insertAudit(
      params.actorUserId,
      existing ? "ssh-credential.replaced" : "ssh-credential.created",
      "ssh-credential",
      row.id,
      params.replacedAt,
      { revision: row.revision },
    );
    return rowToMetadata(row);
  }

  private deleteCredentialInTransaction(
    params: Parameters<ControlPlaneSshCredentialEnvelopeStore["deleteUserSshCredential"]>[0],
  ): boolean {
    this.requireSelf(params.actorUserId, params.userId);
    const user = this.requireUserRow(params.userId);
    if (user.status !== "active") {
      throw new ControlPlaneStateError("active user required for SSH credential management");
    }
    const row = this.selectCredential(params.userId);
    if (!row) {
      return false;
    }
    executeSync(
      this.db,
      this.query.deleteFrom("encrypted_user_ssh_credentials").where("id", "=", row.id),
    );
    this.insertAudit(
      params.actorUserId,
      "ssh-credential.deleted",
      "ssh-credential",
      row.id,
      params.deletedAt,
      { revision: row.revision },
    );
    return true;
  }

  private requireSelf(actorUserId: string, userId: string): void {
    if (actorUserId !== userId) {
      throw new ControlPlaneAuthorizationError("users may manage only their own SSH credential");
    }
  }

  private selectCredential(userId: string): EncryptedUserSshCredentialRow | undefined {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("encrypted_user_ssh_credentials")
        .selectAll()
        .where("user_id", "=", userId),
    );
  }
}
