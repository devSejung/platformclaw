import type { DatabaseSync } from "node:sqlite";

const MCP_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS encrypted_user_mcp_credentials (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  server_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bearer', 'api_key', 'oauth')),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_name)
) STRICT;
CREATE TABLE IF NOT EXISTS mcp_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  server_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS mcp_oauth_states_expiry ON mcp_oauth_states(expires_at);
`;

const MCP_USER_SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_mcp_settings (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  server_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, server_name)
) STRICT;
`;

/** Additive feature table; safe for older schema-v2 readers to ignore. */
export function ensureMcpCredentialSchema(db: DatabaseSync): void {
  db.exec(MCP_CREDENTIAL_SCHEMA);
}

/** Additive user preferences; older readers safely ignore this table. */
export function ensureMcpUserSettingsSchema(db: DatabaseSync): void {
  db.exec(MCP_USER_SETTINGS_SCHEMA);
}
