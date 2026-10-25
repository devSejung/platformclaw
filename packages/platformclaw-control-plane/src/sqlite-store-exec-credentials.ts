import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  EXEC_CREDENTIAL_LIMITS,
  normalizeExecEnvName,
  type ExecCredentialDefinition,
  type ExecCredentialEnvelope,
  type ExecCredentialPreconditions,
  type StoredExecCredential,
} from "./exec-credential-contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { ensureExecCredentialSnapshotSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneCredentialStore } from "./sqlite-store-credentials.js";
import type { EncryptedUserExecCredentialRow } from "./sqlite-store-types.js";

function stored(row: EncryptedUserExecCredentialRow): StoredExecCredential {
  if (row.format_version !== 1) {
    throw new ControlPlaneStateError("unsupported exec credential format");
  }
  return {
    userId: row.user_id,
    envName: row.env_name,
    ciphertext: row.ciphertext.slice(),
    nonce: row.nonce.slice(),
    authTag: row.auth_tag.slice(),
    keyId: row.key_id,
    formatVersion: 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export abstract class SqliteControlPlaneExecCredentialStore extends SqliteControlPlaneCredentialStore {
  private execCredentialSnapshotsReady = false;

  private ensureExecCredentialSnapshots(): void {
    if (!this.execCredentialSnapshotsReady) {
      ensureExecCredentialSnapshotSchema(this.db);
      this.execCredentialSnapshotsReady = true;
    }
  }

  private requireActiveExecOwner(userId: string) {
    const user = this.requireUserRow(userId);
    if (user.status !== "active") {
      throw new ControlPlaneAuthorizationError("active credential owner required");
    }
    return user;
  }

  private requireExecCredentialSnapshot(
    userId: string,
    envName: string,
    expected: ExecCredentialPreconditions,
  ) {
    const snapshot = takeFirstSync(
      this.db,
      this.query
        .selectFrom("exec_credential_definition_tokens")
        .leftJoin("exec_credential_value_tokens", (join) =>
          join
            .onRef(
              "exec_credential_value_tokens.env_name",
              "=",
              "exec_credential_definition_tokens.env_name",
            )
            .on("exec_credential_value_tokens.user_id", "=", userId),
        )
        .select([
          "exec_credential_definition_tokens.token as definitionToken",
          "exec_credential_value_tokens.token as credentialToken",
        ])
        .where("exec_credential_definition_tokens.env_name", "=", envName),
    );
    if (
      !snapshot ||
      snapshot.definitionToken !== expected.expectedDefinitionToken ||
      snapshot.credentialToken !== expected.expectedCredentialToken
    ) {
      throw new ControlPlaneConflictError(
        "credential-changed",
        "Credential changed. Reload before saving.",
      );
    }
    return snapshot;
  }

  async listExecCredentialMetadataForAgent(
    agentId: string,
  ): Promise<ExecCredentialDefinition[] | null> {
    const owner = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .select("platform_users.id as user_id")
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active"),
    );
    // Metadata reads must never load encrypted envelopes or infer ownership from tool arguments.
    return owner ? this.listExecCredentialDefinitions(owner.user_id) : null;
  }

  async listExecCredentialDefinitions(userId?: string): Promise<ExecCredentialDefinition[]> {
    this.ensureExecCredentialSnapshots();
    if (!userId) {
      return executeSync(
        this.db,
        this.query.selectFrom("exec_credential_definition_tokens").selectAll().orderBy("env_name"),
      ).rows.map((row) => ({
        envName: row.env_name,
        definitionToken: row.token,
        credentialToken: null,
      }));
    }
    this.requireActiveExecOwner(userId);
    const rows = executeSync(
      this.db,
      this.query
        .selectFrom("exec_credential_definitions")
        .innerJoin(
          "exec_credential_definition_tokens",
          "exec_credential_definition_tokens.env_name",
          "exec_credential_definitions.env_name",
        )
        .leftJoin("encrypted_user_exec_credentials", (join) =>
          join
            .onRef(
              "encrypted_user_exec_credentials.env_name",
              "=",
              "exec_credential_definitions.env_name",
            )
            .on("encrypted_user_exec_credentials.user_id", "=", userId),
        )
        .leftJoin("exec_credential_value_tokens", (join) =>
          join
            .onRef(
              "exec_credential_value_tokens.env_name",
              "=",
              "exec_credential_definitions.env_name",
            )
            .on("exec_credential_value_tokens.user_id", "=", userId),
        )
        .select([
          "exec_credential_definitions.env_name as env_name",
          "exec_credential_definition_tokens.token as definition_token",
          "exec_credential_value_tokens.token as credential_token",
          "encrypted_user_exec_credentials.revision as revision",
          "encrypted_user_exec_credentials.updated_at as updated_at",
        ])
        .orderBy("exec_credential_definitions.env_name"),
    ).rows;
    return rows.map((row) => {
      const definition: ExecCredentialDefinition = {
        envName: row.env_name,
        definitionToken: row.definition_token,
        credentialToken: row.credential_token,
        configured: row.revision !== null,
      };
      if (row.revision !== null) {
        definition.revision = row.revision;
      }
      if (row.updated_at !== null) {
        definition.updatedAt = row.updated_at;
      }
      return definition;
    });
  }

  async addExecCredentialDefinition(
    actorUserId: string,
    rawName: string,
    createdAt: number,
  ): Promise<void> {
    this.ensureExecCredentialSnapshots();
    const envName = normalizeExecEnvName(rawName);
    runImmediateTransaction(this.db, () => {
      const actor = this.requireAdmin(actorUserId);
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("exec_credential_definitions")
          .select("env_name")
          .where("env_name", "=", envName),
      );
      if (existing) {
        return;
      }
      const count = executeSync(
        this.db,
        this.query.selectFrom("exec_credential_definitions").select("env_name"),
      ).rows.length;
      if (count >= EXEC_CREDENTIAL_LIMITS.perUser) {
        throw new ControlPlaneStateError("exec credential definition limit reached");
      }
      executeSync(
        this.db,
        this.query
          .insertInto("exec_credential_definitions")
          .values({
            env_name: envName,
            created_by_user_id: actor.id,
            created_at: createdAt,
          })
          .onConflict((conflict) => conflict.column("env_name").doNothing()),
      );
      this.insertAudit(
        actor.id,
        "exec-credential.definition.added",
        "environment-variable",
        envName,
        createdAt,
      );
    });
  }

  async removeExecCredentialDefinition(params: {
    actorUserId: string;
    envName: string;
    expectedDefinitionToken: string;
    deletedAt: number;
  }): Promise<boolean> {
    this.ensureExecCredentialSnapshots();
    const envName = normalizeExecEnvName(params.envName);
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireAdmin(params.actorUserId);
      const definition = takeFirstSync(
        this.db,
        this.query
          .selectFrom("exec_credential_definition_tokens")
          .select("token")
          .where("env_name", "=", envName),
      );
      if (definition?.token !== params.expectedDefinitionToken) {
        throw new ControlPlaneConflictError(
          "credential-changed",
          "Credential changed. Reload before deleting.",
        );
      }
      const result = executeSync(
        this.db,
        this.query.deleteFrom("exec_credential_definitions").where("env_name", "=", envName),
      );
      const deleted = Number(result.numAffectedRows ?? 0) > 0;
      if (deleted) {
        this.insertAudit(
          actor.id,
          "exec-credential.definition.removed",
          "environment-variable",
          envName,
          params.deletedAt,
        );
      }
      return deleted;
    });
  }

  async replaceExecCredential(
    params: {
      actorUserId: string;
      envName: string;
      envelope: ExecCredentialEnvelope;
      updatedAt: number;
    } & ExecCredentialPreconditions,
  ) {
    this.ensureExecCredentialSnapshots();
    const envName = normalizeExecEnvName(params.envName);
    return runImmediateTransaction(this.db, () => {
      const user = this.requireActiveExecOwner(params.actorUserId);
      const snapshot = this.requireExecCredentialSnapshot(user.id, envName, params);
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("encrypted_user_exec_credentials")
          .selectAll()
          .where("user_id", "=", user.id)
          .where("env_name", "=", envName),
      );
      const aggregate =
        executeSync(
          this.db,
          this.query
            .selectFrom("encrypted_user_exec_credentials")
            .select("ciphertext")
            .where("user_id", "=", user.id),
        ).rows.reduce((sum, row) => sum + row.ciphertext.byteLength, 0) -
        (existing?.ciphertext.byteLength ?? 0) +
        params.envelope.ciphertext.byteLength;
      if (aggregate > EXEC_CREDENTIAL_LIMITS.aggregateBytes) {
        throw new ControlPlaneStateError("exec credential aggregate limit reached");
      }
      const revision = (existing?.revision ?? 0) + 1;
      executeSync(
        this.db,
        this.query
          .insertInto("encrypted_user_exec_credentials")
          .values({
            user_id: user.id,
            env_name: envName,
            ciphertext: params.envelope.ciphertext.slice(),
            nonce: params.envelope.nonce.slice(),
            auth_tag: params.envelope.authTag.slice(),
            key_id: params.envelope.keyId,
            format_version: 1,
            revision,
            created_at: existing?.created_at ?? params.updatedAt,
            updated_at: params.updatedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["user_id", "env_name"]).doUpdateSet({
              ciphertext: params.envelope.ciphertext.slice(),
              nonce: params.envelope.nonce.slice(),
              auth_tag: params.envelope.authTag.slice(),
              key_id: params.envelope.keyId,
              format_version: 1,
              revision,
              updated_at: params.updatedAt,
            }),
          ),
      );
      this.insertAudit(
        user.id,
        existing ? "exec-credential.replaced" : "exec-credential.created",
        "environment-variable",
        envName,
        params.updatedAt,
        { revision },
      );
      const token = takeFirstSync(
        this.db,
        this.query
          .selectFrom("exec_credential_value_tokens")
          .select("token")
          .where("user_id", "=", user.id)
          .where("env_name", "=", envName),
      );
      if (!token) {
        throw new ControlPlaneStateError("credential snapshot is unavailable");
      }
      return { revision, definitionToken: snapshot.definitionToken, credentialToken: token.token };
    });
  }

  async deleteExecCredential(
    params: {
      actorUserId: string;
      envName: string;
      deletedAt: number;
    } & ExecCredentialPreconditions,
  ) {
    this.ensureExecCredentialSnapshots();
    const envName = normalizeExecEnvName(params.envName);
    return runImmediateTransaction(this.db, () => {
      const user = this.requireActiveExecOwner(params.actorUserId);
      const snapshot = this.requireExecCredentialSnapshot(user.id, envName, params);
      const result = executeSync(
        this.db,
        this.query
          .deleteFrom("encrypted_user_exec_credentials")
          .where("user_id", "=", user.id)
          .where("env_name", "=", envName),
      );
      const deleted = Number(result.numAffectedRows ?? 0) > 0;
      if (deleted) {
        this.insertAudit(
          user.id,
          "exec-credential.deleted",
          "environment-variable",
          envName,
          params.deletedAt,
        );
      }
      return { deleted, envName, definitionToken: snapshot.definitionToken, credentialToken: null };
    });
  }

  async readExecCredentialsForAgent(agentId: string): Promise<StoredExecCredential[]> {
    return executeSync(
      this.db,
      this.query
        .selectFrom("encrypted_user_exec_credentials")
        .innerJoin(
          "agent_bindings",
          "agent_bindings.user_id",
          "encrypted_user_exec_credentials.user_id",
        )
        .innerJoin("platform_users", "platform_users.id", "encrypted_user_exec_credentials.user_id")
        .selectAll("encrypted_user_exec_credentials")
        .where("agent_bindings.agent_id", "=", agentId)
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active")
        .orderBy("encrypted_user_exec_credentials.env_name"),
    ).rows.map(stored);
  }
}
