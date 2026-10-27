import type { DatabaseSync } from "node:sqlite";

// Registrations survive target changes; the original allocation remains the one
// runtime projection so downgraded readers keep their single-allocation contract.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS saved_vm_connections (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  agent_binding_id TEXT NOT NULL REFERENCES agent_bindings(id) ON DELETE CASCADE,
  vm_host_id TEXT NOT NULL REFERENCES vm_hosts(id) ON DELETE RESTRICT,
  linux_account TEXT NOT NULL,
  allocation_id TEXT UNIQUE REFERENCES vm_allocations(id),
  endpoint_identity TEXT NOT NULL,
  remote_home_dir TEXT,
  remote_workspace_dir TEXT,
  last_connection_succeeded_at INTEGER,
  connection_status TEXT NOT NULL CHECK (connection_status IN ('ready', 'connection_required')),
  failure_code TEXT,
  credential_ciphertext BLOB,
  credential_nonce BLOB CHECK (credential_nonce IS NULL OR length(credential_nonce) = 12),
  credential_auth_tag BLOB CHECK (credential_auth_tag IS NULL OR length(credential_auth_tag) = 16),
  credential_key_id TEXT,
  credential_format_version INTEGER CHECK (credential_format_version IS NULL OR credential_format_version = 1),
  credential_status TEXT NOT NULL CHECK (credential_status IN ('current', 'update_required', 'missing')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (agent_binding_id, vm_host_id),
  UNIQUE (vm_host_id, linux_account)
) STRICT;
CREATE TABLE IF NOT EXISTS saved_vm_coding_agent_settings (
  connection_id TEXT NOT NULL REFERENCES saved_vm_connections(id) ON DELETE CASCADE,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex', 'opencode')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  executable_path TEXT NOT NULL,
  environment_json TEXT,
  last_check_json TEXT,
  updated_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (connection_id, agent)
) STRICT;
CREATE TRIGGER IF NOT EXISTS saved_vm_allocation_reservation_insert
BEFORE INSERT ON vm_allocations WHEN NEW.status != 'revoked' AND EXISTS (
  SELECT 1 FROM saved_vm_connections WHERE vm_host_id = NEW.vm_host_id
    AND linux_account = NEW.linux_account AND agent_binding_id != NEW.agent_binding_id
)
BEGIN SELECT RAISE(ABORT, 'VM Linux account is reserved by another personal agent'); END;
CREATE TRIGGER IF NOT EXISTS saved_vm_allocation_reservation_update
BEFORE UPDATE OF vm_host_id, linux_account, status ON vm_allocations
WHEN NEW.status != 'revoked' AND EXISTS (
  SELECT 1 FROM saved_vm_connections WHERE vm_host_id = NEW.vm_host_id
    AND linux_account = NEW.linux_account AND agent_binding_id != NEW.agent_binding_id
)
BEGIN SELECT RAISE(ABORT, 'VM Linux account is reserved by another personal agent'); END;
CREATE TRIGGER IF NOT EXISTS saved_vm_allocation_created
AFTER INSERT ON vm_allocations WHEN NEW.status != 'revoked'
BEGIN
  -- Workshop proposals bind to the registration ID. Its destination must never change underneath them.
  SELECT RAISE(ABORT, 'VM identity changed; remove this saved connection and register it again')
  WHERE EXISTS (
    SELECT 1 FROM saved_vm_connections s JOIN vm_hosts h ON h.id = s.vm_host_id
      JOIN safeconnect_endpoints e ON e.id = h.endpoint_id
    WHERE s.agent_binding_id = NEW.agent_binding_id AND s.vm_host_id = NEW.vm_host_id AND (
      s.linux_account != NEW.linux_account OR s.endpoint_identity != json_array(
        e.host, e.port, e.ad_domain, e.host_key_algorithm, e.host_key_public_key, e.host_key_fingerprint, h.target_address
      ) OR (NEW.remote_home_dir IS NOT NULL AND s.remote_home_dir IS NOT NULL AND s.remote_home_dir != NEW.remote_home_dir)
      OR (NEW.remote_workspace_dir IS NOT NULL AND s.remote_workspace_dir IS NOT NULL AND s.remote_workspace_dir != NEW.remote_workspace_dir)
    )
  );
  INSERT INTO saved_vm_connections (
    id, agent_binding_id, vm_host_id, linux_account, allocation_id, endpoint_identity,
    remote_home_dir, remote_workspace_dir, last_connection_succeeded_at,
    credential_status, connection_status, created_at, updated_at
  ) SELECT NEW.id, NEW.agent_binding_id, NEW.vm_host_id,
    NEW.linux_account, NEW.id,
    json_array(e.host, e.port, e.ad_domain, e.host_key_algorithm, e.host_key_public_key,
      e.host_key_fingerprint, h.target_address),
    NEW.remote_home_dir, NEW.remote_workspace_dir, NEW.last_connection_succeeded_at,
    'missing', CASE WHEN NEW.status = 'ready' THEN 'ready' ELSE 'connection_required' END, NEW.created_at, NEW.updated_at
    FROM vm_hosts h JOIN safeconnect_endpoints e ON e.id = h.endpoint_id WHERE h.id = NEW.vm_host_id
  ON CONFLICT(agent_binding_id, vm_host_id) DO UPDATE SET
    allocation_id = excluded.allocation_id,
    credential_status = 'missing',
    remote_home_dir = COALESCE(excluded.remote_home_dir, saved_vm_connections.remote_home_dir),
    remote_workspace_dir = COALESCE(excluded.remote_workspace_dir, saved_vm_connections.remote_workspace_dir),
    last_connection_succeeded_at = COALESCE(excluded.last_connection_succeeded_at, saved_vm_connections.last_connection_succeeded_at),
    connection_status = excluded.connection_status, failure_code = NULL,
    revision = saved_vm_connections.revision + 1, updated_at = excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS saved_vm_allocation_checked
