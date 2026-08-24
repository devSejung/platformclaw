export const ORGANIZATION_MEMORY_SCHEMA = `
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

export const SKILL_HUB_STATE_SCHEMA = `
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
