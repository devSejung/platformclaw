import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import type {
  ControlPlaneMcpCredentialStore,
  ControlPlaneMcpSettingsStore,
  McpCredentialEnvelope,
  StoredUserMcpCredential,
  UserMcpCredentialMetadata,
  StoredUserMcpSettings,
  UserMcpSettingsMetadata,
} from "./mcp-credential-contracts.js";
import { mcpCredentialFingerprint } from "./mcp-credential-fingerprint.js";
import {
  ensureExecCredentialSchema,
  ensureMcpCredentialSchema,
  ensureMcpUserSettingsSchema,
} from "./sqlite-schema.js";
import type { SqliteControlPlaneStoreOptions } from "./sqlite-store-core.js";
import { SqliteControlPlaneExecCredentialStore } from "./sqlite-store-exec-credentials.js";
import type { EncryptedUserMcpCredentialRow, UserMcpSettingsRow } from "./sqlite-store-types.js";

function normalizeServerName(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 128 ||
    normalized.includes("\0") ||
    normalized.includes("\r") ||
    normalized.includes("\n")
  ) {
    throw new ControlPlaneStateError("MCP server name is invalid");
  }
  return normalized;
}

function validateEnvelope(envelope: McpCredentialEnvelope): void {
  if (
    envelope.formatVersion !== 1 ||
    envelope.ciphertext.byteLength < 1 ||
    envelope.ciphertext.byteLength > 64 * 1024 ||
    envelope.nonce.byteLength !== 12 ||
    envelope.authTag.byteLength !== 16 ||
    !envelope.keyId.trim()
  ) {
    throw new ControlPlaneStateError("MCP credential envelope is invalid");
  }
}

