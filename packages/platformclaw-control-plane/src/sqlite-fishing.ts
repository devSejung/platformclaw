import { createHash, randomInt, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  FISHING_ECONOMY_VERSION,
  FishingError,
  type FishingCatch,
  type FishingLeaderboard,
  type FishingRequest,
  type FishingSnapshot,
  type FishingStore,
} from "./fishing-contracts.js";
import {
  FISHING_MAX_INPUTS,
  chooseFishingCatch,
  calculateFishingFinishRewardGold,
  createFishingRandom,
  getFishingSpecies,
  resolveFishingDifficulty,
} from "./fishing-economy.js";
import {
  fishingHookQuality,
  fishingHookWindowMs,
  replayFishingFight,
  FISHING_FINISH_WINDOW_MS,
  resolveFishingFinish,
} from "./fishing-simulation.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import { migrateFishingProfilesToDirectPlay } from "./sqlite-fishing-migration.js";
import { selectFishingBestCatch, type SqliteFishingState } from "./sqlite-fishing-state.js";
import type { SqliteGameEconomy } from "./sqlite-game-economy.js";
import { ensureFishingSchema, type FishingDatabase } from "./sqlite-schema-fishing.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type FishingWallet = { prepare(): void; ensure(userId: string): void; economy: SqliteGameEconomy };

