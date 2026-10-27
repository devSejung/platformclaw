import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  FISHING_ECONOMY_VERSION,
  type FishingCatch,
  type FishingAttempt,
  type FishingFight,
  type FishingQuality,
} from "./fishing-contracts.js";
import {
  chooseFishingCatch,
  createFishingRandom,
  resolveFishingDifficulty,
} from "./fishing-economy.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import {
  mergeFishingSpeciesRecord,
  selectFishingBestCatch,
  type SqliteFishingState,
} from "./sqlite-fishing-state.js";
import type { SqliteGameEconomy } from "./sqlite-game-economy.js";
import type { FishingDatabase } from "./sqlite-schema-fishing.js";

type PriorRegion = "pond" | "river" | "harbor" | "deep";
type PriorCatch = Omit<FishingCatch, "rewardGold" | "accuracy" | "bonusMultiplier"> & {
  salePrice: number;
};
type PriorFishingState = {
  revision: number;
  totalCaught: number;
  totalSoldGold: number;
  inventory: PriorCatch[];
  catalog: { fishId: string; count: number; bestLengthCm: number; bestWeightKg: number }[];
  attempt:
    | (Omit<
        FishingAttempt,
        "result" | "difficulty" | "nibbles" | "finishStartedAt" | "finishDeadlineAt" | "fight"
      > & {
        region: PriorRegion;
        rodLevel: number;
        result: PriorCatch | null;
        fight: Omit<FishingFight, "escapeReason"> | null;
      })
    | null;
  auto: { region: PriorRegion; startedAt: number; expiresAt: number } | null;
  autoSeed: number;
  autoProcessed: number;
  rewardSeed: number;
  lastNowAt: number;
  goalDay: number;
  goalWeek: number;
  dailyCaught: number;
  weeklyCaught: number;
};
const MIGRATION_ID = "migration:direct-play-v2";
const MIGRATION_DIGEST = createHash("sha256").update("direct-play-v2").digest("hex");

// Historical preview quotes are user assets. Keep these prices only in this
// migration so later balance changes affect new casts, never saved catches.
const PREVIEW_BASE_PRICES: Record<string, number> = {
  crucian: 12,
  minnow: 8,
  bluegill: 13,
  "silver-crucian": 18,
  carp: 30,
  bass: 42,
  catfish: 85,
  snakehead: 140,
  "golden-crucian": 420,
  "legendary-carp": 2200,
  "dark-chub": 20,
  "willow-minnow": 18,
  barbel: 25,
  "korean-perch": 32,
  "piscivorous-chub": 55,
  "mandarin-fish": 85,
  sweetfish: 170,
  salmon: 240,
  "golden-mandarin": 700,
  "river-guardian": 4000,
  "horse-mackerel": 45,
  mackerel: 50,
  halfbeak: 55,
  sillago: 60,
  rockfish: 120,
  flounder: 160,
  "red-seabream": 300,
  "sea-bass": 410,
  "golden-flounder": 1200,
  "sea-king": 8000,
  "bullseye-rockfish": 100,
  cod: 130,
  "spanish-mackerel": 150,
  yellowtail: 180,
  tuna: 350,
  grouper: 500,
  swordfish: 1000,
  sailfish: 1500,
  anglerfish: 3500,
  "ancient-leviathan": 18000,
};

function previewRewardGold(basePrice: number, size: number, quality: FishingQuality): number {
  // Preserve the historical operation order, including half-integer rounding.
  // Current reward arithmetic may change without repricing these saved assets.
  return Math.round(basePrice * (0.85 + 0.3 * size) * (quality === "PERFECT" ? 1.1 : 1));
}

function previewRewardQuote(
  seed: number,
  fishId: string,
): NonNullable<SqliteFishingState["rewardQuote"]> {
  const random = createFishingRandom(seed);
  random(); // Species draw precedes the size draw in the historical contract.
  const size = random();
  const price = PREVIEW_BASE_PRICES[fishId]!;
  return {
    GOOD: previewRewardGold(price, size, "GOOD"),
    PERFECT: previewRewardGold(price, size, "PERFECT"),
  };
}

