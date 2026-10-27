import type { DatabaseSync } from "node:sqlite";

const EXEC_CREDENTIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS exec_credential_definitions (
  env_name TEXT PRIMARY KEY,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS encrypted_user_exec_credentials (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  env_name TEXT NOT NULL REFERENCES exec_credential_definitions(env_name) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, env_name)
) STRICT;
CREATE INDEX IF NOT EXISTS encrypted_user_exec_credentials_user
  ON encrypted_user_exec_credentials(user_id, env_name);
`;

const EXEC_CREDENTIAL_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS exec_credential_definition_tokens (
  env_name TEXT PRIMARY KEY REFERENCES exec_credential_definitions(env_name) ON DELETE CASCADE,
  token TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS exec_credential_value_tokens (
  user_id TEXT NOT NULL,
  env_name TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (user_id, env_name),
  FOREIGN KEY (user_id, env_name)
    REFERENCES encrypted_user_exec_credentials(user_id, env_name) ON DELETE CASCADE
) STRICT;
CREATE TRIGGER IF NOT EXISTS exec_credential_definition_token_insert
AFTER INSERT ON exec_credential_definitions
BEGIN
  INSERT INTO exec_credential_definition_tokens (env_name, token)
  VALUES (NEW.env_name, lower(hex(randomblob(32))));
END;
CREATE TRIGGER IF NOT EXISTS exec_credential_value_token_insert
AFTER INSERT ON encrypted_user_exec_credentials
BEGIN
  INSERT INTO exec_credential_value_tokens (user_id, env_name, token)
  VALUES (NEW.user_id, NEW.env_name, lower(hex(randomblob(32))));
END;
CREATE TRIGGER IF NOT EXISTS exec_credential_value_token_update
AFTER UPDATE ON encrypted_user_exec_credentials
BEGIN
  UPDATE exec_credential_value_tokens SET token = lower(hex(randomblob(32)))
  WHERE user_id = NEW.user_id AND env_name = NEW.env_name;
END;
INSERT OR IGNORE INTO exec_credential_definition_tokens (env_name, token)
SELECT env_name, lower(hex(randomblob(32))) FROM exec_credential_definitions;
INSERT OR IGNORE INTO exec_credential_value_tokens (user_id, env_name, token)
SELECT user_id, env_name, lower(hex(randomblob(32))) FROM encrypted_user_exec_credentials;
`;

/** Additive personal exec credential tables; older readers keep their schema version. */
export function ensureExecCredentialSchema(db: DatabaseSync): void {
  db.exec(EXEC_CREDENTIAL_SCHEMA);
}

/** Opaque generations survive reopen and distinguish delete/recreate even at the same timestamp. */
export function ensureExecCredentialSnapshotSchema(db: DatabaseSync): void {
  // Database triggers also cover older writers; metadata reads never need encrypted envelopes.
  db.exec(EXEC_CREDENTIAL_SNAPSHOT_SCHEMA);
}
