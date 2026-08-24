import { randomUUID } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export const PLATFORMCLAW_CONTROL_SCHEMA_VERSION = 3;

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
  kind TEXT NOT NULL CHECK (kind IN ('team', 'group', 'part')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_scope_id TEXT REFERENCES managed_scopes(id),
  system_kind TEXT CHECK (system_kind IN ('unassigned-team')),
  system_provenance TEXT CHECK (system_provenance IN ('migration-v2-v3')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'team' AND parent_scope_id IS NULL) OR
    (kind IN ('group', 'part') AND parent_scope_id IS NOT NULL)
  ),
  CHECK (
    (system_kind IS NULL AND system_provenance IS NULL) OR
    (kind = 'team' AND system_kind = 'unassigned-team' AND system_provenance = 'migration-v2-v3')
  )
) STRICT;
CREATE UNIQUE INDEX managed_scopes_team_name
  ON managed_scopes(normalized_name) WHERE kind = 'team';
CREATE UNIQUE INDEX managed_scopes_child_name
  ON managed_scopes(parent_scope_id, kind, normalized_name) WHERE kind IN ('group', 'part');
CREATE UNIQUE INDEX managed_scopes_system_kind
  ON managed_scopes(system_kind) WHERE system_kind IS NOT NULL;
CREATE TRIGGER managed_scopes_parent_kind_insert
BEFORE INSERT ON managed_scopes WHEN
  (NEW.kind = 'team' AND NEW.parent_scope_id IS NOT NULL) OR
  (NEW.kind = 'group' AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'team'
  )) OR
  (NEW.kind = 'part' AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'group'
  ))
BEGIN SELECT RAISE(ABORT, 'managed scope parent kind is invalid'); END;
CREATE TRIGGER managed_scopes_parent_kind_update
BEFORE UPDATE OF kind, parent_scope_id ON managed_scopes WHEN
  (NEW.kind = 'team' AND NEW.parent_scope_id IS NOT NULL) OR
  (NEW.kind = 'group' AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'team'
  )) OR
  (NEW.kind = 'part' AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'group'
  ))
BEGIN SELECT RAISE(ABORT, 'managed scope parent kind is invalid'); END;

CREATE TABLE managed_scope_memberships (
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('member', 'leader')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, user_id)
) STRICT;
CREATE INDEX managed_scope_memberships_user ON managed_scope_memberships(user_id);

