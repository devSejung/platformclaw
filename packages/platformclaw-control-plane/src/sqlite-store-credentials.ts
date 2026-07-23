import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { nextExecutionResourceId } from "./ids.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
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
  implements ControlPlaneSshCredentialEnvelopeStore
{
  async replaceEncryptedUserSshCredential(
    params: Parameters<
      ControlPlaneSshCredentialEnvelopeStore["replaceEncryptedUserSshCredential"]
    >[0],
  ): Promise<UserSshCredentialMetadata> {
    return runImmediateTransaction(this.db, () => {
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
    });
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
    return runImmediateTransaction(this.db, () => {
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
    });
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
