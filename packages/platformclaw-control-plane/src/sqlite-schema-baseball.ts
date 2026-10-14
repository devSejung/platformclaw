import type { DatabaseSync } from "node:sqlite";

const BASEBALL_AT_BAT_SCHEMA = `
CREATE TABLE IF NOT EXISTS baseball_at_bats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  pitch_sample REAL NOT NULL CHECK (pitch_sample >= 0 AND pitch_sample < 1),
  bat_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  UNIQUE (user_id, request_id)
) STRICT;
CREATE INDEX IF NOT EXISTS baseball_at_bats_user_issued
  ON baseball_at_bats(user_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS baseball_at_bats_expiry ON baseball_at_bats(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS baseball_at_bats_live_user
  ON baseball_at_bats(user_id) WHERE consumed_at IS NULL;
`;

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
CREATE INDEX IF NOT EXISTS baseball_game_progress_best_distance
  ON baseball_game_progress(best_distance_m DESC);

CREATE TABLE IF NOT EXISTS baseball_home_run_streaks (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  current_streak INTEGER NOT NULL CHECK (current_streak >= 0),
  best_streak INTEGER NOT NULL CHECK (best_streak >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS baseball_home_run_streaks_best
  ON baseball_home_run_streaks(best_streak DESC);

CREATE TABLE IF NOT EXISTS baseball_idempotency (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (user_id, request_id)
) STRICT;
${BASEBALL_AT_BAT_SCHEMA}
`;

export function ensureBaseballAtBatSchema(db: DatabaseSync): void {
  db.exec(BASEBALL_AT_BAT_SCHEMA);
}

/** Additive baseball easter-egg state; intentionally does not change user_version. */
export function ensureBaseballGameSchema(db: DatabaseSync): void {
  db.exec(BASEBALL_GAME_SCHEMA);
}
