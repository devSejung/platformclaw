export const SCHEMA_V2 = `
CREATE TABLE safeconnect_endpoints (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  ad_domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  host_key_algorithm TEXT,
  host_key_public_key TEXT,
  host_key_fingerprint TEXT,
  host_key_approved_by_user_id TEXT REFERENCES platform_users(id),
  host_key_approved_at INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    status != 'active' OR (
      host_key_algorithm IS NOT NULL AND
      host_key_public_key IS NOT NULL AND
      host_key_fingerprint IS NOT NULL AND
      host_key_approved_by_user_id IS NOT NULL AND
      host_key_approved_at IS NOT NULL
    )
  ),
  CHECK (
    (host_key_approved_by_user_id IS NULL AND host_key_approved_at IS NULL) OR
    (host_key_approved_by_user_id IS NOT NULL AND host_key_approved_at IS NOT NULL)
  ),
  UNIQUE (host, port)
) STRICT;

CREATE TABLE vm_hosts (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES safeconnect_endpoints(id) ON DELETE RESTRICT,
  label TEXT NOT NULL,
  target_address TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (endpoint_id, target_address)
) STRICT;

CREATE TABLE vm_host_execution_environments (
  vm_host_id TEXT PRIMARY KEY REFERENCES vm_hosts(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE vm_allocations (
  id TEXT PRIMARY KEY,
  agent_binding_id TEXT NOT NULL REFERENCES agent_bindings(id) ON DELETE RESTRICT,
  vm_host_id TEXT NOT NULL REFERENCES vm_hosts(id) ON DELETE RESTRICT,
  linux_account TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('assigned', 'ready', 'connection_required', 'revoked')
  ),
  remote_home_dir TEXT,
  remote_workspace_dir TEXT,
  last_connection_check_at INTEGER,
  last_connection_succeeded_at INTEGER,
  failure_code TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (id, agent_binding_id),
  CHECK (
    status != 'ready' OR (
      remote_home_dir IS NOT NULL AND
      remote_workspace_dir IS NOT NULL AND
      last_connection_succeeded_at IS NOT NULL AND
      failure_code IS NULL
    )
  ),
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL) OR
    (status != 'revoked' AND revoked_at IS NULL)
  )
) STRICT;
CREATE UNIQUE INDEX vm_allocations_active_agent
  ON vm_allocations(agent_binding_id) WHERE status != 'revoked';
CREATE UNIQUE INDEX vm_allocations_active_linux_account
  ON vm_allocations(vm_host_id, linux_account) WHERE status != 'revoked';

CREATE TABLE personal_execution_profiles (
  agent_binding_id TEXT PRIMARY KEY REFERENCES agent_bindings(id) ON DELETE CASCADE,
  active_target TEXT NOT NULL CHECK (active_target IN ('platform_server', 'assigned_vm')),
  active_allocation_id TEXT,
  target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (active_allocation_id, agent_binding_id)
    REFERENCES vm_allocations(id, agent_binding_id) ON DELETE RESTRICT,
  CHECK (
    (active_target = 'platform_server' AND active_allocation_id IS NULL) OR
    (active_target = 'assigned_vm' AND active_allocation_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE encrypted_user_ssh_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES platform_users(id) ON DELETE CASCADE,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL,
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('current', 'update_required')),
  last_auth_failure_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER vm_allocations_require_personal_agent
BEFORE INSERT ON vm_allocations
WHEN NOT EXISTS (
  SELECT 1 FROM agent_bindings
  WHERE id = NEW.agent_binding_id AND kind = 'personal'
)
BEGIN
  SELECT RAISE(ABORT, 'VM allocation requires a personal agent binding');
END;

CREATE TRIGGER vm_allocations_agent_owner_immutable
BEFORE UPDATE OF agent_binding_id ON vm_allocations
WHEN NEW.agent_binding_id != OLD.agent_binding_id
BEGIN
  SELECT RAISE(ABORT, 'VM allocation agent owner is immutable');
END;

CREATE TRIGGER personal_execution_profiles_require_personal_agent
BEFORE INSERT ON personal_execution_profiles
WHEN NOT EXISTS (
  SELECT 1 FROM agent_bindings
  WHERE id = NEW.agent_binding_id AND kind = 'personal'
)
BEGIN
  SELECT RAISE(ABORT, 'execution profile requires a personal agent binding');
END;

CREATE TRIGGER personal_execution_profiles_agent_owner_immutable
BEFORE UPDATE OF agent_binding_id ON personal_execution_profiles
WHEN NEW.agent_binding_id != OLD.agent_binding_id
BEGIN
  SELECT RAISE(ABORT, 'execution profile agent owner is immutable');
END;

CREATE TRIGGER agent_bindings_kind_immutable
BEFORE UPDATE OF kind ON agent_bindings
WHEN NEW.kind != OLD.kind
BEGIN
  SELECT RAISE(ABORT, 'agent binding kind is immutable');
END;

CREATE TRIGGER personal_execution_profiles_require_live_allocation_insert
BEFORE INSERT ON personal_execution_profiles
WHEN NEW.active_target = 'assigned_vm' AND NOT EXISTS (
  SELECT 1 FROM vm_allocations
  WHERE id = NEW.active_allocation_id
    AND agent_binding_id = NEW.agent_binding_id
    AND status != 'revoked'
)
BEGIN
  SELECT RAISE(ABORT, 'execution profile requires a non-revoked owned allocation');
END;

CREATE TRIGGER personal_execution_profiles_require_live_allocation_update
BEFORE UPDATE OF active_target, active_allocation_id ON personal_execution_profiles
WHEN NEW.active_target = 'assigned_vm' AND NOT EXISTS (
  SELECT 1 FROM vm_allocations
  WHERE id = NEW.active_allocation_id
    AND agent_binding_id = NEW.agent_binding_id
    AND status != 'revoked'
)
BEGIN
  SELECT RAISE(ABORT, 'execution profile requires a non-revoked owned allocation');
END;

CREATE TRIGGER vm_allocations_block_active_revoke
BEFORE UPDATE OF status ON vm_allocations
WHEN NEW.status = 'revoked' AND EXISTS (
  SELECT 1 FROM personal_execution_profiles
  WHERE active_target = 'assigned_vm' AND active_allocation_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'active VM allocation must be deselected before revocation');
END;

INSERT INTO personal_execution_profiles (
  agent_binding_id,
  active_target,
  active_allocation_id,
  target_revision,
  updated_at
)
SELECT id, 'platform_server', NULL, 0, updated_at
FROM agent_bindings
WHERE kind = 'personal';

CREATE TABLE encrypted_user_mcp_credentials (
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

CREATE TABLE mcp_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  server_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX mcp_oauth_states_expiry ON mcp_oauth_states(expires_at);
`;