function retainAttempt(prior: PriorFishingState["attempt"]): FishingAttempt | null {
  if (!prior) {
    return null;
  }
  const active = prior.phase === "waiting" || prior.phase === "fighting";
  let result: FishingCatch | null = null;
  if (prior.result) {
    const { salePrice, ...caught } = prior.result;
    result = { ...caught, rewardGold: salePrice, accuracy: 0, bonusMultiplier: 1 };
  }
  return {
    id: prior.id,
    issuedAt: prior.issuedAt,
    biteAt: prior.biteAt,
    hookDeadlineAt: prior.hookDeadlineAt,
    seed: prior.seed,
    phase: active ? "missed" : prior.phase,
    quality: prior.quality,
    behavior: prior.behavior,
    difficulty: result ? resolveFishingDifficulty(result.fishId, result.lengthCm) : null,
    nibbles: [],
    hookedAt: prior.hookedAt,
    finishStartedAt: null,
    finishDeadlineAt: null,
    inputs: prior.inputs,
    // Historical previews did not record why a fish escaped. Preserve their
    // terminal facts without reconstructing a cause from tension or duration.
    fight: active || !prior.fight ? null : { ...prior.fight, escapeReason: null },
    result,
  };
}

function choosePreviewAutoCatch(region: PriorRegion, random: () => number) {
  // The historical four10000-weight groups remain in their original order
  // inside the40000-weight pool. Change only that draw; retain the size sample.
  const group = { pond: 0, river: 1, harbor: 2, deep: 3 }[region];
  let first = true;
  let size = 0;
  const fish = chooseFishingCatch(() => {
    const sample = random();
    if (!first) {
      size = sample;
    }
    const value = first ? (group + sample) / 4 : sample;
    first = false;
    return value;
  }, "GOOD");
  return {
    ...fish,
    rewardGold: previewRewardGold(PREVIEW_BASE_PRICES[fish.fishId]!, size, "GOOD"),
  };
}

function convertProfile(
  prior: PriorFishingState,
  now: number,
): { state: SqliteFishingState; paidGold: number } {
  const state: SqliteFishingState = {
    gameplayVersion: 2,
    economyVersion: FISHING_ECONOMY_VERSION,
    revision: prior.revision + 1,
    totalCaught: prior.totalCaught,
    totalEarnedGold: prior.totalSoldGold,
    bestCatch: null,
    attempt: retainAttempt(prior.attempt),
    rewardSeed: prior.rewardSeed,
    rewardQuote: null,
    speciesRecords: {},
    speciesRecordsComplete: true,
    lastNowAt: now,
    goalDay: prior.goalDay,
    goalWeek: prior.goalWeek,
    dailyCaught: prior.dailyCaught,
    weeklyCaught: prior.weeklyCaught,
  };
  for (const record of prior.catalog) {
    mergeFishingSpeciesRecord(
      state.speciesRecords,
      {
        fishId: record.fishId,
        lengthCm: record.bestLengthCm,
        weightKg: record.bestWeightKg,
      },
      record.count,
    );
    state.bestCatch = selectFishingBestCatch(state.bestCatch, {
      fishId: record.fishId,
      lengthCm: record.bestLengthCm,
      weightKg: record.bestWeightKg,
    });
  }
  let paidGold = prior.inventory.reduce((sum, fish) => sum + fish.salePrice, 0);
  const lease = prior.auto;
  if (lease) {
    // Honor elapsed preview attempts only, with their original30-attempt/100-item
    // bounds. No future auto activity survives the direct-play cutover.
    const completed = Math.min(
      30,
      Math.floor((Math.min(now, lease.expiresAt) - lease.startedAt) / 60_000),
    );
    let count = prior.inventory.length;
    for (let index = prior.autoProcessed; index < completed && count < 100; index++) {
      const random = createFishingRandom((prior.autoSeed + Math.imul(index + 1, 0x9e3779b9)) >>> 0);
      if (random() >= 0.7) {
        continue;
      }
      const fish = choosePreviewAutoCatch(lease.region, random);
      paidGold += fish.rewardGold;
      state.totalCaught += 1;
      mergeFishingSpeciesRecord(state.speciesRecords, fish, 1);
      state.bestCatch = selectFishingBestCatch(state.bestCatch, fish);
      const caughtDay = Math.floor((lease.startedAt + (index + 1) * 60_000) / 86_400_000);
      const caughtWeek = Math.floor((caughtDay + 3) / 7);
      if (state.goalDay !== caughtDay) {
        state.goalDay = caughtDay;
        state.dailyCaught = 0;
      }
      if (state.goalWeek !== caughtWeek) {
        state.goalWeek = caughtWeek;
        state.weeklyCaught = 0;
      }
      state.dailyCaught += 1;
      state.weeklyCaught += 1;
      count += 1;
    }
  }
  state.totalEarnedGold += paidGold;
  return { state, paidGold };
}

