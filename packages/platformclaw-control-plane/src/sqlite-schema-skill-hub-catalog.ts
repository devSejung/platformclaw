import type { DatabaseSync } from "node:sqlite";

export type SkillHubCatalogRow = {
  id: string;
  registry_id: number | null;
  namespace: string;
  slug: string;
  owner_user_id: string | null;
  display_name: string;
  summary: string;
  tags_json: string;
  sharing_mode: "PUBLIC" | "SELECTED" | "PRIVATE";
  revision: number;
  current_version: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  purged_at: number | null;
  purge_pending: number;
  pending_transfer_user_id: string | null;
};

export type SkillHubCatalogRecipientRow = {
  skill_id: string;
  kind: "user" | "scope";
  target_id: string;
};
export type SkillHubCatalogCoordinateRow = {
  namespace: string;
  slug: string;
  skill_id: string;
  kind: "current" | "legacy";
};
export type SkillHubCatalogIconRow = {
  skill_id: string;
  content_type: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
};
export type SkillHubCatalogPublicationRow = {
  operation_id: string;
  skill_id: string;
  actor_user_id: string;
  version: string;
  fingerprint: string;
  expected_revision: number;
  state: "pending" | "completed" | "cancelled";
  created_at: number;
  updated_at: number;
};
export type SkillHubCatalogHistoryRow = {
  id: string;
  skill_id: string;
  actor_user_id: string | null;
  actor_name: string | null;
  action: string;
  version: string | null;
  management: number;
  details_json: string;
  created_at: number;
};
export type SkillHubCatalogBlockedVersionRow = {
  skill_id: string;
  version: string;
  reason: string;
  recorded_at: number;
};
export type SkillHubCatalogInstallationRow = {
  operation_id: string;
  agent_id: string;
  destination: "platform_server" | "assigned_vm";
  target_id: string;
  slug: string;
  skill_id: string;
  version: string;
  archive_sha256: string;
  installed_revision: string | null;
  installed_at: number;
  state: "pending" | "completed";
};
export type SkillHubCatalogMaintenanceCursorRow = {
  kind: "publication" | "purge";
  after_id: string;
};

const SKILL_HUB_CATALOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS skill_hub_catalog (
  id TEXT PRIMARY KEY,
  registry_id INTEGER UNIQUE,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  owner_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  display_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  sharing_mode TEXT NOT NULL CHECK (sharing_mode IN ('PUBLIC', 'SELECTED', 'PRIVATE')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  current_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  purged_at INTEGER,
  purge_pending INTEGER NOT NULL DEFAULT 0 CHECK (purge_pending IN (0, 1)),
  pending_transfer_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
  UNIQUE(namespace, slug),
  CHECK (purged_at IS NULL OR deleted_at IS NOT NULL),
  CHECK (purge_pending = 0 OR deleted_at IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS skill_hub_catalog_owner ON skill_hub_catalog(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS skill_hub_catalog_trash ON skill_hub_catalog(deleted_at, purged_at);
CREATE TABLE IF NOT EXISTS skill_hub_catalog_coordinates (
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skill_hub_catalog(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('current', 'legacy')),
  PRIMARY KEY(namespace, slug)
) STRICT;
CREATE TABLE IF NOT EXISTS skill_hub_catalog_recipients (
  skill_id TEXT NOT NULL REFERENCES skill_hub_catalog(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'scope')),
  target_id TEXT NOT NULL,
  PRIMARY KEY(skill_id, kind, target_id)
) STRICT;
CREATE TABLE IF NOT EXISTS skill_hub_catalog_icons (
  skill_id TEXT PRIMARY KEY REFERENCES skill_hub_catalog(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS skill_hub_catalog_publications (
  operation_id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skill_hub_catalog(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id),
  version TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS skill_hub_catalog_publications_pending
  ON skill_hub_catalog_publications(skill_id) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS skill_hub_catalog_history (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL REFERENCES skill_hub_catalog(id) ON DELETE CASCADE,
  actor_user_id TEXT,
  actor_name TEXT,
  action TEXT NOT NULL,
  version TEXT,
  management INTEGER NOT NULL CHECK (management IN (0, 1)),
  details_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS skill_hub_catalog_history_skill ON skill_hub_catalog_history(skill_id, created_at DESC);
CREATE TABLE IF NOT EXISTS skill_hub_catalog_migrations (
  id TEXT PRIMARY KEY,
  completed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS skill_hub_catalog_blocked_versions (
  skill_id TEXT NOT NULL REFERENCES skill_hub_catalog(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  reason TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(skill_id, version)
) STRICT;
CREATE TABLE IF NOT EXISTS skill_hub_catalog_installations (
  operation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  destination TEXT NOT NULL CHECK (destination IN ('platform_server', 'assigned_vm')),
  target_id TEXT NOT NULL CHECK (
    length(target_id) > 0 AND
    (destination = 'platform_server') = (target_id = 'platform-server')
  ),
  slug TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  installed_revision TEXT,
  installed_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  PRIMARY KEY(agent_id, destination, target_id, slug)
) STRICT;
CREATE TABLE IF NOT EXISTS skill_hub_catalog_maintenance_cursors (
  kind TEXT PRIMARY KEY CHECK (kind IN ('publication', 'purge')),
  after_id TEXT NOT NULL
) STRICT;
`;

/** Additive catalog state: older schema readers can ignore these tables. */
export function ensureSkillHubCatalogSchema(db: DatabaseSync): void {
  db.exec(SKILL_HUB_CATALOG_SCHEMA);
}