AFTER UPDATE OF status, remote_home_dir, remote_workspace_dir, last_connection_succeeded_at ON vm_allocations
WHEN NEW.status != 'revoked'
BEGIN
  SELECT RAISE(ABORT, 'VM identity changed; remove this saved connection and register it again')
  WHERE EXISTS (SELECT 1 FROM saved_vm_connections WHERE allocation_id = NEW.id AND (
    (NEW.remote_home_dir IS NOT NULL AND remote_home_dir IS NOT NULL AND remote_home_dir != NEW.remote_home_dir)
    OR (NEW.remote_workspace_dir IS NOT NULL AND remote_workspace_dir IS NOT NULL AND remote_workspace_dir != NEW.remote_workspace_dir)
  ));
  UPDATE saved_vm_connections SET remote_home_dir = COALESCE(NEW.remote_home_dir, remote_home_dir),
    remote_workspace_dir = COALESCE(NEW.remote_workspace_dir, remote_workspace_dir),
    last_connection_succeeded_at = COALESCE(NEW.last_connection_succeeded_at, last_connection_succeeded_at),
    connection_status = CASE WHEN NEW.status = 'ready' THEN 'ready' ELSE 'connection_required' END,
    failure_code = NEW.failure_code,
    revision = revision + 1, updated_at = NEW.updated_at WHERE allocation_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS saved_vm_allocation_revoked
AFTER UPDATE OF status ON vm_allocations WHEN NEW.status = 'revoked'
BEGIN DELETE FROM saved_vm_connections WHERE allocation_id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS saved_vm_credential_inserted
AFTER INSERT ON encrypted_user_ssh_credentials
BEGIN
  UPDATE saved_vm_connections SET credential_ciphertext = NEW.ciphertext,
    credential_nonce = NEW.nonce, credential_auth_tag = NEW.auth_tag,
    credential_key_id = NEW.key_id, credential_format_version = NEW.format_version,
    credential_status = NEW.status, revision = revision + 1, updated_at = NEW.updated_at
  WHERE allocation_id IN (SELECT a.id FROM vm_allocations a JOIN agent_bindings b ON b.id = a.agent_binding_id
    WHERE b.user_id = NEW.user_id AND a.status != 'revoked');
END;
CREATE TRIGGER IF NOT EXISTS saved_vm_credential_updated
AFTER UPDATE ON encrypted_user_ssh_credentials
BEGIN
  UPDATE saved_vm_connections SET credential_ciphertext = NEW.ciphertext,
    credential_nonce = NEW.nonce, credential_auth_tag = NEW.auth_tag,
    credential_key_id = NEW.key_id, credential_format_version = NEW.format_version,
    credential_status = NEW.status, revision = revision + 1, updated_at = NEW.updated_at
  WHERE allocation_id IN (SELECT a.id FROM vm_allocations a JOIN agent_bindings b ON b.id = a.agent_binding_id
    WHERE b.user_id = NEW.user_id AND a.status != 'revoked');
