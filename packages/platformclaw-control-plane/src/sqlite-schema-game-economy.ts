import type { DatabaseSync } from "node:sqlite";

export const GAME_ECONOMY_SCHEMA = `
CREATE TABLE IF NOT EXISTS game_gold_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, reason, reference_id)
) STRICT;
CREATE INDEX IF NOT EXISTS game_gold_transactions_user ON game_gold_transactions(user_id, created_at);
`;

export function ensureGameEconomySchema(db: DatabaseSync): void {
  db.exec(GAME_ECONOMY_SCHEMA);
}
