import type { DatabaseSync } from "node:sqlite";

export const PLATFORMCLAW_CONTROL_SCHEMA_VERSION = 1;

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
    if (currentVersion.user_version !== 0) {
      throw new Error(
        `unsupported PlatformClaw control schema version: ${currentVersion.user_version}`,
      );
    }
    db.exec(SCHEMA_V1);
    db.exec(`PRAGMA user_version = ${PLATFORMCLAW_CONTROL_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
