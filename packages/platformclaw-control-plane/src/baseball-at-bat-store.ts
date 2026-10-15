import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BaseballGameError,
  getBaseballBatDefinition,
  type BaseballAtBat,
  type BaseballBatId,
  type BaseballPlateAppearanceOutcome,
} from "./baseball-contracts.js";
import { advanceBattedBall, createBattedBall } from "./baseball-simulation.js";
import { HIT_WINDOW_MS } from "./baseball-timing.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import { ensureBaseballAtBatSchema } from "./sqlite-schema-baseball.js";

const AT_BAT_LIFETIME_MS = 180_000;
const MIN_ISSUE_INTERVAL_MS = 700;
const MIN_SUBMIT_INTERVAL_MS = 300;
const RETENTION_MS = 86_400_000;
const PRUNE_INTERVAL_MS = 60_000;

type AtBatRow = {
  id: string;
  user_id: string;
  request_id: string;
  pitch_sample: number;
  bat_id: BaseballBatId;
  issued_at: number;
  expires_at: number;
  consumed_at: number | null;
};

function projectAtBat(row: AtBatRow): BaseballAtBat {
  return {
    id: row.id,
    pitchSample: row.pitch_sample,
    batId: row.bat_id,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  };
}

/** The caller owns the synchronous transaction so consumption and gold awards commit together. */
export class BaseballAtBatStore {
  private readonly query = createSyncKysely<{ baseball_at_bats: AtBatRow }>();
  private ready = false;
  private lastPruneAt: number | undefined;

  constructor(private readonly db: DatabaseSync) {}

  ensureSchema(): void {
    if (!this.ready) {
      ensureBaseballAtBatSchema(this.db);
      this.ready = true;
    }
  }

  issue(userId: string, requestId: string, batId: BaseballBatId, now: number): BaseballAtBat {
    const prior = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_at_bats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("request_id", "=", requestId),
    );
    // A lost issuance response replays the same pitch, never a second earning opportunity.
    if (prior) {
      return projectAtBat(prior);
    }
    const latest = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_at_bats")
        .select("issued_at")
        .where("user_id", "=", userId)
        .orderBy("issued_at", "desc")
        .limit(1),
    );
    if (latest && now - latest.issued_at < MIN_ISSUE_INTERVAL_MS) {
      throw new BaseballGameError(
        "at_bat_rate_limited",
        "Wait a moment before starting another at-bat",
      );
    }
    this.prune(now);
    // One live nonce per user prevents accumulating pitches in parallel tabs and cashing them later.
    executeSync(
      this.db,
      this.query
        .updateTable("baseball_at_bats")
        .set({ consumed_at: now })
        .where("user_id", "=", userId)
        .where("consumed_at", "is", null),
    );
    const row: AtBatRow = {
      id: randomUUID(),
      user_id: userId,
      request_id: requestId,
      pitch_sample: randomInt(0x1_0000_0000) / 0x1_0000_0000,
      bat_id: batId,
      issued_at: now,
      expires_at: now + AT_BAT_LIFETIME_MS,
      consumed_at: null,
    };
    executeSync(this.db, this.query.insertInto("baseball_at_bats").values(row));
    return projectAtBat(row);
  }

  consume(
    userId: string,
    id: string,
    timingDeltaMs: number | null,
    now: number,
  ): { outcome: BaseballPlateAppearanceOutcome; distanceM?: number } {
    if (
      timingDeltaMs !== null &&
      (!Number.isFinite(timingDeltaMs) || Math.abs(timingDeltaMs) > 2_000)
    ) {
      throw new BaseballGameError("invalid_swing", "Invalid swing timing; start a new at-bat");
    }
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_at_bats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("id", "=", id),
    );
    if (!row) {
      throw new BaseballGameError("at_bat_unavailable", "At-bat unavailable; start a new at-bat");
    }
    if (row.consumed_at !== null) {
      throw new BaseballGameError(
        "at_bat_consumed",
        "At-bat already submitted; start a new at-bat",
      );
    }
    if (now >= row.expires_at) {
      throw new BaseballGameError("at_bat_expired", "At-bat expired; start a new at-bat");
    }
    if (now - row.issued_at < MIN_SUBMIT_INTERVAL_MS) {
      throw new BaseballGameError("at_bat_too_early", "Pitch has not reached the batter yet");
    }
    const bat = getBaseballBatDefinition(row.bat_id);
    if (!bat) {
      throw new BaseballGameError("unknown_bat", "At-bat has an unknown bat; start a new at-bat");
    }
    // The issued bat snapshot and shared physics own the result; client outcome/distance are ignored.
    const simulation =
      timingDeltaMs !== null && Math.abs(timingDeltaMs) <= HIT_WINDOW_MS
        ? advanceBattedBall(
            createBattedBall({ timingDeltaMs, batPower: bat.exitVelocityMultiplier }),
            30_000,
          )
        : null;
    const result = simulation?.result;
    const outcome = result
      ? result.kind === "HOME_RUN"
        ? "home_run"
        : result.kind === "HIT"
          ? "hit"
          : "out"
      : "miss";
    const consumed = executeSync(
      this.db,
      this.query
        .updateTable("baseball_at_bats")
        .set({ consumed_at: now })
        .where("user_id", "=", userId)
        .where("id", "=", id)
        .where("consumed_at", "is", null),
    );
    if (consumed.numAffectedRows !== 1n) {
      throw new BaseballGameError(
        "at_bat_consumed",
        "At-bat already submitted; start a new at-bat",
      );
    }
    return {
      outcome,
      ...(result && (outcome === "home_run" || outcome === "hit")
        ? { distanceM: Math.max(0, Math.round(result.distanceM)) }
        : {}),
    };
  }

  private prune(now: number): void {
    if (this.lastPruneAt !== undefined && now - this.lastPruneAt < PRUNE_INTERVAL_MS) {
      return;
    }
    // Keep a day of retryable issuance receipts; bounded cleanup cannot stall a normal pitch.
    const deleted = executeSync(
      this.db,
      this.query.deleteFrom("baseball_at_bats").where(
        "id",
        "in",
        this.query
          .selectFrom("baseball_at_bats")
          .select("id")
          .where("expires_at", "<", now - RETENTION_MS)
          .orderBy("expires_at")
          .limit(1_000),
      ),
    );
    // A full batch means more may remain; the next issuance drains another bounded batch.
    this.lastPruneAt = deleted.numAffectedRows === 1_000n ? undefined : now;
  }
}
