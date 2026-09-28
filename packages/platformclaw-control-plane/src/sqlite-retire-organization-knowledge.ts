import type { DatabaseSync } from "node:sqlite";
import { runImmediateTransaction } from "./kysely-sync.js";

const RETIREMENT = "organization-knowledge-retired";
const KNOWLEDGE_RETIREMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS platformclaw_data_retirements (
  id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL
) STRICT;
`;

/** The company upgrade intentionally deletes the retired knowledge corpus, not its directory. */
export function retireOrganizationKnowledge(db: DatabaseSync): void {
  runImmediateTransaction(db, () => {
    db.exec(KNOWLEDGE_RETIREMENT_SCHEMA);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))
      .filter((name) => /^organization_(?:memory|knowledge)_[a-z0-9_]+$/u.test(name));
    const completed = db
      .prepare("SELECT 1 FROM platformclaw_data_retirements WHERE id = ?")
      .get(RETIREMENT);
    const oldAudit = db
      .prepare(
        "SELECT 1 FROM control_audit_events WHERE event_type GLOB 'organization-memory.*' OR event_type GLOB 'organization-knowledge.*' LIMIT 1",
      )
      .get();
    const connections = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_vault_connections'",
      )
      .get();
    const oldConnections =
      connections &&
      db
        .prepare(
          "SELECT 1 FROM knowledge_vault_connections WHERE vault_id GLOB 'managed:*' LIMIT 1",
        )
        .get();
    // A rollback to an older image can recreate retired rows; the marker never excuses zombies.
    if (
      completed &&
      !oldAudit &&
      !oldConnections &&
      !tables.some((name) => db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get())
    ) {
      return;
    }
    const triggers = db
      .prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .filter((row) => tables.includes(String(row.tbl_name)));
    // Immutable historical decisions and cyclic claim references are removed in one transaction.
    // Failure restores both rows and triggers; the durable marker is written only after cleanup.
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const trigger of triggers) {
      db.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
    }
    for (const name of tables) {
      db.exec(`DELETE FROM "${name}"`);
    }
    db.prepare(
      "DELETE FROM control_audit_events WHERE event_type GLOB 'organization-memory.*' OR event_type GLOB 'organization-knowledge.*'",
    ).run();
    if (connections) {
      db.exec(`UPDATE knowledge_vault_selections SET revision = revision + 1 WHERE user_id IN
        (SELECT user_id FROM knowledge_vault_connections WHERE vault_id GLOB 'managed:*');
        DELETE FROM knowledge_vault_connections WHERE vault_id GLOB 'managed:*';`);
    }
    for (const trigger of triggers) {
      db.exec(String(trigger.sql));
    }
    db.prepare(
      "INSERT INTO platformclaw_data_retirements(id,completed_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET completed_at = excluded.completed_at",
    ).run(RETIREMENT, Date.now());
  });
}
