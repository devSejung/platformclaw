import type { DatabaseSync } from "node:sqlite";
import { ensureDirectoryOrganizationSchema } from "./sqlite-schema-directory-organizations.js";

export const MANAGED_SCOPE_TABLE_SCHEMA = `
CREATE TABLE managed_scopes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('team', 'group', 'part')),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  external_key TEXT,
  managed_by TEXT CHECK (managed_by IN ('ldap-login')),
  directory_updated_at INTEGER,
  directory_parent_key TEXT,
  parent_scope_id TEXT REFERENCES managed_scopes(id),
  system_kind TEXT CHECK (system_kind IN ('unassigned-team')),
  system_provenance TEXT CHECK (system_provenance IN ('migration-v2-v3')),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (kind = 'team' AND parent_scope_id IS NULL) OR
    (kind = 'group' AND parent_scope_id IS NOT NULL) OR
    (kind = 'part' AND (
      parent_scope_id IS NOT NULL OR (
        managed_by IS 'ldap-login' AND external_key IS NOT NULL AND
        external_key GLOB 'aicm-part:?*'
      )
    ))
  ),
  CHECK (
    (system_kind IS NULL AND system_provenance IS NULL) OR
    (kind = 'team' AND system_kind = 'unassigned-team' AND system_provenance = 'migration-v2-v3')
  )
) STRICT;
`;

export const MANAGED_SCOPE_RELATION_SCHEMA = `
CREATE UNIQUE INDEX managed_scopes_team_name
  ON managed_scopes(normalized_name) WHERE kind = 'team' AND external_key IS NULL;
CREATE UNIQUE INDEX managed_scopes_child_name
  ON managed_scopes(parent_scope_id, kind, normalized_name)
  WHERE kind IN ('group', 'part') AND external_key IS NULL;
CREATE UNIQUE INDEX managed_scopes_system_kind
  ON managed_scopes(system_kind) WHERE system_kind IS NOT NULL;
CREATE UNIQUE INDEX managed_scopes_external_key
  ON managed_scopes(external_key) WHERE external_key IS NOT NULL;
CREATE TRIGGER managed_scopes_parent_kind_insert
BEFORE INSERT ON managed_scopes WHEN
  (NEW.kind = 'team' AND NEW.parent_scope_id IS NOT NULL) OR
  (NEW.kind = 'group' AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'team'
  )) OR
  (NEW.kind = 'part' AND NEW.parent_scope_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'group'
  ))
BEGIN SELECT RAISE(ABORT, 'managed scope parent kind is invalid'); END;
CREATE TRIGGER managed_scopes_parent_kind_update
BEFORE UPDATE OF kind, parent_scope_id ON managed_scopes WHEN
  (NEW.kind = 'team' AND NEW.parent_scope_id IS NOT NULL) OR
  (NEW.kind = 'group' AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'team'
  )) OR
  (NEW.kind = 'part' AND NEW.parent_scope_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM managed_scopes WHERE id = NEW.parent_scope_id AND kind = 'group'
  ))
BEGIN SELECT RAISE(ABORT, 'managed scope parent kind is invalid'); END;
`;

/** Runs inside the version owner's backed-up, foreign-key-disabled migration transaction. */
export function migrateDirectoryPartsToV4(db: DatabaseSync): void {
  ensureDirectoryOrganizationSchema(db);
  db.exec(MANAGED_SCOPE_TABLE_SCHEMA.replaceAll("managed_scopes", "managed_scopes_v4"));
  db.exec(`
    INSERT INTO managed_scopes_v4 (
      id, kind, name, normalized_name, external_key, managed_by, directory_updated_at, directory_parent_key,
      parent_scope_id, system_kind, system_provenance, status,
      created_by_user_id, created_at, updated_at
    ) SELECT
      scope.id, scope.kind, scope.name, scope.normalized_name, scope.external_key, scope.managed_by, scope.directory_updated_at,
      CASE WHEN scope.managed_by = 'ldap-login' THEN
        (SELECT parent.external_key FROM managed_scopes AS parent WHERE parent.id = scope.parent_scope_id)
        ELSE NULL END,
      scope.parent_scope_id, scope.system_kind, scope.system_provenance, scope.status,
      scope.created_by_user_id, scope.created_at, scope.updated_at
      FROM managed_scopes AS scope;
    DROP TABLE managed_scopes;
    ALTER TABLE managed_scopes_v4 RENAME TO managed_scopes;
  `);
  db.exec(MANAGED_SCOPE_RELATION_SCHEMA);
}
