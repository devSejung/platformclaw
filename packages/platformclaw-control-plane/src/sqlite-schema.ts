import type { DatabaseSync } from "node:sqlite";

export const PLATFORMCLAW_CONTROL_SCHEMA_VERSION = 2;

const SCHEMA_V1 = `
CREATE TABLE platform_users (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  employee_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email TEXT,
  department TEXT,
  timezone TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  global_role TEXT NOT NULL CHECK (global_role IN ('member', 'admin')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
) STRICT;

CREATE TABLE enterprise_identities (
  provider TEXT NOT NULL CHECK (provider IN ('ldap', 'saml')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_authenticated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;

CREATE TABLE user_directory_groups (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  group_name TEXT NOT NULL,
  PRIMARY KEY (user_id, group_name)
) STRICT;

CREATE TABLE agent_bindings (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'knox-room')),
  user_id TEXT REFERENCES platform_users(id) ON DELETE CASCADE,
  knox_account_id TEXT,
  room_id TEXT,
  agent_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'failed', 'disabled')),
  failure_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'personal' AND user_id IS NOT NULL AND knox_account_id IS NULL AND room_id IS NULL) OR
    (kind = 'knox-room' AND user_id IS NULL AND knox_account_id IS NOT NULL AND room_id IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX agent_bindings_personal_user
  ON agent_bindings(user_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX agent_bindings_knox_room
  ON agent_bindings(knox_account_id, room_id) WHERE kind = 'knox-room';

CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX browser_sessions_user ON browser_sessions(user_id);

CREATE TABLE managed_scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('group', 'part')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_group_id TEXT REFERENCES managed_scopes(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'group' AND parent_group_id IS NULL) OR
    (kind = 'part' AND parent_group_id IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX managed_scopes_group_name
  ON managed_scopes(normalized_name) WHERE kind = 'group';
CREATE UNIQUE INDEX managed_scopes_part_name
  ON managed_scopes(parent_group_id, normalized_name) WHERE kind = 'part';

CREATE TABLE managed_scope_memberships (
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('member', 'leader')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, user_id)
) STRICT;
CREATE INDEX managed_scope_memberships_user ON managed_scope_memberships(user_id);

CREATE TABLE control_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES platform_users(id),
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX control_audit_events_created ON control_audit_events(created_at);
`;

const SCHEMA_V2 = `
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

const VM_HOST_EXECUTION_ENVIRONMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS vm_host_execution_environments (
  vm_host_id TEXT PRIMARY KEY REFERENCES vm_hosts(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  updated_at INTEGER NOT NULL
) STRICT;
`;

