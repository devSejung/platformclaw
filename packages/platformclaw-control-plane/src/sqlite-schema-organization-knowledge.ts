import type { DatabaseSync } from "node:sqlite";

// Additive feature tables leave older readers usable; no control-schema bump.
export const ORGANIZATION_KNOWLEDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS organization_knowledge_jobs (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id),
  requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id),
  request_id TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  input_json TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  failure_code TEXT,
  UNIQUE(scope_id, requested_by_user_id, request_id)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS organization_knowledge_active_job
  ON organization_knowledge_jobs(scope_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS organization_knowledge_requests (
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id),
  user_id TEXT NOT NULL REFERENCES platform_users(id),
  request_id TEXT NOT NULL,
  PRIMARY KEY(scope_id, user_id, request_id)
) STRICT;
CREATE TABLE IF NOT EXISTS organization_knowledge_reports (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES organization_knowledge_jobs(id),
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id),
  input_fingerprint TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  bounds_json TEXT NOT NULL,
  completed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS organization_knowledge_reports_scope
  ON organization_knowledge_reports(scope_id, completed_at DESC, id);
CREATE TABLE IF NOT EXISTS organization_knowledge_proposals (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL REFERENCES managed_scopes(id),
  report_id TEXT NOT NULL REFERENCES organization_knowledge_reports(id),
  pair_key TEXT NOT NULL,
  comparison_json TEXT NOT NULL,
  claim_revisions_json TEXT NOT NULL,
  UNIQUE(scope_id, pair_key)
) STRICT;
CREATE TABLE IF NOT EXISTS organization_knowledge_reviews (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES organization_knowledge_proposals(id),
  revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject','keep','defer','apply')),
  actor_user_id TEXT NOT NULL REFERENCES platform_users(id),
  reason TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  UNIQUE(proposal_id, revision)
) STRICT;
`;

export function ensureOrganizationKnowledgeSchema(db: DatabaseSync): void {
  db.exec(ORGANIZATION_KNOWLEDGE_SCHEMA);
}
