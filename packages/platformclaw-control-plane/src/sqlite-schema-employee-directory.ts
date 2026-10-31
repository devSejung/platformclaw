import type { DatabaseSync } from "node:sqlite";

export const EMPLOYEE_DIRECTORY_SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS employee_directory_snapshots (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  org_json TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS employee_directory_backfill_attempts (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  generation TEXT NOT NULL,
  last_login_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'skipped', 'failed')),
  reason TEXT,
  attempted_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS employee_directory_auth_decisions (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  authenticated_at INTEGER NOT NULL,
  decision TEXT NOT NULL,
  observed_at INTEGER NOT NULL
) STRICT;
`;

/** Additive authenticated directory facts; older runtimes safely ignore this table. */
export function ensureEmployeeDirectorySnapshotSchema(db: DatabaseSync): void {
  db.exec(EMPLOYEE_DIRECTORY_SNAPSHOT_SCHEMA);
}