const ORGANIZATION_MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS organization_memory_promotion_requests (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('personal', 'part', 'group')),
  source_scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  source_claim_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('part', 'group', 'global')),
  target_scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  proposed_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (
    (source_kind = 'personal' AND source_scope_id IS NULL AND target_kind = 'part' AND target_scope_id IS NOT NULL) OR
    (source_kind = 'part' AND source_scope_id IS NOT NULL AND target_kind = 'group' AND target_scope_id IS NOT NULL) OR
    (source_kind = 'group' AND source_scope_id IS NOT NULL AND target_kind = 'global' AND target_scope_id IS NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS organization_memory_promotion_requester
  ON organization_memory_promotion_requests(requested_by_user_id, created_at DESC);
CREATE TRIGGER IF NOT EXISTS organization_memory_promotion_request_immutable_update
BEFORE UPDATE OF id, source_kind, source_scope_id, source_claim_id, source_revision,
  target_kind, target_scope_id, requested_by_user_id, created_at
ON organization_memory_promotion_requests
BEGIN
  SELECT RAISE(ABORT, 'organization memory promotion request lineage is immutable');
END;
CREATE TRIGGER IF NOT EXISTS organization_memory_promotion_request_immutable_delete
BEFORE DELETE ON organization_memory_promotion_requests
BEGIN
  SELECT RAISE(ABORT, 'organization memory promotion requests are immutable');
END;

CREATE TABLE IF NOT EXISTS organization_memory_claims (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'group', 'part')),
  scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('personal', 'part', 'group')),
  source_scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  source_claim_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  promotion_request_id TEXT NOT NULL UNIQUE REFERENCES organization_memory_promotion_requests(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'purged')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  approved_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retired_by_user_id TEXT REFERENCES platform_users(id) ON DELETE RESTRICT,
  retired_at INTEGER,
  retirement_reason TEXT,
  CHECK (
    (scope_kind = 'global' AND scope_id IS NULL) OR
    (scope_kind IN ('group', 'part') AND scope_id IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS organization_memory_claim_scope
  ON organization_memory_claims(status, scope_kind, scope_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS organization_memory_claim_source
  ON organization_memory_claims(source_kind, source_scope_id, source_claim_id, source_revision);
CREATE TRIGGER IF NOT EXISTS organization_memory_claim_lineage_immutable
BEFORE UPDATE OF scope_kind, scope_id, source_kind, source_scope_id, source_claim_id,
  source_revision, promotion_request_id, created_by_user_id, approved_by_user_id, created_at
ON organization_memory_claims
BEGIN
  SELECT RAISE(ABORT, 'organization memory claim lineage is immutable');
END;

CREATE TABLE IF NOT EXISTS organization_memory_promotion_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES organization_memory_promotion_requests(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  target_claim_id TEXT REFERENCES organization_memory_claims(id) ON DELETE RESTRICT,
  decided_at INTEGER NOT NULL,
  CHECK (
    (decision = 'approved' AND target_claim_id IS NOT NULL) OR
    (decision = 'rejected' AND target_claim_id IS NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS organization_memory_promotion_decided
  ON organization_memory_promotion_decisions(decided_at DESC);
CREATE TRIGGER IF NOT EXISTS organization_memory_promotion_decision_immutable_update
BEFORE UPDATE ON organization_memory_promotion_decisions
BEGIN
  SELECT RAISE(ABORT, 'organization memory promotion decisions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS organization_memory_promotion_decision_immutable_delete
BEFORE DELETE ON organization_memory_promotion_decisions
BEGIN
  SELECT RAISE(ABORT, 'organization memory promotion decisions are immutable');
END;

CREATE TABLE IF NOT EXISTS organization_memory_pages (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'group', 'part')),
  scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope_kind = 'global' AND scope_id IS NULL) OR
    (scope_kind IN ('group', 'part') AND scope_id IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS organization_memory_scope
  ON organization_memory_pages(status, scope_kind, scope_id, updated_at DESC);
`;

const SKILL_HUB_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_hub_skill_ownership (
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  owner_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  previous_owner_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'NAMESPACE_ONLY', 'PRIVATE')),
  current_version TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, slug)
) STRICT;
CREATE INDEX IF NOT EXISTS skill_hub_skill_ownership_owner
  ON skill_hub_skill_ownership(owner_user_id);

CREATE TABLE IF NOT EXISTS skill_hub_skill_access (
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  granted_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  expires_at INTEGER,
  inherit_versions INTEGER NOT NULL CHECK (inherit_versions IN (0, 1)),
  granted_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, slug, user_id),
  FOREIGN KEY (namespace, slug)
    REFERENCES skill_hub_skill_ownership(namespace, slug) ON DELETE CASCADE,
  CHECK (
    (inherit_versions = 1 AND granted_version IS NULL) OR
    (inherit_versions = 0 AND granted_version IS NOT NULL)
  )
) STRICT;
CREATE INDEX IF NOT EXISTS skill_hub_skill_access_user
  ON skill_hub_skill_access(user_id, expires_at);

CREATE TABLE IF NOT EXISTS skill_hub_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  namespace TEXT,
  slug TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS skill_hub_notifications_inbox
  ON skill_hub_notifications(user_id, read_at, created_at);

CREATE TABLE IF NOT EXISTS skill_hub_governance_jobs (
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  owner_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'blocked', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, slug, version),
  FOREIGN KEY (namespace, slug)
    REFERENCES skill_hub_skill_ownership(namespace, slug) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS skill_hub_governance_jobs_due
  ON skill_hub_governance_jobs(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS skill_hub_namespace_bindings (
  namespace TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('team', 'group', 'part')),
  scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  visibility_ceiling TEXT NOT NULL CHECK (
    visibility_ceiling IN ('PUBLIC', 'NAMESPACE_ONLY', 'PRIVATE')
  ),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope_kind = 'team' AND scope_id IS NULL) OR
    (scope_kind IN ('group', 'part') AND scope_id IS NOT NULL)
  )
) STRICT;
`;

/** Additive VM feature table; safe for older schema-v2 readers to ignore. */
export function ensureVmHostExecutionEnvironmentSchema(db: DatabaseSync): void {
  db.exec(VM_HOST_EXECUTION_ENVIRONMENT_SCHEMA);
}

/** Additive shared-memory table; safe for older schema-v2 readers to ignore. */
export function ensureOrganizationMemorySchema(db: DatabaseSync): void {
  db.exec(ORGANIZATION_MEMORY_SCHEMA);
}

/** Additive feature table; safe for older schema-v2 readers to ignore. */
export function ensureMcpCredentialSchema(db: DatabaseSync): void {
  db.exec(MCP_CREDENTIAL_SCHEMA);
}

/** Additive personal exec credential tables; older schema-v2 readers ignore them. */
export function ensureExecCredentialSchema(db: DatabaseSync): void {
  db.exec(EXEC_CREDENTIAL_SCHEMA);
}

/** Additive Skill Hub state; safe for older schema-v2 readers to ignore. */
export function ensureSkillHubStateSchema(db: DatabaseSync): void {
  db.exec(SKILL_HUB_STATE_SCHEMA);
}

export function initializeControlPlaneSchema(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Another process may have initialized the database while this opener waited for the lock.
    const currentVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (currentVersion.user_version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
      db.exec("COMMIT");
      return;
    }
    if (currentVersion.user_version < 0 || currentVersion.user_version > 2) {
      throw new Error(
        `unsupported PlatformClaw control schema version: ${currentVersion.user_version}`,
      );
    }
    if (currentVersion.user_version === 0) {
      db.exec(SCHEMA_V1);
    }
    if (currentVersion.user_version <= 1) {
      db.exec(SCHEMA_V2);
    }
    db.exec(`PRAGMA user_version = ${PLATFORMCLAW_CONTROL_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
