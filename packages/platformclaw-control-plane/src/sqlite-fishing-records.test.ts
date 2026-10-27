import { afterEach, describe, expect, it } from "vitest";
import { chooseFishingCatch, createFishingRandom } from "./fishing-economy.js";
import { START, createFishingFixtures } from "./sqlite-fishing.test-harness.js";

const {
  setup,
  openStore,
  closeStore,
  inspect,
  execute,
  stageCatch,
  seedPreview,
  readProfile,
  writeProfile,
  cleanup,
} = createFishingFixtures();
afterEach(cleanup);

describe("private canonical fishing species records", () => {
  it("preserves the captured legacy species records beyond the globally longest fish", async () => {
    const { store, databasePath, alice } = await setup();
    store.fishing.loadFishingSnapshot(alice.id, START);
    const { prior } = seedPreview(databasePath, alice.id);
    // The heaviest species differs from the globally longest one; both records survive.
    prior.catalog = [
      { fishId: "bluegill", count: 1, bestLengthCm: 20.1, bestWeightKg: 0.17 },
      { fishId: "catfish", count: 1, bestLengthCm: 45.8, bestWeightKg: 0.73 },
      { fishId: "silver-crucian", count: 1, bestLengthCm: 43.3, bestWeightKg: 1.715 },
    ];
    prior.totalCaught = 3;
    prior.inventory = [];
    const captured = { ...prior, attempt: null };
    writeProfile(databasePath, alice.id, captured);
    closeStore(store);
    const migrated = openStore(databasePath);
    const snapshot = migrated.fishing.loadFishingSnapshot(alice.id, START);
    const state = readProfile(databasePath, alice.id);
    expect(state.speciesRecordsComplete).toBe(true);
    expect(state.speciesRecords).toEqual({
      bluegill: { count: 1, bestLengthCm: 20.1, bestWeightKg: 0.17 },
      catfish: { count: 1, bestLengthCm: 45.8, bestWeightKg: 0.73 },
      "silver-crucian": { count: 1, bestLengthCm: 43.3, bestWeightKg: 1.715 },
    });
    expect(snapshot).toMatchObject({ gold: 987, totalCaught: 3, bestCatch: { fishId: "catfish" } });
    expect(snapshot).not.toHaveProperty("speciesRecords");
    expect(snapshot).not.toHaveProperty("speciesRecordsComplete");
    closeStore(migrated);
    openStore(databasePath).fishing.loadFishingSnapshot(alice.id, START);
    expect(readProfile(databasePath, alice.id)).toEqual(state);
  });

  it.each([null, "crucian", "carp"])(
    "seeds only confirmed old-v2 facts for last species %s without changing money or receipts",
    async (fishId) => {
      const { store, databasePath, alice } = await setup();
      execute(store, alice.id, { action: "begin", requestId: "old-records" });
      const prior = readProfile(databasePath, alice.id);
      if (fishId) {
        prior.totalCaught = 9;
        prior.bestCatch = { fishId: "crucian", lengthCm: 60, weightKg: 1 };
        prior.attempt!.phase = "caught";
        prior.attempt!.result = {
          id: prior.attempt!.id,
          fishId,
          lengthCm: 50,
          weightKg: 5,
          rewardGold: 12,
          quality: "GOOD",
          accuracy: 0,
          bonusMultiplier: 1,
          caughtAt: START,
        };
      }
      Reflect.deleteProperty(prior, "speciesRecords");
      Reflect.deleteProperty(prior, "speciesRecordsComplete");
      writeProfile(databasePath, alice.id, prior);
      const financialFacts = () =>
        inspect(databasePath, (db) => [
          db
            .prepare("SELECT gold, revision FROM baseball_game_progress WHERE user_id = ?")
            .get(alice.id),
          db
            .prepare(
              "SELECT request_id, payload_digest, receipt_json FROM fishing_receipts WHERE user_id = ? ORDER BY request_id",
            )
            .all(alice.id),
          db
            .prepare("SELECT * FROM game_gold_transactions WHERE user_id = ? ORDER BY rowid")
            .all(alice.id),
        ]);
      const money = financialFacts();
      closeStore(store);
      const reopened = openStore(databasePath);
      reopened.fishing.loadFishingSnapshot(alice.id, START);
      const records = !fishId
        ? {}
        : fishId === "crucian"
          ? {
              crucian: { count: 1, bestLengthCm: 60, bestWeightKg: 5 },
            }
          : {
              crucian: { count: 1, bestLengthCm: 60, bestWeightKg: 1 },
              carp: { count: 1, bestLengthCm: 50, bestWeightKg: 5 },
            };
      const state = readProfile(databasePath, alice.id);
      expect(state).toEqual({
        ...prior,
        revision: prior.revision + 1,
        speciesRecords: records,
        speciesRecordsComplete: !fishId,
      });
      expect(financialFacts()).toEqual(money);
      closeStore(reopened);
      openStore(databasePath).fishing.loadFishingSnapshot(alice.id, START);
      expect(readProfile(databasePath, alice.id)).toEqual(state);
      expect(financialFacts()).toEqual(money);
    },
  );

  it.each([
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ] as const)(
    "updates complete=%s, known species=%s once after a new catch",
    async (complete, knownSpecies) => {
      const { store, databasePath, alice } = await setup();
      const staged = stageCatch(store, alice.id);
      const before = readProfile(databasePath, alice.id);
      const fish = chooseFishingCatch(
        createFishingRandom(before.rewardSeed),
        before.attempt!.quality!,
      );
      before.speciesRecordsComplete = complete;
      if (knownSpecies) {
        before.speciesRecords[fish.fishId] = {
          count: 4,
          bestLengthCm: fish.lengthCm + 1,
          bestWeightKg: fish.weightKg / 2,
        };
        before.bestCatch = {
          fishId: fish.fishId,
          lengthCm: fish.lengthCm + 1,
          weightKg: fish.weightKg / 2,
        };
      } else if (!complete) {
        const priorSpecies = fish.fishId === "carp" ? "crucian" : "carp";
        before.bestCatch = { fishId: priorSpecies, lengthCm: 100, weightKg: 1 };
        before.speciesRecords[priorSpecies] = { count: 1, bestLengthCm: 100, bestWeightKg: 1 };
      }
      before.totalCaught = knownSpecies || !complete ? 4 : 0;
      writeProfile(databasePath, alice.id, before);
      closeStore(store);
      const reopened = openStore(databasePath);
      const request = {
        action: "finish",
        requestId: "records-finish",
        attemptId: staged.attemptId,
      } as const;
      const caught = execute(reopened, alice.id, request, staged.finishAt);
      const state = readProfile(databasePath, alice.id);
      expect(state.speciesRecordsComplete).toBe(complete);
      expect(state.speciesRecords[fish.fishId]).toEqual({
        count: knownSpecies ? 5 : 1,
        bestLengthCm: fish.lengthCm + (knownSpecies ? 1 : 0),
        bestWeightKg: fish.weightKg,
      });
      expect(execute(reopened, alice.id, request, staged.finishAt + 1)).toMatchObject({
        gold: caught.gold,
        totalCaught: before.totalCaught + 1,
      });
      execute(
        reopened,
        alice.id,
        { action: "settle", requestId: "records-other-nonce", attemptId: staged.attemptId },
        staged.finishAt + 2,
      );
      expect(readProfile(databasePath, alice.id).speciesRecords).toEqual(state.speciesRecords);
    },
  );
});
