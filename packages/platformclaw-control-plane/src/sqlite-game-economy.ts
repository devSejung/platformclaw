import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BaseballGameError } from "./baseball-contracts.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import { ensureGameEconomySchema } from "./sqlite-schema-game-economy.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type GoldReason =
  | "baseball_reward"
  | "bat_purchase"
  | "bat_enhancement"
  | "bat_recovery"
  | "baseball_team_change"
  | "horse_bet"
  | "horse_payout"
  | "horse_refund"
  | "fishing_catch";
type EconomyDatabase = ControlPlaneDatabase & {
  game_gold_transactions: {
    id: string;
    user_id: string;
    reason: GoldReason;
    reference_id: string;
    delta: number;
    balance_after: number;
    created_at: number;
  };
};

/** The existing gold column remains the single balance, including on upgrades. */
export class SqliteGameEconomy {
  private readonly query = createSyncKysely<EconomyDatabase>();
  private ready = false;
  constructor(private readonly db: DatabaseSync) {}

  ensureSchema(): void {
    if (this.ready) {
      return;
    }
    ensureGameEconomySchema(this.db);
    this.ready = true;
  }

  read(userId: string): { gold: number; revision: number } {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_game_progress")
        .select(["gold", "revision"])
        .where("user_id", "=", userId),
    );
    if (!row) {
      throw new Error("Game wallet has not been initialized");
    }
    return row;
  }

  /** Caller holds BEGIN IMMEDIATE: balance, receipt and game state commit together. */
  change(
    userId: string,
    delta: number,
    reason: GoldReason,
    referenceId: string,
    now: number,
  ): void {
    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new Error("Gold movement must be a nonzero safe integer");
    }
    const current = this.read(userId);
    const gold = current.gold + delta;
    if (!Number.isSafeInteger(gold) || gold < 0) {
      throw new BaseballGameError("insufficient_gold", "사용 가능한 G가 부족합니다.");
    }
    executeSync(
      this.db,
      this.query
        .updateTable("baseball_game_progress")
        .set({ gold, revision: current.revision + 1 })
        .where("user_id", "=", userId),
    );
    executeSync(
      this.db,
      this.query.insertInto("game_gold_transactions").values({
        id: randomUUID(),
        user_id: userId,
        reason,
        reference_id: referenceId,
        delta,
        balance_after: gold,
        created_at: now,
      }),
    );
  }
}
