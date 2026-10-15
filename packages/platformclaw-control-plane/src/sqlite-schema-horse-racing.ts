import type { DatabaseSync } from "node:sqlite";
import type { HorseBetMarket, HorseRaceStatus } from "./horse-racing-contracts.js";

export type HorseRaceRow = {
  id: string;
  starts_at: number;
  status: HorseRaceStatus;
  horses_json: string;
  seed: string;
  commitment: string;
  algorithm_version: string;
  pricing_version: "probability-net-3pct-v2" | "probability-fair-v1" | "pool-v1";
  animation_version: string;
  finish_order_json: string | null;
  cancellation_reason: "insufficient_participants" | "engine_changed" | null;
};
export type HorseBetRow = {
  id: string;
  user_id: string;
  request_id: string;
  race_id: string;
  market: HorseBetMarket;
  selection: string;
  amount: number;
  payout: number | null;
  refunded: number;
};
export type HorseRacingDatabase = {
  horse_races: HorseRaceRow;
  horse_bets: HorseBetRow;
  horse_bet_quotes: {
    bet_id: string;
    odds: number;
    potential_payout: number;
  };
  horse_bet_cancellations: {
    bet_id: string;
    created_at: number;
  };
  horse_bet_activity: {
    bet_id: string;
    created_at: number;
  };
};

/** Additive tables preserve the non-racing baseline's gold column; experimental earlier racing builds are not downgrade readers. */
export function ensureHorseRacingSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS horse_races (
    id TEXT PRIMARY KEY,
    starts_at INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('scheduled','betting','locked','racing','settled','cancelled')),
    horses_json TEXT NOT NULL,
    seed TEXT NOT NULL,
    commitment TEXT NOT NULL,
    algorithm_version TEXT NOT NULL,
    pricing_version TEXT NOT NULL CHECK(pricing_version IN ('probability-net-3pct-v2','probability-fair-v1','pool-v1')),
    animation_version TEXT NOT NULL,
    finish_order_json TEXT,
    cancellation_reason TEXT
  ) STRICT;
  CREATE TABLE IF NOT EXISTS horse_bets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    race_id TEXT NOT NULL REFERENCES horse_races(id),
    market TEXT NOT NULL CHECK(market IN ('win','quinella','quinella-place')),
    selection TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    payout INTEGER CHECK(payout >= 0),
    refunded INTEGER NOT NULL DEFAULT 0 CHECK(refunded IN (0,1)),
    UNIQUE(user_id,request_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS horse_bet_quotes (
    bet_id TEXT PRIMARY KEY REFERENCES horse_bets(id) ON DELETE CASCADE,
    odds REAL NOT NULL CHECK(odds >= 1),
    potential_payout INTEGER NOT NULL CHECK(potential_payout > 0)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS horse_bet_cancellations (
    bet_id TEXT PRIMARY KEY REFERENCES horse_bets(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS horse_bet_activity (
    bet_id TEXT PRIMARY KEY REFERENCES horse_bets(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS horse_bets_race ON horse_bets(race_id);
  CREATE INDEX IF NOT EXISTS horse_bets_user ON horse_bets(user_id,race_id);`);
}
