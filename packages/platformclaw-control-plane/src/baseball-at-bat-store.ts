import { randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  BaseballGameError,
  type BaseballAtBat,
  type BaseballBatId,
  type BaseballPlateAppearanceOutcome,
} from "./baseball-contracts.js";
import {
  BASEBALL_ENHANCEMENT_RULE_VERSION,
  getBaseballEnhancementAppearance,
  resolveBaseballAtBatPower,
} from "./baseball-enhancement.js";
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

type EnhancementSnapshot = Required<Pick<BaseballAtBat, "enhancementLevel" | "powerRuleVersion">>;
type EnhancementSnapshotRow = {
  at_bat_id: string;
  enhancement_level: number;
  power_rule_version: "sweetspot-v1";
};

function projectAtBat(row: AtBatRow, snapshot?: EnhancementSnapshotRow): BaseballAtBat {
  // Old nonces have no enhancement row; keep their receipt intact and play them at +0.
  const enhancementLevel = snapshot?.enhancement_level ?? 0;
  return {
    id: row.id,
    pitchSample: row.pitch_sample,
    batId: getBaseballEnhancementAppearance(enhancementLevel).batId,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    enhancementLevel,
    powerRuleVersion: snapshot?.power_rule_version ?? BASEBALL_ENHANCEMENT_RULE_VERSION,
  };
}

/** The caller owns the synchronous transaction so consumption and gold awards commit together. */
export class BaseballAtBatStore {
  private readonly query = createSyncKysely<{
    baseball_at_bats: AtBatRow;
    baseball_at_bat_enhancement_snapshots: EnhancementSnapshotRow;
  }>();
  private ready = false;
  private lastPruneAt: number | undefined;

  constructor(private readonly db: DatabaseSync) {}

  ensureSchema(): void {
    if (!this.ready) {
      ensureBaseballAtBatSchema(this.db);
      this.ready = true;
    }
  }

  findIssued(userId: string, requestId: string): BaseballAtBat | undefined {
    const prior = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_at_bats")
        .selectAll()
        .where("user_id", "=", userId)
        .where("request_id", "=", requestId),
    );
    return prior ? this.project(prior) : undefined;
  }

  issue(
    userId: string,
    requestId: string,
    now: number,
    snapshot: EnhancementSnapshot,
  ): BaseballAtBat {
    // A lost issuance response replays the same pitch and immutable power, even after a loadout change.
    const prior = this.findIssued(userId, requestId);
    if (prior) {
      return prior;
    }
    const batId = getBaseballEnhancementAppearance(snapshot.enhancementLevel).batId;
    resolveBaseballAtBatPower({ batId, ...snapshot }, 0);
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
    executeSync(
      this.db,
      this.query.insertInto("baseball_at_bat_enhancement_snapshots").values({
        at_bat_id: row.id,
        enhancement_level: snapshot.enhancementLevel,
        power_rule_version: snapshot.powerRuleVersion,
      }),
    );
    return this.project(row);
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
    const atBat = this.project(row);
    const batPower = resolveBaseballAtBatPower(atBat, timingDeltaMs ?? 0);
    // The issued bat snapshot and shared physics own the result; client outcome/distance are ignored.
    const simulation =
      timingDeltaMs !== null && Math.abs(timingDeltaMs) <= HIT_WINDOW_MS
        ? advanceBattedBall(createBattedBall({ timingDeltaMs, batPower }), 30_000)
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

  private project(row: AtBatRow): BaseballAtBat {
    const snapshot = takeFirstSync(
      this.db,
      this.query
        .selectFrom("baseball_at_bat_enhancement_snapshots")
        .selectAll()
        .where("at_bat_id", "=", row.id),
    );
    return projectAtBat(row, snapshot);
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
