import type { DatabaseSync } from "node:sqlite";

export const BASEBALL_GAME_SCHEMA = `
CREATE TABLE IF NOT EXISTS baseball_owned_bats (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  bat_id TEXT NOT NULL,
  PRIMARY KEY (user_id, bat_id)
) STRICT;

CREATE TABLE IF NOT EXISTS baseball_game_progress (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  gold INTEGER NOT NULL CHECK (gold >= 0),
  equipped_bat_id TEXT NOT NULL,
  total_homers INTEGER NOT NULL CHECK (total_homers >= 0),
  best_distance_m INTEGER NOT NULL CHECK (best_distance_m >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  FOREIGN KEY (user_id, equipped_bat_id)
    REFERENCES baseball_owned_bats(user_id, bat_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS baseball_idempotency (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
) STRICT;
`;

/** Additive baseball easter-egg state; intentionally does not change user_version. */
export function ensureBaseballGameSchema(db: DatabaseSync): void {
  db.exec(BASEBALL_GAME_SCHEMA);
}