function requestDigest(request: FishingRequest): string {
  const canonical = Object.fromEntries(
    Object.entries(request).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** One account row owns the active manual attempt and its paid fishing records. */
export class SqliteFishingStore implements FishingStore {
  private readonly query = createSyncKysely<
    FishingDatabase & Pick<ControlPlaneDatabase, "platform_users">
  >();
  private ready = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly wallet: FishingWallet,
  ) {}

  private prepare(now: number): void {
    if (this.ready) {
      return;
    }
    this.wallet.prepare();
    ensureFishingSchema(this.db);
    migrateFishingProfilesToDirectPlay(this.db, this.wallet, now);
    this.ready = true;
  }

  private readState(userId: string): SqliteFishingState {
    const user = takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").select("status").where("id", "=", userId),
    );
    if (user?.status !== "active") {
      throw new FishingError("invalid_request", "로그인 상태를 확인한 뒤 다시 시도하세요.");
    }
    this.wallet.ensure(userId);
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("fishing_profiles").select("state_json").where("user_id", "=", userId),
    );
    if (row) {
      return JSON.parse(row.state_json) as SqliteFishingState;
    }
    return {
      economyVersion: FISHING_ECONOMY_VERSION,
      gameplayVersion: 2,
      revision: 0,
      totalCaught: 0,
      totalEarnedGold: 0,
      bestCatch: null,
      attempt: null,
      rewardSeed: 0,
      rewardQuote: null,
      lastNowAt: 0,
      goalDay: 0,
      goalWeek: 0,
      dailyCaught: 0,
      weeklyCaught: 0,
    };
  }

  private writeState(userId: string, state: SqliteFishingState): void {
    const values = {
      user_id: userId,
      state_json: JSON.stringify(state),
      total_caught: state.totalCaught,
      total_sold_gold: state.totalEarnedGold,
    };
    executeSync(
      this.db,
      this.query
        .insertInto("fishing_profiles")
        .values(values)
        .onConflict((conflict) => conflict.column("user_id").doUpdateSet(values)),
    );
  }

  private snapshot(userId: string, state: SqliteFishingState, now: number): FishingSnapshot {
    const wallet = this.wallet.economy.read(userId);
    return {
      serverNow: now,
      economyVersion: state.economyVersion,
      gold: wallet.gold,
      walletRevision: wallet.revision,
      revision: state.revision,
      totalCaught: state.totalCaught,
      totalEarnedGold: state.totalEarnedGold,
      bestCatch: state.bestCatch,
      attempt: state.attempt,
      goals: { dailyCaught: state.dailyCaught, weeklyCaught: state.weeklyCaught },
    };
  }

  loadFishingSnapshot(userId: string, now: number): FishingSnapshot {
    this.prepare(now);
    return runImmediateTransaction(this.db, () => {
      const state = this.readState(userId);
      const observedAt = Math.max(now, state.lastNowAt);
      this.advanceAttempt(userId, state, observedAt);
      this.resetGoals(state, observedAt);
      state.lastNowAt = observedAt;
      this.writeState(userId, state);
      return this.snapshot(userId, state, observedAt);
    });
  }

  executeFishing(userId: string, request: FishingRequest, now: number): FishingSnapshot {
    this.prepare(now);
    const digest = requestDigest(request);
    return runImmediateTransaction(this.db, () => {
      const state = this.readState(userId);
      const observedAt = Math.max(now, state.lastNowAt);
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("fishing_receipts")
          .selectAll()
          .where("user_id", "=", userId)
          .where("request_id", "=", request.requestId),
      );
      if (prior && prior.payload_digest !== digest) {
        throw new FishingError(
          "idempotency_conflict",
          "같은 요청 번호의 내용이 다릅니다. 새로고침 후 다시 시도하세요.",
        );
      }
      const beforeGold = this.wallet.economy.read(userId).gold;
      this.advanceAttempt(userId, state, observedAt);
      this.resetGoals(state, observedAt);
      if (!prior) {
        this.applyRequest(userId, request, state, observedAt);
        state.revision += 1;
        // Receipts retain the accepted effect rather than repeated snapshots on every reel input.
        // A retry returns fresh state but never applies the recorded effect twice.
        const receipt = {
          economyVersion: state.economyVersion,
          action: request.action,
          revision: state.revision,
          attemptId: state.attempt?.id ?? null,
          goldDelta: this.wallet.economy.read(userId).gold - beforeGold,
          acceptedAt: observedAt,
        };
        executeSync(
          this.db,
          this.query.insertInto("fishing_receipts").values({
            user_id: userId,
            request_id: request.requestId,
            payload_digest: digest,
            receipt_json: JSON.stringify(receipt),
          }),
        );
      }
      state.lastNowAt = observedAt;
      this.writeState(userId, state);
      return this.snapshot(userId, state, observedAt);
    });
  }

  private applyRequest(
    userId: string,
    request: FishingRequest,
    state: SqliteFishingState,
    now: number,
  ): void {
    if (request.action === "begin") {
      if (state.attempt && ["waiting", "fighting", "finishing"].includes(state.attempt.phase)) {
        throw new FishingError("attempt_active", "진행 중인 낚시를 먼저 마치세요.");
      }
      const biteAt = now + 2_500 + randomInt(4_500, 16_001);
      const nibbles: { at: number; durationMs: number }[] = [];
      let nibbleAt = now + 2_500;
      const count = randomInt(6);
      for (let index = 0; index < count; index++) {
        nibbleAt += randomInt(650, 2_101);
        const durationMs = randomInt(200, 451);
        if (nibbleAt + durationMs + 650 >= biteAt) {
          break;
        }
        nibbles.push({ at: nibbleAt, durationMs });
      }
      state.rewardSeed = randomInt(0x1_0000_0000);
      // Quality changes only reward gold. The selected individual and its quote
      // remain private until the terminal catch result is recorded.
      const chosen = chooseFishingCatch(createFishingRandom(state.rewardSeed), "GOOD");
      state.rewardQuote = {
        GOOD: chosen.rewardGold,
        PERFECT: chooseFishingCatch(createFishingRandom(state.rewardSeed), "PERFECT").rewardGold,
      };
      state.attempt = {
        id: randomUUID(),
        issuedAt: now,
        biteAt,
        hookDeadlineAt: biteAt + fishingHookWindowMs(),
        seed: randomInt(0x1_0000_0000),
        phase: "waiting",
        quality: null,
        hookedAt: null,
        inputs: [],
        fight: null,
        result: null,
        behavior: null,
        difficulty: null,
        nibbles,
        finishStartedAt: null,
        finishDeadlineAt: null,
      };
      return;
    }
    if (
      request.action === "hook" ||
      request.action === "reel" ||
      request.action === "settle" ||
      request.action === "finish"
    ) {
      const attempt = state.attempt;
      if (!attempt || attempt.id !== request.attemptId) {
        throw new FishingError(
          "attempt_unavailable",
          "이 낚시는 다른 세션에서 끝났습니다. 현재 상태를 다시 확인하세요.",
        );
      }
      if (request.action === "settle") {
        return;
      }
      if (request.action === "finish") {
        // A late press can arrive after the shared advance path already paid
        // the base catch. Return that recorded outcome without a second credit.
        if (attempt.phase === "caught") {
          return;
        }
        if (attempt.phase !== "finishing" || attempt.finishStartedAt === null) {
          throw new FishingError("attempt_unavailable", "마무리 막대가 나타나면 한 번 눌러주세요.");
        }
        const outcome = resolveFishingFinish(attempt.seed, now - attempt.finishStartedAt);
        this.finishCatch(userId, state, outcome.accuracy, outcome.bonusMultiplier, now);
        return;
      }
      if (request.action === "hook") {
        if (attempt.phase !== "waiting") {
          throw new FishingError(
            "attempt_unavailable",
            "챔질 기회가 끝났습니다. 결과를 확인하세요.",
          );
        }
        const quality = fishingHookQuality(now - attempt.biteAt);
        if (!quality) {
          // Early tapping consumes this opportunity; mashing cannot turn every bite into PERFECT.
          attempt.phase = "missed";
          return;
        }
        attempt.quality = quality;
        const chosen = chooseFishingCatch(createFishingRandom(state.rewardSeed), attempt.quality);
        const species = getFishingSpecies(chosen.fishId);
        attempt.behavior = species.behavior;
        attempt.difficulty = resolveFishingDifficulty(chosen.fishId, chosen.lengthCm);
        attempt.hookedAt = now;
        attempt.phase = "fighting";
        attempt.fight = replayFishingFight(
          attempt.seed,
          attempt.difficulty,
          [],
          0,
          attempt.behavior,
        );
        return;
      }
      if (attempt.phase === "finishing" || attempt.phase === "caught") {
        return;
      }
      if (attempt.phase !== "fighting" || attempt.hookedAt === null) {
        throw new FishingError(
          "attempt_unavailable",
          "물고기가 걸린 뒤 누르기와 놓기를 번갈아 사용하세요.",
        );
      }
      if (attempt.inputs.length >= FISHING_MAX_INPUTS) {
        throw new FishingError(
          "invalid_request",
          "입력이 너무 많습니다. 잠시 기다린 뒤 결과를 확인하세요.",
        );
      }
      const last = attempt.inputs.at(-1);
      if ((last?.held ?? false) === request.held) {
        return;
      }
      // Preserve every physical release, including a tap within one server
      // millisecond. Replay applies equal-time edges in order under the input cap.
      attempt.inputs.push({ atMs: now - attempt.hookedAt, held: request.held });
      this.advanceAttempt(userId, state, now);
      return;
    }
  }

  private advanceAttempt(userId: string, state: SqliteFishingState, now: number): void {
    const attempt = state.attempt;
    if (!attempt) {
      return;
    }
    if (attempt.phase === "waiting" && now > attempt.hookDeadlineAt) {
      attempt.phase = "missed";
      state.revision += 1;
    }
    if (
      attempt.phase === "fighting" &&
      attempt.hookedAt !== null &&
      attempt.difficulty !== null &&
      attempt.behavior
    ) {
      attempt.fight = replayFishingFight(
        attempt.seed,
        attempt.difficulty,
        attempt.inputs,
        now - attempt.hookedAt,
        attempt.behavior,
      );
      if (attempt.fight.status === "fighting") {
        return;
      }
      if (attempt.fight.status === "escaped") {
        attempt.phase = "escaped";
      } else {
        attempt.phase = "finishing";
        // Anchor the first observable server millisecond after the simulated landing.
        // Fractional 60 Hz times lose epoch precision; late polls cannot renew this window.
        attempt.finishStartedAt = Math.ceil(attempt.hookedAt + attempt.fight.elapsedMs);
        attempt.finishDeadlineAt = attempt.finishStartedAt + FISHING_FINISH_WINDOW_MS;
      }
      state.revision += 1;
    }
    if (
      attempt.phase === "finishing" &&
      attempt.finishDeadlineAt !== null &&
      now >= attempt.finishDeadlineAt
    ) {
      this.finishCatch(userId, state, 0, 1, now);
    }
  }

  private finishCatch(
    userId: string,
    state: SqliteFishingState,
    accuracy: number,
    bonusMultiplier: number,
    now: number,
  ): void {
    const attempt = state.attempt;
    if (
      !attempt ||
      attempt.phase !== "finishing" ||
      attempt.finishDeadlineAt === null ||
      attempt.quality === null ||
      state.rewardQuote === null
    ) {
      throw new Error("Fishing finish is not active");
    }
    const fish = chooseFishingCatch(createFishingRandom(state.rewardSeed), attempt.quality);
    attempt.result = {
      ...fish,
      id: attempt.id,
      caughtAt: Math.min(now, attempt.finishDeadlineAt),
      accuracy,
      bonusMultiplier,
      rewardGold: calculateFishingFinishRewardGold(state.rewardQuote[attempt.quality], accuracy),
    };
    attempt.phase = "caught";
    this.recordCatch(userId, state, attempt.result, now);
    state.revision += 1;
  }

  private recordCatch(
    userId: string,
    state: SqliteFishingState,
    fish: FishingCatch,
    now: number,
  ): void {
    // The ledger key is the server-issued attempt, not the caller's retry nonce.
    // Its credit and terminal phase share this same synchronous transaction.
    this.wallet.economy.change(userId, fish.rewardGold, "fishing_catch", fish.id, now);
    this.resetGoals(state, fish.caughtAt);
    state.dailyCaught += 1;
    state.weeklyCaught += 1;
    state.totalCaught += 1;
    state.totalEarnedGold += fish.rewardGold;
    state.bestCatch = selectFishingBestCatch(state.bestCatch, fish);
  }

  private resetGoals(state: SqliteFishingState, now: number): void {
    const day = Math.floor(now / 86_400_000);
    const week = Math.floor((day + 3) / 7); // Monday 00:00 UTC; Unix epoch began on Thursday.
    if (day !== state.goalDay) {
      state.goalDay = day;
      state.dailyCaught = 0;
    }
    if (week !== state.goalWeek) {
      state.goalWeek = week;
      state.weeklyCaught = 0;
    }
  }

  loadFishingLeaderboard(userId: string): FishingLeaderboard {
    this.prepare(Date.now());
    const rank = (column: "total_caught" | "total_sold_gold") =>
      executeSync(
        this.db,
        this.query
          .selectFrom("fishing_profiles as f")
          .innerJoin("platform_users as u", "u.id", "f.user_id")
          .select(["u.id", "u.display_name", "u.account_id", `f.${column} as value`])
          .where("u.status", "=", "active")
          .where(`f.${column}`, ">", 0)
          .orderBy(`f.${column}`, "desc")
          .orderBy("u.id")
          .limit(20),
      ).rows.map((row) => ({
        displayName: row.display_name ?? row.account_id,
        value: row.value,
        isCurrentUser: row.id === userId,
      }));
    return { catches: rank("total_caught"), earnedGold: rank("total_sold_gold") };
  }
}
