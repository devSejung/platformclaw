import type { DatabaseSync } from "node:sqlite";

export type FishingDatabase = {
  fishing_profiles: {
    user_id: string;
    state_json: string;
    total_caught: number;
    // The existing column is retained as the durable total of paid fishing gold.
    total_sold_gold: number;
  };
  fishing_receipts: {
    user_id: string;
    request_id: string;
    payload_digest: string;
    receipt_json: string;
  };
};

export const FISHING_SCHEMA = `
CREATE TABLE IF NOT EXISTS fishing_profiles (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  total_caught INTEGER NOT NULL CHECK (total_caught >= 0),
  total_sold_gold INTEGER NOT NULL CHECK (total_sold_gold >= 0)
) STRICT;
CREATE INDEX IF NOT EXISTS fishing_profiles_catches ON fishing_profiles(total_caught DESC);
CREATE INDEX IF NOT EXISTS fishing_profiles_sales ON fishing_profiles(total_sold_gold DESC);
CREATE TABLE IF NOT EXISTS fishing_receipts (
  user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  PRIMARY KEY(user_id, request_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS fishing_receipts_immutable
BEFORE UPDATE ON fishing_receipts
BEGIN SELECT RAISE(ABORT, 'Fishing receipts are immutable'); END;
`;

/** Additive feature state; older schema-v3 builds safely ignore these tables. */
export function ensureFishingSchema(db: DatabaseSync): void {
  db.exec(FISHING_SCHEMA);
}
