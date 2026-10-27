import { createHash } from "node:crypto";
import { BaseballAtBatStore } from "./baseball-at-bat-store.js";
import {
  BASEBALL_BATS,
  BASEBALL_DEFAULT_BAT_ID,
  BaseballGameError,
  isBaseballBatId,
  type BaseballBatId,
  type BaseballAtBat,
  type BaseballEquipBatResult,
  type BaseballEnhanceBatRequest,
  type BaseballEnhanceBatResult,
  type BaseballRecoverBatRequest,
  type BaseballRecoverBatResult,
  type BaseballEquipEnhancedBatRequest,
  type BaseballEquipEnhancedBatResult,
  type BaseballSelectTeamRequest,
  type BaseballSelectTeamResult,
  type BaseballGameErrorCode,
  type BaseballGameStore,
  type BaseballLeaderboard,
  type BaseballPlateAppearanceOutcome,
  type BaseballPlateAppearanceResult,
  type BaseballProgress,
  type BaseballPurchaseBatResult,
} from "./baseball-contracts.js";
import { BASEBALL_ENHANCEMENT_RULE_VERSION } from "./baseball-enhancement.js";
import { ControlPlaneStateError } from "./contracts.js";
import {
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import { SqliteBaseballEnhancement } from "./sqlite-baseball-enhancement.js";
import { SqliteGameEconomy } from "./sqlite-game-economy.js";
import { ensureBaseballGameSchema } from "./sqlite-schema-baseball.js";
import type { SqliteControlPlaneStoreOptions } from "./sqlite-store-core.js";
import { SqliteControlPlaneOrganizationJoinStore } from "./sqlite-store-organization-join.js";

type BaseballOperationEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: BaseballGameErrorCode; message: string } };

type BaseballOperationName =
  | "plate_appearance"
  | "enhance_bat"
  | "recover_bat"
  | "equip_enhanced_bat"
  | "select_team";

const BASEBALL_LEADERBOARD_LIMIT = 5;

function normalizeBaseballRequestId(requestId: string): string {
  const normalized = requestId.trim();
  if (!normalized || normalized.length > 128) {
    throw new Error("baseball requestId must be between 1 and 128 characters");
  }
  return normalized;
}