CREATE TABLE managed_scope_primary_memberships (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (scope_id, user_id)
    REFERENCES managed_scope_memberships(scope_id, user_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE organization_join_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  CHECK (
    (status = 'pending' AND decided_at IS NULL) OR
    (status != 'pending' AND decided_at IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX organization_join_requests_pending
  ON organization_join_requests(user_id, scope_id) WHERE status = 'pending';
CREATE TABLE organization_join_request_decisions (
  request_id TEXT PRIMARY KEY REFERENCES organization_join_requests(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  decided_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER organization_join_request_decision_immutable_update
BEFORE UPDATE ON organization_join_request_decisions
BEGIN SELECT RAISE(ABORT, 'organization join request decisions are immutable'); END;
CREATE TRIGGER organization_join_request_decision_immutable_delete
BEFORE DELETE ON organization_join_request_decisions
BEGIN SELECT RAISE(ABORT, 'organization join request decisions are immutable'); END;
CREATE TRIGGER organization_join_request_lineage_immutable
BEFORE UPDATE OF id, user_id, scope_id, reason, created_at ON organization_join_requests
BEGIN SELECT RAISE(ABORT, 'organization join request lineage is immutable'); END;
CREATE TRIGGER organization_join_request_decision_matches
BEFORE INSERT ON organization_join_request_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM organization_join_requests
  WHERE id = NEW.request_id AND status = 'pending'
) OR NEW.decided_at IS NULL
BEGIN SELECT RAISE(ABORT, 'organization join request decision is invalid'); END;
CREATE TRIGGER organization_join_request_terminal_matches
BEFORE UPDATE OF status, decided_at ON organization_join_requests
WHEN OLD.status != 'pending' OR NEW.status = 'pending' OR NOT EXISTS (
  SELECT 1 FROM organization_join_request_decisions
  WHERE request_id = OLD.id AND decision = NEW.status AND decided_at = NEW.decided_at
)
BEGIN SELECT RAISE(ABORT, 'organization join request terminal state is invalid'); END;

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
  source_kind TEXT NOT NULL CHECK (source_kind IN ('personal', 'part', 'group', 'team')),
  source_scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  source_claim_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('part', 'group', 'team', 'global')),
  target_scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  proposed_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  CHECK (
    (source_kind = 'personal' AND source_scope_id IS NULL) OR
    (source_kind IN ('part', 'group', 'team') AND source_scope_id IS NOT NULL)
  ),
  CHECK (
    (target_kind = 'global' AND target_scope_id IS NULL) OR
    (target_kind IN ('part', 'group', 'team') AND target_scope_id IS NOT NULL)
  ),
  CHECK (
    (source_kind = 'personal') OR
    (source_kind = 'part' AND target_kind IN ('group', 'team', 'global')) OR
    (source_kind = 'group' AND target_kind IN ('team', 'global')) OR
    (source_kind = 'team' AND target_kind = 'global')
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
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'team', 'group', 'part')),
  scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('personal', 'part', 'group', 'team')),
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
    (scope_kind IN ('team', 'group', 'part') AND scope_id IS NOT NULL)
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
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'team', 'group', 'part')),
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
    (scope_kind IN ('team', 'group', 'part') AND scope_id IS NOT NULL)
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
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'team', 'group', 'part')),
  scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  visibility_ceiling TEXT NOT NULL CHECK (
    visibility_ceiling IN ('PUBLIC', 'NAMESPACE_ONLY', 'PRIVATE')
  ),
  access_state TEXT NOT NULL CHECK (access_state IN ('active', 'restricted')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (scope_kind = 'global' AND scope_id IS NULL) OR
    (scope_kind IN ('team', 'group', 'part') AND scope_id IS NOT NULL)
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

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function assertDatabaseIntegrity(db: DatabaseSync, schema = "main"): void {
  const row = db.prepare(`PRAGMA ${schema}.integrity_check`).get() as { integrity_check?: string };
  if (row.integrity_check !== "ok") {
    throw new Error(
      `PlatformClaw control database integrity check failed: ${String(row.integrity_check)}`,
    );
  }
}

function createMigrationBackup(
  db: DatabaseSync,
  databasePath: string | undefined,
  expectedVersion: number,
): boolean {
  if (!databasePath || databasePath === ":memory:" || databasePath.startsWith("file:")) {
    return true;
  }
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
  if (checkpoint.busy !== 0) {
    throw new Error("PlatformClaw control database WAL checkpoint remained busy");
  }
  assertDatabaseIntegrity(db);
  const backupPath = `${databasePath}.pre-v3-${Date.now()}-${randomUUID()}.sqlite`;
  db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
  if (process.platform !== "win32") {
    chmodSync(backupPath, 0o600);
  }
  db.prepare("ATTACH DATABASE ? AS migration_backup").run(backupPath);
  let alreadyMigrated = false;
  try {
    assertDatabaseIntegrity(db, "migration_backup");
    const version = db.prepare("PRAGMA migration_backup.user_version").get() as {
      user_version: number;
    };
    if (version.user_version !== expectedVersion) {
      const liveVersion = (
        db.prepare("PRAGMA main.user_version").get() as {
          user_version: number;
        }
      ).user_version;
      if (
        version.user_version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION &&
        liveVersion === PLATFORMCLAW_CONTROL_SCHEMA_VERSION
      ) {
        alreadyMigrated = true;
      } else {
        throw new Error(
          `PlatformClaw control backup has unexpected schema version ${version.user_version}`,
        );
      }
    }
  } finally {
    db.exec("DETACH DATABASE migration_backup");
  }
  if (alreadyMigrated) {
    // Another opener already committed v3. Redundant snapshot cleanup must not
    // turn a valid upgraded database into a startup failure on Windows AV races.
    try {
      unlinkSync(backupPath);
    } catch {
      // Best-effort cleanup; the verified database is already canonical v3.
    }
    return false;
  }
  return true;
}

const MANAGED_ORGANIZATION_V3 = `
CREATE TABLE managed_scopes_v3 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'group', 'part')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  parent_scope_id TEXT REFERENCES managed_scopes_v3(id),
  system_kind TEXT CHECK (system_kind IN ('unassigned-team')),
  system_provenance TEXT CHECK (system_provenance IN ('migration-v2-v3')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'team' AND parent_scope_id IS NULL) OR
    (kind IN ('group', 'part') AND parent_scope_id IS NOT NULL)
  ),
  CHECK (
    (system_kind IS NULL AND system_provenance IS NULL) OR
    (kind = 'team' AND system_kind = 'unassigned-team' AND system_provenance = 'migration-v2-v3')
  )
) STRICT;
CREATE TABLE managed_scope_primary_memberships (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (scope_id, user_id)
    REFERENCES managed_scope_memberships(scope_id, user_id) ON DELETE CASCADE
) STRICT;
CREATE TABLE organization_join_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  CHECK (
    (status = 'pending' AND decided_at IS NULL) OR
    (status != 'pending' AND decided_at IS NOT NULL)
  )
) STRICT;
CREATE UNIQUE INDEX organization_join_requests_pending
  ON organization_join_requests(user_id, scope_id) WHERE status = 'pending';
CREATE TABLE organization_join_request_decisions (
  request_id TEXT PRIMARY KEY REFERENCES organization_join_requests(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'cancelled')),
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  decided_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER organization_join_request_decision_immutable_update
BEFORE UPDATE ON organization_join_request_decisions
BEGIN SELECT RAISE(ABORT, 'organization join request decisions are immutable'); END;
CREATE TRIGGER organization_join_request_decision_immutable_delete
BEFORE DELETE ON organization_join_request_decisions
BEGIN SELECT RAISE(ABORT, 'organization join request decisions are immutable'); END;
CREATE TRIGGER organization_join_request_lineage_immutable
BEFORE UPDATE OF id, user_id, scope_id, reason, created_at ON organization_join_requests
BEGIN SELECT RAISE(ABORT, 'organization join request lineage is immutable'); END;
CREATE TRIGGER organization_join_request_decision_matches
BEFORE INSERT ON organization_join_request_decisions
WHEN NOT EXISTS (
  SELECT 1 FROM organization_join_requests
  WHERE id = NEW.request_id AND status = 'pending'
) OR NEW.decided_at IS NULL
BEGIN SELECT RAISE(ABORT, 'organization join request decision is invalid'); END;
CREATE TRIGGER organization_join_request_terminal_matches
BEFORE UPDATE OF status, decided_at ON organization_join_requests
WHEN OLD.status != 'pending' OR NEW.status = 'pending' OR NOT EXISTS (
  SELECT 1 FROM organization_join_request_decisions
  WHERE request_id = OLD.id AND decision = NEW.status AND decided_at = NEW.decided_at
)
BEGIN SELECT RAISE(ABORT, 'organization join request terminal state is invalid'); END;
`;

function migrateSkillHubBindingsToV3(db: DatabaseSync): void {
  if (!hasTable(db, "skill_hub_namespace_bindings")) {
    return;
  }
  db.exec(`
    CREATE TABLE skill_hub_namespace_bindings_v3 (
      namespace TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'team', 'group', 'part')),
      scope_id TEXT REFERENCES managed_scopes(id) ON DELETE RESTRICT,
      visibility_ceiling TEXT NOT NULL CHECK (
        visibility_ceiling IN ('PUBLIC', 'NAMESPACE_ONLY', 'PRIVATE')
      ),
      access_state TEXT NOT NULL CHECK (access_state IN ('active', 'restricted')),
      created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (scope_kind = 'global' AND scope_id IS NULL) OR
        (scope_kind IN ('team', 'group', 'part') AND scope_id IS NOT NULL)
      )
    ) STRICT;
    INSERT INTO skill_hub_namespace_bindings_v3
    SELECT namespace,
      CASE WHEN scope_kind = 'team' AND scope_id IS NULL THEN 'global' ELSE scope_kind END,
      scope_id, visibility_ceiling,
      CASE WHEN scope_kind = 'team' AND scope_id IS NULL THEN 'restricted' ELSE 'active' END,
      created_by_user_id, created_at, updated_at
    FROM skill_hub_namespace_bindings;
    DROP TABLE skill_hub_namespace_bindings;
    ALTER TABLE skill_hub_namespace_bindings_v3 RENAME TO skill_hub_namespace_bindings;
  `);
}

function migrateOrganizationMemoryToV3(db: DatabaseSync): void {
  if (!hasTable(db, "organization_memory_promotion_requests")) {
    return;
  }
  const v3Schema = ORGANIZATION_MEMORY_SCHEMA.replaceAll(
    "organization_memory_",
    "organization_memory_v3_",
  );
  db.exec(v3Schema);
  db.exec(`
    INSERT INTO organization_memory_v3_promotion_requests
      SELECT * FROM organization_memory_promotion_requests;
    INSERT INTO organization_memory_v3_claims SELECT * FROM organization_memory_claims;
    INSERT INTO organization_memory_v3_promotion_decisions
      SELECT * FROM organization_memory_promotion_decisions;
    INSERT INTO organization_memory_v3_pages SELECT * FROM organization_memory_pages;
    DROP TABLE organization_memory_promotion_decisions;
    DROP TABLE organization_memory_claims;
    DROP TABLE organization_memory_promotion_requests;
    DROP TABLE organization_memory_pages;
    ALTER TABLE organization_memory_v3_promotion_requests
      RENAME TO organization_memory_promotion_requests;
    ALTER TABLE organization_memory_v3_claims RENAME TO organization_memory_claims;
    ALTER TABLE organization_memory_v3_promotion_decisions
      RENAME TO organization_memory_promotion_decisions;
    ALTER TABLE organization_memory_v3_pages RENAME TO organization_memory_pages;
    DROP INDEX IF EXISTS organization_memory_v3_promotion_requester;
    DROP INDEX IF EXISTS organization_memory_v3_claim_scope;
    DROP INDEX IF EXISTS organization_memory_v3_claim_source;
    DROP INDEX IF EXISTS organization_memory_v3_promotion_decided;
    DROP INDEX IF EXISTS organization_memory_v3_scope;
    DROP TRIGGER IF EXISTS organization_memory_v3_promotion_request_immutable_update;
    DROP TRIGGER IF EXISTS organization_memory_v3_promotion_request_immutable_delete;
    DROP TRIGGER IF EXISTS organization_memory_v3_claim_lineage_immutable;
    DROP TRIGGER IF EXISTS organization_memory_v3_promotion_decision_immutable_update;
    DROP TRIGGER IF EXISTS organization_memory_v3_promotion_decision_immutable_delete;
  `);
  db.exec(ORGANIZATION_MEMORY_SCHEMA);
}

function migrateV2ToV3(db: DatabaseSync): void {
  const invalidParents = db
    .prepare(
      `SELECT child.id FROM managed_scopes child
       LEFT JOIN managed_scopes parent ON parent.id = child.parent_group_id
       WHERE (child.kind = 'group' AND child.parent_group_id IS NOT NULL)
          OR (child.kind = 'part' AND (parent.id IS NULL OR parent.kind != 'group'))
       LIMIT 1`,
    )
    .get();
  if (invalidParents) {
    throw new Error("schema v3 migration found an invalid legacy managed-scope hierarchy");
  }
  const groupCount = (
    db.prepare("SELECT COUNT(*) AS count FROM managed_scopes WHERE kind = 'group'").get() as {
      count: number;
    }
  ).count;
  const admin = db
    .prepare(
      `SELECT id, created_at FROM platform_users
       WHERE status = 'active' AND global_role = 'admin'
       ORDER BY created_at, id LIMIT 1`,
    )
    .get() as { id: string; created_at: number } | undefined;
  if (groupCount > 0 && !admin) {
    throw new Error("schema v3 migration requires an active administrator for migrated groups");
  }
  db.exec(MANAGED_ORGANIZATION_V3);
  if (groupCount > 0 && admin) {
    db.prepare(
      `INSERT INTO managed_scopes_v3
       (id, kind, name, normalized_name, parent_scope_id, system_kind, system_provenance, status,
        created_by_user_id, created_at, updated_at)
       VALUES ('system-team-unassigned-v3', 'team', 'Unassigned Team', 'unassigned team',
        NULL, 'unassigned-team', 'migration-v2-v3', 'active', ?, ?, ?)`,
    ).run(admin.id, admin.created_at, admin.created_at);
  }
  db.prepare(
    `INSERT INTO managed_scopes_v3
     (id, kind, name, normalized_name, parent_scope_id, system_kind, system_provenance, status,
      created_by_user_id, created_at, updated_at)
     SELECT id, kind, name, normalized_name,
       CASE WHEN kind = 'group' THEN 'system-team-unassigned-v3' ELSE parent_group_id END,
       NULL, NULL, status, created_by_user_id, created_at, updated_at
     FROM managed_scopes WHERE kind = 'group'`,
  ).run();
  db.prepare(
    `INSERT INTO managed_scopes_v3
     (id, kind, name, normalized_name, parent_scope_id, system_kind, system_provenance, status,
      created_by_user_id, created_at, updated_at)
     SELECT id, kind, name, normalized_name, parent_group_id, NULL, NULL, status,
       created_by_user_id, created_at, updated_at
     FROM managed_scopes WHERE kind = 'part'`,
  ).run();
  migrateSkillHubBindingsToV3(db);
  migrateOrganizationMemoryToV3(db);
  db.exec(`
    DROP TABLE managed_scopes;
    ALTER TABLE managed_scopes_v3 RENAME TO managed_scopes;
    CREATE UNIQUE INDEX managed_scopes_team_name
      ON managed_scopes(normalized_name) WHERE kind = 'team';
    CREATE UNIQUE INDEX managed_scopes_child_name
      ON managed_scopes(parent_scope_id, kind, normalized_name) WHERE kind IN ('group', 'part');
    CREATE UNIQUE INDEX managed_scopes_system_kind
      ON managed_scopes(system_kind) WHERE system_kind IS NOT NULL;
    CREATE TRIGGER managed_scopes_parent_kind_insert
    BEFORE INSERT ON managed_scopes WHEN
      (NEW.kind = 'team' AND NEW.parent_scope_id IS NOT NULL) OR
      (NEW.kind = 'group' AND NOT EXISTS (
        SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'team'
      )) OR
      (NEW.kind = 'part' AND NOT EXISTS (
        SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'group'
      ))
    BEGIN SELECT RAISE(ABORT, 'managed scope parent kind is invalid'); END;
    CREATE TRIGGER managed_scopes_parent_kind_update
    BEFORE UPDATE OF kind, parent_scope_id ON managed_scopes WHEN
      (NEW.kind = 'team' AND NEW.parent_scope_id IS NOT NULL) OR
      (NEW.kind = 'group' AND NOT EXISTS (
        SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'team'
      )) OR
      (NEW.kind = 'part' AND NOT EXISTS (
        SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'group'
      ))
    BEGIN SELECT RAISE(ABORT, 'managed scope parent kind is invalid'); END;
  `);
}

export function initializeControlPlaneSchema(db: DatabaseSync, databasePath?: string): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  let version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version < 0 || version > PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
    throw new Error(`unsupported PlatformClaw control schema version: ${version}`);
  }
  if (version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
    return;
  }
  if (version === 0) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // A second opener may have initialized the file while this connection
      // waited for the write lock. Never replay fresh DDL over that commit.
      version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version === 0) {
        db.exec(SCHEMA_V1);
        db.exec(SCHEMA_V2);
        assertDatabaseIntegrity(db);
        db.exec(`PRAGMA user_version = ${PLATFORMCLAW_CONTROL_SCHEMA_VERSION}`);
        version = PLATFORMCLAW_CONTROL_SCHEMA_VERSION;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
      return;
    }
  }
  if (version === 1) {
    // Normalize the shipped v1 database first. The recoverable pre-v3 artifact
    // must pair with the immediately previous v2 runtime, not an older v1 shape.
    db.exec("BEGIN IMMEDIATE");
    try {
      version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version === 1) {
        db.exec(SCHEMA_V2);
        db.exec("PRAGMA user_version = 2");
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
    return;
  }
  if (version !== 2) {
    throw new Error(`unsupported PlatformClaw control schema version: ${version}`);
  }
  const backupCreated = createMigrationBackup(db, databasePath, 2);
  version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (!backupCreated && version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
    return;
  }
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === PLATFORMCLAW_CONTROL_SCHEMA_VERSION) {
      db.exec("COMMIT");
      return;
    }
    if (version !== 2) {
      throw new Error(`unsupported PlatformClaw control schema version: ${version}`);
    }
    migrateV2ToV3(db);
    const foreignKeyFailures = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyFailures.length > 0) {
      throw new Error("schema v3 migration produced invalid foreign keys");
    }
    assertDatabaseIntegrity(db);
    db.exec(`PRAGMA user_version = ${PLATFORMCLAW_CONTROL_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
