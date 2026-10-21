import type { DatabaseSync } from "node:sqlite";
import { runImmediateTransaction } from "./kysely-sync.js";

export const DIRECTORY_ORGANIZATION_SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS managed_scopes_external_key
  ON managed_scopes(external_key) WHERE external_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS directory_organization_sync (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id),
  source_updated_at INTEGER NOT NULL
) STRICT;
`;

const SCOPE_COLUMNS = {
  external_key: "TEXT",
  managed_by: "TEXT CHECK (managed_by IN ('ldap-login'))",
  directory_updated_at: "INTEGER",
};
const MEMBERSHIP_COLUMNS = {
  managed_by: "TEXT CHECK (managed_by IN ('ldap-login'))",
  manual_role: "TEXT CHECK (manual_role IN ('member', 'leader'))",
};

function addDirectoryColumns(
  db: DatabaseSync,
  table: "managed_scopes" | "managed_scope_memberships",
  columns: Record<string, string>,
): boolean {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  );
  let changed = false;
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      changed = true;
    }
  }
  return changed;
}

/** Existing v3 readers retain the same IDs, hierarchy, roles and nullable-column defaults. */
export function ensureDirectoryOrganizationSchema(db: DatabaseSync): void {
  const ensure = () => {
    const changedScopes = addDirectoryColumns(db, "managed_scopes", SCOPE_COLUMNS);
    addDirectoryColumns(db, "managed_scope_memberships", MEMBERSHIP_COLUMNS);
    if (changedScopes) {
      // External identity owns automatic scopes; name uniqueness remains a manual policy.
      // Keeping the old indexes would reject distinct directory IDs with equal names.
      db.exec(`
        DROP INDEX IF EXISTS managed_scopes_team_name;
        DROP INDEX IF EXISTS managed_scopes_child_name;
        CREATE UNIQUE INDEX managed_scopes_team_name
          ON managed_scopes(normalized_name) WHERE kind = 'team' AND external_key IS NULL;
        CREATE UNIQUE INDEX managed_scopes_child_name
          ON managed_scopes(parent_scope_id, kind, normalized_name)
          WHERE kind IN ('group', 'part') AND external_key IS NULL;
      `);
    }
    db.exec(DIRECTORY_ORGANIZATION_SCHEMA);
  };
  if (db.isTransaction) {
    ensure();
  } else {
    runImmediateTransaction(db, ensure);
  }
}