function baseballPayloadDigest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/** Owns baseball transactions and shared-wallet progress; management remains in the store facade. */
export class SqliteControlPlaneBaseballStore
  extends SqliteControlPlaneOrganizationJoinStore
  implements BaseballGameStore
{
  readonly economy = new SqliteGameEconomy(this.db);
  private readonly baseballAtBats = new BaseballAtBatStore(this.db);
  private readonly baseballEnhancement: SqliteBaseballEnhancement;
  private baseballGameSchemaReady = false;

  constructor(
    options: SqliteControlPlaneStoreOptions,
    dependencies?: { enhancementRoll: () => number },
  ) {
    super(options);
    this.baseballEnhancement = new SqliteBaseballEnhancement(
      this.db,
      this.economy,
      dependencies?.enhancementRoll,
    );
  }

  async loadBaseballProgress(userId: string): Promise<BaseballProgress> {
    this.ensureBaseballGameSchema();
    return runImmediateTransaction(this.db, () => {
      this.ensureBaseballProgress(userId);
      return this.readBaseballProgress(userId);
    });
  }

  async loadBaseballLeaderboard(userId: string): Promise<BaseballLeaderboard> {
    this.ensureBaseballGameSchema();
    return runReadTransaction(this.db, () => {
      const distance = executeSync(
        this.db,
        this.query
          .selectFrom("baseball_game_progress as game")
          .innerJoin("platform_users as user", "user.id", "game.user_id")
          .select([
            "game.user_id as user_id",
            "game.best_distance_m as value",
            "user.account_id as account_id",
            "user.display_name as display_name",
          ])
          .where("user.status", "=", "active")
          .where("game.best_distance_m", ">", 0)
          .orderBy("game.best_distance_m", "desc")
          .orderBy("user.account_id", "asc")
          .limit(BASEBALL_LEADERBOARD_LIMIT),
      ).rows.map((row) => ({
        displayName: row.display_name?.trim() || row.account_id,
        value: row.value,
        isCurrentUser: row.user_id === userId,
      }));
      const homeRunStreak = executeSync(
        this.db,
        this.query
          .selectFrom("baseball_home_run_streaks as streak")
          .innerJoin("platform_users as user", "user.id", "streak.user_id")
          .select([
            "streak.user_id as user_id",
            "streak.best_streak as value",
            "user.account_id as account_id",
            "user.display_name as display_name",
          ])
          .where("user.status", "=", "active")
          .where("streak.best_streak", ">", 0)
          .orderBy("streak.best_streak", "desc")
          .orderBy("user.account_id", "asc")
          .limit(BASEBALL_LEADERBOARD_LIMIT),
      ).rows.map((row) => ({
        displayName: row.display_name?.trim() || row.account_id,
        value: row.value,
        isCurrentUser: row.user_id === userId,
      }));
      return { distance, homeRunStreak };
    });
  }

  async beginBaseballAtBat(params: {
    userId: string;
    requestId: string;
    now: number;
  }): Promise<BaseballAtBat> {
    this.ensureBaseballGameSchema();
    return runImmediateTransaction(this.db, () => {
      this.ensureBaseballProgress(params.userId);
      const prior = this.baseballAtBats.findIssued(params.userId, params.requestId);
      if (prior) {
        return prior;
      }
      const enhancement = this.baseballEnhancement.read(params.userId).enhancement;
      if (!enhancement) {
        throw new ControlPlaneStateError("baseball enhancement state is missing");
      }
      if (enhancement.status === "broken") {
        throw new BaseballGameError(
          "bat_broken",
          "Restore the broken bat or restart at +0 before pitching",
        );
      }
      return this.baseballAtBats.issue(params.userId, params.requestId, params.now, {
        enhancementLevel: enhancement.level,
        powerRuleVersion: BASEBALL_ENHANCEMENT_RULE_VERSION,
      });
    });
  }

  async rewardBaseballPlateAppearance(params: {
    userId: string;
    requestId: string;
    outcome?: BaseballPlateAppearanceOutcome;
    distanceM?: number;
    atBatId?: string;
    timingDeltaMs?: number | null;
    now?: number;
  }): Promise<BaseballPlateAppearanceResult> {
    const trustedDistanceM =
      params.outcome === "home_run" || params.outcome === "hit" ? params.distanceM : undefined;
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "plate_appearance",
      params.atBatId
        ? { atBatId: params.atBatId, timingDeltaMs: params.timingDeltaMs }
        : { outcome: params.outcome, distanceM: trustedDistanceM ?? null },
      () => {
        const resolved = params.atBatId
          ? this.baseballAtBats.consume(
              params.userId,
              params.atBatId,
              params.timingDeltaMs ?? null,
              params.now ?? Date.now(),
            )
          : { outcome: params.outcome, distanceM: trustedDistanceM };
        if (!resolved.outcome) {
          throw new BaseballGameError("invalid_swing", "서버에서 발급한 타석이 필요합니다.");
        }
        const { outcome, distanceM } = resolved;
        const current = this.ensureBaseballProgress(params.userId);
        const streak = this.requireBaseballHomeRunStreakRow(params.userId);
        const isHomeRun = outcome === "home_run";
        const totalHomers = current.total_homers + (isHomeRun ? 1 : 0);
        const currentHomeRunStreak = isHomeRun ? streak.current_streak + 1 : 0;
        // Both milestones belong to this accepted appearance. Independent terms
        // preserve their overlap without replaying or repricing old receipts.
        const homeRunBonusGold: 0 | 10 = isHomeRun && totalHomers % 5 === 0 ? 10 : 0;
        const homeRunStreakBonusGold: 0 | 10 = isHomeRun && currentHomeRunStreak % 3 === 0 ? 10 : 0;
        const awardedGold =
          (isHomeRun ? 8 : outcome === "hit" ? 5 : 0) + homeRunBonusGold + homeRunStreakBonusGold;
        const bestDistanceM =
          distanceM === undefined
            ? current.best_distance_m
            : Math.max(current.best_distance_m, distanceM);
        const bestHomeRunStreak = Math.max(streak.best_streak, currentHomeRunStreak);
        const streakChanged =
          currentHomeRunStreak !== streak.current_streak ||
          bestHomeRunStreak !== streak.best_streak;
        if (streakChanged) {
          executeSync(
            this.db,
            this.query
              .updateTable("baseball_home_run_streaks")
              .set({ current_streak: currentHomeRunStreak, best_streak: bestHomeRunStreak })
              .where("user_id", "=", params.userId),
          );
        }
        const changed =
          awardedGold > 0 || bestDistanceM !== current.best_distance_m || streakChanged;
        if (changed) {
          if (awardedGold > 0) {
            this.economy.change(
              params.userId,
              awardedGold,
              "baseball_reward",
              params.requestId,
              params.now ?? Date.now(),
            );
          }
          executeSync(
            this.db,
            this.query
              .updateTable("baseball_game_progress")
              .set({
                total_homers: totalHomers,
                best_distance_m: bestDistanceM,
                revision: current.revision + 1,
              })
              .where("user_id", "=", params.userId),
          );
        }
        return {
          awardedGold,
          homeRunBonusGold,
          homeRunStreakBonusGold,
          progress: this.readBaseballProgress(params.userId),
        };
      },
    );
  }

  async purchaseBaseballBat(_params: {
    userId: string;
    requestId: string;
    batId: BaseballBatId;
  }): Promise<BaseballPurchaseBatResult> {
    // Retired actions must not replay historical receipts into an active legacy loadout.
    throw new BaseballGameError(
      "legacy_purchase_closed",
      "Fixed-price bat purchases are closed; use the enhancement bat instead",
    );
  }

  async equipBaseballBat(_params: {
    userId: string;
    requestId: string;
    batId: BaseballBatId;
  }): Promise<BaseballEquipBatResult> {
    throw new BaseballGameError(
      "legacy_bat_closed",
      "Fixed-price bats are retired; use the enhancement bat instead",
    );
  }

  async enhanceBaseballBat(
    params: BaseballEnhanceBatRequest & { userId: string },
  ): Promise<BaseballEnhanceBatResult> {
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "enhance_bat",
      { expectedRevision: params.expectedRevision },
      () => ({
        ...this.baseballEnhancement.enhance(params.userId, params, Date.now()),
        progress: this.readBaseballProgress(params.userId),
      }),
    );
  }

  async recoverBaseballBat(
    params: BaseballRecoverBatRequest & { userId: string },
  ): Promise<BaseballRecoverBatResult> {
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "recover_bat",
      { expectedRevision: params.expectedRevision, action: params.action },
      () => ({
        ...this.baseballEnhancement.recover(params.userId, params, Date.now()),
        progress: this.readBaseballProgress(params.userId),
      }),
    );
  }

  async equipEnhancedBaseballBat(
    params: BaseballEquipEnhancedBatRequest & { userId: string },
  ): Promise<BaseballEquipEnhancedBatResult> {
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "equip_enhanced_bat",
      { expectedRevision: params.expectedRevision },
      () => ({
        ...this.baseballEnhancement.equip(params.userId, params),
        progress: this.readBaseballProgress(params.userId),
      }),
    );
  }

  async selectBaseballTeam(
    params: BaseballSelectTeamRequest & { userId: string },
  ): Promise<BaseballSelectTeamResult> {
    return this.runBaseballIdempotentOperation(
      params.userId,
      params.requestId,
      "select_team",
      { expectedRevision: params.expectedRevision, teamId: params.teamId },
      () => ({
        ...this.baseballEnhancement.selectTeam(params.userId, params, Date.now()),
        progress: this.readBaseballProgress(params.userId),
      }),
    );
  }

  protected ensureBaseballGameSchema(): void {
    if (this.baseballGameSchemaReady) {
      return;
    }
    ensureBaseballGameSchema(this.db);
    this.economy.ensureSchema();
    this.baseballAtBats.ensureSchema();
    this.baseballGameSchemaReady = true;
  }

  protected ensureBaseballProgress(userId: string) {
    this.requireUserRow(userId);
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_owned_bats")
        .values({ user_id: userId, bat_id: BASEBALL_DEFAULT_BAT_ID })
        .onConflict((conflict) => conflict.columns(["user_id", "bat_id"]).doNothing()),
    );
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_game_progress")
        .values({
          user_id: userId,
          gold: 0,
          equipped_bat_id: BASEBALL_DEFAULT_BAT_ID,
          total_homers: 0,
          best_distance_m: 0,
          revision: 0,
        })
        .onConflict((conflict) => conflict.column("user_id").doNothing()),
    );
    executeSync(
      this.db,
      this.query
        .insertInto("baseball_home_run_streaks")
        .values({ user_id: userId, current_streak: 0, best_streak: 0 })
        .onConflict((conflict) => conflict.column("user_id").doNothing()),
    );
    this.baseballEnhancement.ensure(userId);
    return this.requireBaseballProgressRow(userId);
  }

  private requireBaseballProgressRow(userId: string) {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("baseball_game_progress").selectAll().where("user_id", "=", userId),
    );
    if (!row) {
      throw new ControlPlaneStateError(`baseball progress is missing for user: ${userId}`);
    }
    return row;
  }

  private requireBaseballHomeRunStreakRow(userId: string) {
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("baseball_home_run_streaks").selectAll().where("user_id", "=", userId),
    );
    if (!row) {
      throw new ControlPlaneStateError("baseball home-run streak is missing");
    }
    return row;
  }

  private readBaseballProgress(userId: string): BaseballProgress {
    const row = this.requireBaseballProgressRow(userId);
    const streak = this.requireBaseballHomeRunStreakRow(userId);
    if (!isBaseballBatId(row.equipped_bat_id)) {
      throw new ControlPlaneStateError(`baseball equipped bat is invalid: ${row.equipped_bat_id}`);
    }
    const owned = executeSync(
      this.db,
      this.query.selectFrom("baseball_owned_bats").select("bat_id").where("user_id", "=", userId),
    ).rows.map((entry) => entry.bat_id);
    const ownedSet = new Set(owned);
    const ownedBatIds = BASEBALL_BATS.filter((bat) => ownedSet.has(bat.id)).map((bat) => bat.id);
    if (!ownedSet.has(row.equipped_bat_id)) {
      throw new ControlPlaneStateError(
        `baseball equipped bat is not owned: ${row.equipped_bat_id}`,
      );
    }
    return {
      gold: row.gold,
      ownedBatIds,
      equippedBatId: row.equipped_bat_id,
      totalHomers: row.total_homers,
      bestDistanceM: row.best_distance_m,
      currentHomeRunStreak: streak.current_streak,
      bestHomeRunStreak: streak.best_streak,
      revision: row.revision,
      ...this.baseballEnhancement.read(userId),
    };
  }

  private runBaseballIdempotentOperation<T>(
    userId: string,
    rawRequestId: string,
    operation: BaseballOperationName,
    payload: unknown,
    run: () => T,
  ): T {
    this.ensureBaseballGameSchema();
    const requestId = normalizeBaseballRequestId(rawRequestId);
    const payloadDigest = baseballPayloadDigest(payload);
    const envelope = runImmediateTransaction(this.db, (): BaseballOperationEnvelope<T> => {
      this.ensureBaseballProgress(userId);
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("baseball_idempotency")
          .selectAll()
          .where("user_id", "=", userId)
          .where("request_id", "=", requestId),
      );
      if (prior) {
        if (prior.operation !== operation || prior.payload_digest !== payloadDigest) {
          throw new BaseballGameError(
            "idempotency_conflict",
            "baseball requestId was already used with a different operation or payload",
          );
        }
        return JSON.parse(prior.result_json) as BaseballOperationEnvelope<T>;
      }

      let next: BaseballOperationEnvelope<T>;
      try {
        next = { ok: true, result: run() };
      } catch (error) {
        if (!(error instanceof BaseballGameError)) {
          throw error;
        }
        next = { ok: false, error: { code: error.code, message: error.message } };
      }
      executeSync(
        this.db,
        this.query.insertInto("baseball_idempotency").values({
          user_id: userId,
          request_id: requestId,
          operation,
          payload_digest: payloadDigest,
          result_json: JSON.stringify(next),
        }),
      );
      return next;
    });
    if (!envelope.ok) {
      throw new BaseballGameError(envelope.error.code, envelope.error.message);
    }
    return envelope.result;
  }
}