/** Initialization-only, preserving the existing tables, receipts and gold. */
export function migrateFishingProfilesToDirectPlay(
  db: DatabaseSync,
  wallet: {
    ensure(userId: string): void;
    economy: SqliteGameEconomy;
  },
  now: number,
): void {
  const query = createSyncKysely<FishingDatabase>();
  // SqliteControlPlaneStore passes the same DatabaseSync to fishing and economy.
  // Economy.change neither opens nor commits a transaction; this owner commits all3 facts.
  runImmediateTransaction(db, () => {
    const profiles = executeSync(db, query.selectFrom("fishing_profiles").selectAll()).rows;
    for (const profile of profiles) {
      const stored = JSON.parse(profile.state_json) as SqliteFishingState | PriorFishingState;
      if ("gameplayVersion" in stored && stored.gameplayVersion === 2) {
        const attempt = stored.attempt;
        let changed = false;
        if (!Object.hasOwn(stored, "speciesRecords")) {
          stored.speciesRecords = {};
          // Earlier direct-play previews retained only these two confirmed facts.
          // Deduplicate their species and never invent missing historical counts.
          stored.speciesRecordsComplete = stored.totalCaught === 0;
          for (const fish of [stored.bestCatch, attempt?.result]) {
            if (fish) {
              mergeFishingSpeciesRecord(
                stored.speciesRecords,
                fish,
                stored.speciesRecords[fish.fishId] ? 0 : 1,
              );
            }
          }
          changed = true;
        }
        if (!Object.hasOwn(stored, "rewardQuote")) {
          stored.rewardQuote =
            attempt && ["waiting", "fighting", "finishing"].includes(attempt.phase)
              ? previewRewardQuote(
                  stored.rewardSeed,
                  chooseFishingCatch(createFishingRandom(stored.rewardSeed), "GOOD").fishId,
                )
              : null;
          changed = true;
        }
        if (attempt) {
          // Identity and size now belong only to the final result. Remove retired
          // preview hints without changing private quotes, records or receipts.
          const retired = attempt as FishingAttempt & {
            fishId?: unknown;
            fishLengthCm?: unknown;
            rarity?: unknown;
          };
          for (const key of ["fishId", "fishLengthCm", "rarity"] as const) {
            if (Object.hasOwn(retired, key)) {
              delete retired[key];
              changed = true;
            }
          }
        }
        if (attempt?.fight && !Object.hasOwn(attempt.fight, "escapeReason")) {
          attempt.fight.escapeReason = null;
          changed = true;
        }
        if (changed) {
          // Normalize retired preview metadata once at initialization. In-flight
          // physics, balances and immutable receipts retain their existing ownership.
          stored.revision += 1;
          executeSync(
            db,
            query
              .updateTable("fishing_profiles")
              .set({ state_json: JSON.stringify(stored) })
              .where("user_id", "=", profile.user_id),
          );
        }
        continue;
      }
      const existing = takeFirstSync(
        db,
        query
          .selectFrom("fishing_receipts")
          .select("request_id")
          .where("user_id", "=", profile.user_id)
          .where("request_id", "=", MIGRATION_ID),
      );
      if (existing) {
        throw new Error(
          "Fishing migration receipt and profile disagree; restore a verified database backup before retrying.",
        );
      }
      const prior = stored as PriorFishingState;
      const observedAt = Math.max(now, prior.lastNowAt);
      const { state, paidGold } = convertProfile(prior, observedAt);
      // Reserve first under the same write lock. A crash/failure rolls this receipt,
      // the shared-wallet movement and the canonical profile back together.
      executeSync(
        db,
        query.insertInto("fishing_receipts").values({
          user_id: profile.user_id,
          request_id: MIGRATION_ID,
          payload_digest: MIGRATION_DIGEST,
          receipt_json: JSON.stringify({
            action: "direct-play-migration",
            economyVersion: state.economyVersion,
            revision: state.revision,
            goldDelta: paidGold,
            acceptedAt: observedAt,
          }),
        }),
      );
      wallet.ensure(profile.user_id);
      if (paidGold > 0) {
        wallet.economy.change(profile.user_id, paidGold, "fishing_catch", MIGRATION_ID, observedAt);
      }
      executeSync(
        db,
        query
          .updateTable("fishing_profiles")
          .set({
            state_json: JSON.stringify(state),
            total_caught: state.totalCaught,
            total_sold_gold: state.totalEarnedGold,
          })
          .where("user_id", "=", profile.user_id),
      );
    }
  });
}