END;
CREATE TRIGGER IF NOT EXISTS saved_vm_credential_deleted
AFTER DELETE ON encrypted_user_ssh_credentials
BEGIN
  UPDATE saved_vm_connections SET credential_ciphertext = NULL, credential_nonce = NULL,
    credential_auth_tag = NULL, credential_key_id = NULL, credential_format_version = NULL,
    credential_status = 'missing'
  WHERE allocation_id IN (SELECT a.id FROM vm_allocations a JOIN agent_bindings b ON b.id = a.agent_binding_id
    WHERE b.user_id = OLD.user_id AND a.status != 'revoked');
END;
CREATE TRIGGER IF NOT EXISTS saved_vm_coding_agent_inserted
AFTER INSERT ON vm_allocation_coding_agent_settings
BEGIN
  INSERT INTO saved_vm_coding_agent_settings SELECT s.id, NEW.agent, NEW.enabled,
    NEW.executable_path, NEW.environment_json, NEW.last_check_json, NEW.updated_by_user_id, NEW.updated_at
    FROM saved_vm_connections s WHERE s.allocation_id = NEW.allocation_id
  ON CONFLICT(connection_id, agent) DO UPDATE SET enabled = excluded.enabled,
    executable_path = excluded.executable_path, environment_json = excluded.environment_json,
    last_check_json = excluded.last_check_json, updated_by_user_id = excluded.updated_by_user_id,
    updated_at = excluded.updated_at;
END;
CREATE TRIGGER IF NOT EXISTS saved_vm_coding_agent_updated
AFTER UPDATE ON vm_allocation_coding_agent_settings
BEGIN
  UPDATE saved_vm_coding_agent_settings SET enabled = NEW.enabled,
    executable_path = NEW.executable_path, environment_json = NEW.environment_json,
    last_check_json = NEW.last_check_json, updated_by_user_id = NEW.updated_by_user_id,
    updated_at = NEW.updated_at
  WHERE connection_id IN (SELECT id FROM saved_vm_connections WHERE allocation_id = NEW.allocation_id)
    AND agent = NEW.agent;
END;
`;

/** One-time import before runtime starts; never resurrects previously revoked allocations. */
export function migrateSavedVmConnections(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    const migration = "saved-vm-connections-v1";
    if (
      !db.prepare("SELECT 1 FROM control_plane_feature_migrations WHERE name = ?").get(migration)
    ) {
      db.exec(`
        INSERT INTO saved_vm_connections (
          id, agent_binding_id, vm_host_id, linux_account, allocation_id, endpoint_identity,
          remote_home_dir, remote_workspace_dir, last_connection_succeeded_at,
          credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_id,
          credential_format_version, credential_status, connection_status, failure_code, created_at, updated_at
        ) SELECT a.id, a.agent_binding_id, a.vm_host_id, a.linux_account, a.id,
          json_array(e.host, e.port, e.ad_domain, e.host_key_algorithm, e.host_key_public_key,
            e.host_key_fingerprint, h.target_address),
          a.remote_home_dir, a.remote_workspace_dir, a.last_connection_succeeded_at,
          c.ciphertext, c.nonce, c.auth_tag, c.key_id, c.format_version,
          COALESCE(c.status, 'missing'), CASE WHEN a.status = 'ready' THEN 'ready' ELSE 'connection_required' END,
          a.failure_code, a.created_at, a.updated_at
        FROM vm_allocations a JOIN agent_bindings b ON b.id = a.agent_binding_id
          JOIN vm_hosts h ON h.id = a.vm_host_id JOIN safeconnect_endpoints e ON e.id = h.endpoint_id
          LEFT JOIN encrypted_user_ssh_credentials c ON c.user_id = b.user_id
        WHERE a.status != 'revoked';
        INSERT INTO saved_vm_coding_agent_settings
          SELECT s.id, c.agent, c.enabled, c.executable_path, c.environment_json,
            c.last_check_json, c.updated_by_user_id, c.updated_at
          FROM vm_allocation_coding_agent_settings c JOIN saved_vm_connections s ON s.allocation_id = c.allocation_id;
      `);
      db.prepare(
        "INSERT INTO control_plane_feature_migrations (name, completed_at) VALUES (?, ?)",
      ).run(migration, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