function rowToStored(row: EncryptedUserMcpCredentialRow): StoredUserMcpCredential {
  if (row.format_version !== 1) {
    throw new ControlPlaneStateError(
      `unsupported MCP credential format version: ${row.format_version}`,
    );
  }
  return {
    userId: row.user_id,
    serverName: row.server_name,
    kind: row.kind,
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

function rowToMetadata(row: EncryptedUserMcpCredentialRow): UserMcpCredentialMetadata {
  const {
    ciphertext: _ciphertext,
    nonce: _nonce,
    authTag: _authTag,
    keyId: _keyId,
    formatVersion: _formatVersion,
    ...metadata
  } = rowToStored(row);
  return metadata;
}

function settingsMetadata(row: UserMcpSettingsRow): UserMcpSettingsMetadata {
  return {
    userId: row.user_id,
    serverName: row.server_name,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storedSettings(row: UserMcpSettingsRow): StoredUserMcpSettings {
  if (row.format_version !== 1) {
    throw new ControlPlaneStateError("unsupported MCP user settings format");
  }
  return {
    ...settingsMetadata(row),
    ciphertext: row.ciphertext.slice(),
    nonce: row.nonce.slice(),
    authTag: row.auth_tag.slice(),
    keyId: row.key_id,
    formatVersion: 1,
  };
}

export abstract class SqliteControlPlaneMcpStore
  extends SqliteControlPlaneExecCredentialStore
  implements ControlPlaneMcpCredentialStore, ControlPlaneMcpSettingsStore
{
  private mcpUserSettingsReady = false;

  protected ensureMcpUserSettings(): void {
    if (!this.mcpUserSettingsReady) {
      ensureMcpUserSettingsSchema(this.db);
      this.mcpUserSettingsReady = true;
    }
  }
  constructor(options: SqliteControlPlaneStoreOptions) {
    super(options);
    // Additive feature surface: existing schema-v2 databases keep their version.
    ensureMcpCredentialSchema(this.db);
    ensureExecCredentialSchema(this.db);
  }

  async replaceEncryptedUserMcpCredential(
    params: Parameters<ControlPlaneMcpCredentialStore["replaceEncryptedUserMcpCredential"]>[0],
  ): Promise<UserMcpCredentialMetadata> {
    const serverName = normalizeServerName(params.serverName);
    validateEnvelope(params.envelope);
    return runImmediateTransaction(this.db, () =>
      this.replaceMcpCredentialInTransaction(params, serverName),
    );
  }

  private replaceMcpCredentialInTransaction(
    params: Parameters<ControlPlaneMcpCredentialStore["replaceEncryptedUserMcpCredential"]>[0] & {
      expectedFingerprint?: string | null;
    },
    serverName: string,
  ): UserMcpCredentialMetadata {
    const actor = this.requireUserRow(params.actorUserId);
    const target = this.requireUserRow(params.userId);
    if (
      actor.status !== "active" ||
      target.status !== "active" ||
      (actor.id !== target.id && actor.global_role !== "admin")
    ) {
      throw new ControlPlaneAuthorizationError("MCP credential owner or administrator required");
    }
    const existing = takeFirstSync(
      this.db,
      this.query
        .selectFrom("encrypted_user_mcp_credentials")
        .selectAll()
        .where("user_id", "=", target.id)
        .where("server_name", "=", serverName),
    );
    if (
      params.expectedFingerprint !== undefined &&
      (existing ? mcpCredentialFingerprint(rowToStored(existing)) : null) !==
        params.expectedFingerprint
    ) {
      throw new ControlPlaneStateError(
        "MCP credential changed during update. Reload settings before replacing it.",
      );
    }
    if (
      params.expectedRevision !== undefined &&
      (existing?.revision ?? 0) !== params.expectedRevision
    ) {
      throw new ControlPlaneStateError("MCP credential changed during update");
    }
    const row: EncryptedUserMcpCredentialRow = {
      user_id: target.id,
      server_name: serverName,
      kind: params.kind,
      ciphertext: params.envelope.ciphertext.slice(),
      nonce: params.envelope.nonce.slice(),
      auth_tag: params.envelope.authTag.slice(),
      key_id: params.envelope.keyId,
      format_version: 1,
      revision: (existing?.revision ?? 0) + 1,
      created_at: existing?.created_at ?? params.updatedAt,
      updated_at: params.updatedAt,
    };
    executeSync(
      this.db,
      this.query
        .insertInto("encrypted_user_mcp_credentials")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["user_id", "server_name"]).doUpdateSet({
            kind: row.kind,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            auth_tag: row.auth_tag,
            key_id: row.key_id,
            format_version: row.format_version,
            revision: row.revision,
            updated_at: row.updated_at,
          }),
        ),
    );
    this.insertAudit(
      actor.id,
      existing ? "mcp.credential.replaced" : "mcp.credential.created",
      "mcp-server",
      serverName,
      params.updatedAt,
      { userId: target.id, kind: params.kind, revision: row.revision },
    );
    return rowToMetadata(row);
  }

  async readEncryptedUserMcpCredential(
    userId: string,
    serverName: string,
  ): Promise<StoredUserMcpCredential | null> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("encrypted_user_mcp_credentials")
        .selectAll()
        .where("user_id", "=", userId)
        .where("server_name", "=", normalizeServerName(serverName)),
    );
    return row ? rowToStored(row) : null;
  }

  async readEncryptedMcpCredentialForAgent(
    agentId: string,
    serverName: string,
  ): Promise<StoredUserMcpCredential | null> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("encrypted_user_mcp_credentials")
        .innerJoin(
          "agent_bindings",
          "agent_bindings.user_id",
          "encrypted_user_mcp_credentials.user_id",
        )
        .innerJoin("platform_users", "platform_users.id", "encrypted_user_mcp_credentials.user_id")
        .selectAll("encrypted_user_mcp_credentials")
        .where("agent_bindings.agent_id", "=", agentId.trim())
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active")
        .where("encrypted_user_mcp_credentials.server_name", "=", normalizeServerName(serverName)),
    );
    return row ? rowToStored(row) : null;
  }

  async listUserMcpCredentials(userId: string): Promise<UserMcpCredentialMetadata[]> {
    this.requireUserRow(userId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("encrypted_user_mcp_credentials")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("server_name"),
    ).rows.map(rowToMetadata);
  }

  async deleteUserMcpCredential(
    params: Parameters<ControlPlaneMcpCredentialStore["deleteUserMcpCredential"]>[0],
  ): Promise<boolean> {
    const serverName = normalizeServerName(params.serverName);
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      const target = this.requireUserRow(params.userId);
      if (actor.status !== "active" || (actor.id !== target.id && actor.global_role !== "admin")) {
        throw new ControlPlaneAuthorizationError("MCP credential owner or administrator required");
      }
      const result = executeSync(
        this.db,
        this.query
          .deleteFrom("encrypted_user_mcp_credentials")
          .where("user_id", "=", target.id)
          .where("server_name", "=", serverName),
      );
      if (Number(result.numAffectedRows ?? 0) > 0) {
        this.insertAudit(
          actor.id,
          "mcp.credential.deleted",
          "mcp-server",
          serverName,
          params.deletedAt,
          { userId: target.id },
        );
        return true;
      }
      return false;
    });
  }

  async deleteAllUserMcpCredentials(
    params: Parameters<ControlPlaneMcpCredentialStore["deleteAllUserMcpCredentials"]>[0],
  ): Promise<number> {
    const deleted = runImmediateTransaction(this.db, () => {
      const actor = this.requireAdmin(params.actorUserId);
      this.requireUserRow(params.userId);
      const agentId = executeSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .select("agent_id")
          .where("user_id", "=", params.userId)
          .where("kind", "=", "personal"),
      ).rows[0]?.agent_id;
      const result = executeSync(
        this.db,
        this.query
          .deleteFrom("encrypted_user_mcp_credentials")
          .where("user_id", "=", params.userId),
      );
      const count = Number(result.numAffectedRows ?? 0);
      if (count > 0) {
        this.insertAudit(
          actor.id,
          "mcp.credentials.deleted",
          "user",
          params.userId,
          params.deletedAt,
          {
            count,
          },
        );
      }
      return { agentId, count };
    });
    // Revocation is idempotent: retry even if an earlier delete committed but
    // its callback failed before the credential-bearing runtime was disposed.
    if (deleted.agentId && this.onAgentCredentialsRevoked) {
      await this.onAgentCredentialsRevoked(deleted.agentId);
    }
    return deleted.count;
  }

  async replaceEncryptedUserMcpSettings(
    params: Parameters<ControlPlaneMcpSettingsStore["replaceEncryptedUserMcpSettings"]>[0],
  ): ReturnType<ControlPlaneMcpSettingsStore["replaceEncryptedUserMcpSettings"]> {
    this.ensureMcpUserSettings();
    const serverName = normalizeServerName(params.serverName);
    validateEnvelope(params.envelope);
    if (
      !Number.isSafeInteger(params.expectedRevision) ||
      params.expectedRevision < 0 ||
      typeof params.enabled !== "boolean"
    ) {
      throw new ControlPlaneStateError("MCP user settings revision or enabled state is invalid");
    }
    if (params.credential) {
      validateEnvelope(params.credential.envelope);
      if (
        params.credential.expectedFingerprint !== null &&
        (typeof params.credential.expectedFingerprint !== "string" ||
          !/^[a-f0-9]{64}$/u.test(params.credential.expectedFingerprint))
      ) {
        throw new ControlPlaneStateError("MCP credential fingerprint is invalid");
      }
    }
    return runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      const target = this.requireUserRow(params.userId);
      if (
        actor.status !== "active" ||
        target.status !== "active" ||
        (actor.id !== target.id && actor.global_role !== "admin")
      ) {
        throw new ControlPlaneAuthorizationError("MCP settings owner or administrator required");
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("user_mcp_settings")
          .selectAll()
          .where("user_id", "=", target.id)
          .where("server_name", "=", serverName),
      );
      if ((existing?.revision ?? 0) !== params.expectedRevision) {
        throw new ControlPlaneStateError("MCP user settings changed during update");
      }
      // Credential replacement and preferences are one browser Save. Keep both
      // CAS checks inside this commit so neither half can survive a stale edit.
      const credential = params.credential
        ? this.replaceMcpCredentialInTransaction(
            {
              actorUserId: actor.id,
              userId: target.id,
              serverName,
              kind: params.credential.kind,
              envelope: params.credential.envelope,
              updatedAt: params.updatedAt,
              expectedFingerprint: params.credential.expectedFingerprint,
            },
            serverName,
          )
        : undefined;
      const row: UserMcpSettingsRow = {
        user_id: target.id,
        server_name: serverName,
        enabled: params.enabled ? 1 : 0,
        ciphertext: params.envelope.ciphertext.slice(),
        nonce: params.envelope.nonce.slice(),
        auth_tag: params.envelope.authTag.slice(),
        key_id: params.envelope.keyId,
        format_version: 1,
        revision: (existing?.revision ?? 0) + 1,
        created_at: existing?.created_at ?? params.updatedAt,
        updated_at: params.updatedAt,
      };
      executeSync(
        this.db,
        this.query
          .insertInto("user_mcp_settings")
          .values(row)
          .onConflict((conflict) =>
            conflict.columns(["user_id", "server_name"]).doUpdateSet({
              enabled: row.enabled,
              ciphertext: row.ciphertext,
              nonce: row.nonce,
              auth_tag: row.auth_tag,
              key_id: row.key_id,
              format_version: row.format_version,
              revision: row.revision,
              updated_at: row.updated_at,
            }),
          ),
      );
      this.insertAudit(
        actor.id,
        "mcp.settings.updated",
        "mcp-server",
        serverName,
        params.updatedAt,
        { userId: target.id, enabled: params.enabled, revision: row.revision },
      );
      return { settings: settingsMetadata(row), ...(credential ? { credential } : {}) };
    });
  }

  async readEncryptedUserMcpSettings(
    userId: string,
    serverName: string,
  ): Promise<StoredUserMcpSettings | null> {
    this.ensureMcpUserSettings();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("user_mcp_settings")
        .selectAll()
        .where("user_id", "=", userId)
        .where("server_name", "=", normalizeServerName(serverName)),
    );
    return row ? storedSettings(row) : null;
  }

  async readEncryptedMcpSettingsForAgent(
    agentId: string,
    serverName: string,
  ): Promise<StoredUserMcpSettings | null> {
    this.ensureMcpUserSettings();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("user_mcp_settings")
        .innerJoin("agent_bindings", "agent_bindings.user_id", "user_mcp_settings.user_id")
        .innerJoin("platform_users", "platform_users.id", "user_mcp_settings.user_id")
        .selectAll("user_mcp_settings")
        .where("agent_bindings.agent_id", "=", agentId.trim())
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active")
        .where("user_mcp_settings.server_name", "=", normalizeServerName(serverName)),
    );
    return row ? storedSettings(row) : null;
  }

  async listUserMcpSettings(userId: string): Promise<UserMcpSettingsMetadata[]> {
    this.ensureMcpUserSettings();
    this.requireUserRow(userId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("user_mcp_settings")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("server_name"),
    ).rows.map(settingsMetadata);
  }

  async getActivePersonalMcpOwner(agentId: string): Promise<string | null> {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .innerJoin("platform_users", "platform_users.id", "agent_bindings.user_id")
        .select("platform_users.id")
        .where("agent_bindings.agent_id", "=", agentId.trim())
        .where("agent_bindings.kind", "=", "personal")
        .where("agent_bindings.state", "=", "active")
        .where("platform_users.status", "=", "active"),
    );
    return row?.id ?? null;
  }

  async getActiveCommonMcpAgent(agentId: string): Promise<boolean> {
    // Only registered room agents may use ownerless shared connections. A
    // disabled personal owner must never fall through to the shared path.
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .select("id")
        .where("agent_id", "=", agentId.trim())
        .where("kind", "=", "knox-room")
        .where("state", "=", "active"),
    );
    return Boolean(row);
  }

  async createMcpOAuthState(
    params: Parameters<ControlPlaneMcpCredentialStore["createMcpOAuthState"]>[0],
  ): Promise<void> {
    runImmediateTransaction(this.db, () => {
      const user = this.requireUserRow(params.userId);
      if (user.status !== "active") {
        throw new ControlPlaneStateError("active user required for MCP OAuth");
      }
      executeSync(
        this.db,
        this.query.deleteFrom("mcp_oauth_states").where("expires_at", "<=", params.createdAt),
      );
      // One persisted verifier exists per user/server. Supersede every prior
      // state before issuing a new one so callbacks cannot cross PKCE flows.
      executeSync(
        this.db,
        this.query
          .deleteFrom("mcp_oauth_states")
          .where("user_id", "=", user.id)
          .where("server_name", "=", normalizeServerName(params.serverName)),
      );
      executeSync(
        this.db,
        this.query.insertInto("mcp_oauth_states").values({
          state_hash: params.stateHash,
          user_id: user.id,
          server_name: normalizeServerName(params.serverName),
          expires_at: params.expiresAt,
          created_at: params.createdAt,
        }),
      );
    });
  }

  async deleteMcpOAuthStates(userId: string, serverName: string): Promise<number> {
    return runImmediateTransaction(this.db, () => {
      const user = this.requireUserRow(userId);
      if (user.status !== "active") {
        throw new ControlPlaneStateError("active user required for MCP OAuth");
      }
      const result = executeSync(
        this.db,
        this.query
          .deleteFrom("mcp_oauth_states")
          .where("user_id", "=", user.id)
          .where("server_name", "=", normalizeServerName(serverName)),
      );
      return Number(result.numAffectedRows ?? 0);
    });
  }

  async consumeMcpOAuthState(
    stateHash: string,
    consumedAt: number,
  ): Promise<{ userId: string; serverName: string } | null> {
    return runImmediateTransaction(this.db, () => {
      const row = takeFirstSync(
        this.db,
        this.query.selectFrom("mcp_oauth_states").selectAll().where("state_hash", "=", stateHash),
      );
      executeSync(
        this.db,
        this.query.deleteFrom("mcp_oauth_states").where("state_hash", "=", stateHash),
      );
      if (!row || row.expires_at <= consumedAt) {
        return null;
      }
      return { userId: row.user_id, serverName: row.server_name };
    });
  }
}
