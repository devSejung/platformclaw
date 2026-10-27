import { afterEach, describe, expect, it } from "vitest";
import type { FishingRequest } from "./fishing-contracts.js";
import {
  chooseFishingCatch,
  createFishingRandom,
  resolveFishingDifficulty,
} from "./fishing-economy.js";
import { FISHING_FINISH_WINDOW_MS, replayFishingFight } from "./fishing-simulation.js";
import { START, createFishingFixtures } from "./sqlite-fishing.test-harness.js";

const {
  setup,
  openStore,
  closeStore,
  inspect,
  execute,
  stageCatch,
  catchFish,
  seedPreview,
  readProfile,
  cleanup,
} = createFishingFixtures();
afterEach(cleanup);
describe("direct fishing records and shared gold", () => {
  it("anchors fractional fixed-step landings to integer server time and the ledger clock", async () => {
    const { store, databasePath, alice } = await setup();
    const staged = stageCatch(store, alice.id);
    const before = store.fishing.loadFishingSnapshot(alice.id, staged.landedAt - 1);
    expect(before.attempt?.phase).toBe("fighting");
    const landed = store.fishing.loadFishingSnapshot(alice.id, staged.landedAt);
    expect(landed.attempt).toMatchObject({
      phase: "finishing",
      finishStartedAt: staged.landedAt,
      finishDeadlineAt: staged.deadlineAt,
    });
    expect(Number.isSafeInteger(landed.attempt!.finishStartedAt)).toBe(true);
    expect(Number.isSafeInteger(landed.attempt!.finishDeadlineAt)).toBe(true);
    const later = store.fishing.loadFishingSnapshot(alice.id, staged.landedAt + 1000);
    expect(later).toMatchObject({
      gold: 0,
      totalCaught: 0,
      attempt: { finishStartedAt: staged.landedAt },
    });
    const timedOut = store.fishing.loadFishingSnapshot(alice.id, staged.deadlineAt);
    expect(timedOut.attempt?.result?.bonusMultiplier).toBe(1);
    expect(timedOut.attempt?.result?.caughtAt).toBe(staged.deadlineAt);
    inspect(databasePath, (db) => {
      expect(
        db
          .prepare(
            "SELECT created_at, typeof(created_at) AS storage_type FROM game_gold_transactions WHERE user_id = ?",
          )
          .get(alice.id),
      ).toEqual({ created_at: staged.deadlineAt, storage_type: "integer" });
    });
  });

  it("issues bounded irregular nibbles and keeps fish identity and size private after the hook", async () => {
    const { store, databasePath, alice } = await setup();
    const request: FishingRequest = { action: "begin", requestId: "nibble-schedule" };
    const snapshot = execute(store, alice.id, request);
    const attempt = snapshot.attempt!;
    expect(attempt.biteAt - attempt.issuedAt).toBeGreaterThanOrEqual(7000);
    expect(attempt.biteAt - attempt.issuedAt).toBeLessThanOrEqual(18500);
    expect(attempt.hookDeadlineAt - attempt.biteAt).toBe(1500);
    expect(attempt.nibbles.length).toBeLessThanOrEqual(5);
    let previousAt = START + 2500;
    for (const nibble of attempt.nibbles) {
      expect(nibble.at - previousAt).toBeGreaterThanOrEqual(650);
      expect(nibble.at - previousAt).toBeLessThanOrEqual(2100);
      expect(nibble.durationMs).toBeGreaterThanOrEqual(200);
      expect(nibble.durationMs).toBeLessThanOrEqual(450);
      expect(nibble.at + nibble.durationMs + 650).toBeLessThan(attempt.biteAt);
      previousAt = nibble.at;
    }
    expect(attempt).toMatchObject({ difficulty: null, phase: "waiting" });
    const chosen = inspect(databasePath, (db) => {
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string };
      const saved = JSON.parse(row.state_json) as { rewardSeed: number };
      return chooseFishingCatch(createFishingRandom(saved.rewardSeed), "GOOD");
    });
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(attempt).not.toHaveProperty(field);
    }
    expect(attempt).not.toHaveProperty("rewardSeed");
    expect(attempt).not.toHaveProperty("rewardGold");
    expect(attempt).not.toHaveProperty("region");
    expect(execute(store, alice.id, request).attempt).toEqual(attempt);
    const hooked = execute(
      store,
      alice.id,
      { action: "hook", requestId: "actual-hook", attemptId: attempt.id },
      attempt.biteAt,
    );
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(hooked.attempt).not.toHaveProperty(field);
    }
    expect(hooked.attempt!.difficulty).toBeGreaterThanOrEqual(1);
    expect(hooked.attempt!.difficulty).toBeLessThanOrEqual(10);
    expect(hooked.attempt).toMatchObject({
      difficulty: resolveFishingDifficulty(chosen.fishId, chosen.lengthCm),
      fight: { escapeReason: null },
    });
  });

  it("prepares individual size difficulty on the server and replays its stronger physical pull", async () => {
    const { store, databasePath, alice, bob } = await setup();
    const selected: { seed: number; fish: ReturnType<typeof chooseFishingCatch> }[] = [];
    for (let seed = 0; seed < 10_000 && selected.length < 2; seed++) {
      const fish = chooseFishingCatch(createFishingRandom(seed), "GOOD");
      if (fish.fishId !== "crucian") {
        continue;
      }
      if (
        (!selected.length && fish.lengthCm <= 13) ||
        (selected.length === 1 && fish.lengthCm >= 32)
      ) {
        selected.push({ seed, fish });
      }
    }
    expect(selected).toHaveLength(2);
    const fights = [alice, bob].map((user, index) => {
      const candidate = selected[index]!;
      const perfect = chooseFishingCatch(createFishingRandom(candidate.seed), "PERFECT");
      expect(perfect).toMatchObject({
        fishId: candidate.fish.fishId,
        lengthCm: candidate.fish.lengthCm,
        weightKg: candidate.fish.weightKg,
      });
      const begin = execute(store, user.id, { action: "begin", requestId: "size-begin" });
      // Authoritative seed fixtures give two sizes the same public physics seed;
      // the authenticated API rejects these fields rather than accepting them.
      inspect(databasePath, (db) => {
        const row = db
          .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
          .get(user.id) as { state_json: string };
        const saved = JSON.parse(row.state_json);
        saved.rewardSeed = candidate.seed;
        saved.attempt.seed = 123;
        db.prepare("UPDATE fishing_profiles SET state_json = ? WHERE user_id = ?").run(
          JSON.stringify(saved),
          user.id,
        );
      });
      const attempt = begin.attempt!;
      const hookedAt = attempt.biteAt + 150;
      const hooked = execute(
        store,
        user.id,
        { action: "hook", requestId: "size-hook", attemptId: attempt.id },
        hookedAt,
      );
      expect(hooked.attempt!.difficulty).toBe(
        resolveFishingDifficulty(candidate.fish.fishId, candidate.fish.lengthCm),
      );
      execute(
        store,
        user.id,
        { action: "reel", requestId: "size-hold", attemptId: attempt.id, held: true },
        hookedAt,
      );
      const observed = store.fishing.loadFishingSnapshot(user.id, hookedAt + 500).attempt!;
      expect(observed.fight).toEqual(
        replayFishingFight(123, observed.difficulty!, [{ atMs: 0, held: true }], 500, "steady"),
      );
      return observed;
    });
    expect(fights[1]!.difficulty!).toBeGreaterThan(fights[0]!.difficulty!);
    expect(fights[1]!.fight!.tension).toBeGreaterThan(fights[0]!.fight!.tension);
  });

  it("holds payment for the finishing window and resolves an edge press as a single base reward", async () => {
    const { store, databasePath, alice } = await setup();
    const staged = stageCatch(store, alice.id);
    const pending = execute(
      store,
      alice.id,
      { action: "settle", requestId: "land", attemptId: staged.attemptId },
      staged.landedAt,
    );
    expect(pending).toMatchObject({
      gold: 0,
      totalCaught: 0,
      attempt: { phase: "finishing", result: null },
    });
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(pending.attempt).not.toHaveProperty(field);
    }
    expect(pending.attempt?.finishDeadlineAt).toBe(staged.deadlineAt);
    expect(() =>
      execute(store, alice.id, { action: "begin", requestId: "premature-cast" }, staged.landedAt),
    ).toThrow(/진행 중/);
    const phase = ((pending.attempt!.seed >>> 0) % 1200) / 1200;
    const edgeAt = Math.round(staged.landedAt + (1 - phase) * 1200);
    const result = execute(
      store,
      alice.id,
      { action: "finish", requestId: "edge-finish", attemptId: staged.attemptId },
      edgeAt,
    );
    expect(result.attempt!.result!.accuracy).toBeCloseTo(0, 3);
    expect(result.attempt!.result!.bonusMultiplier).toBeCloseTo(1, 3);
    const base = inspect(databasePath, (db) => {
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string };
      const state = JSON.parse(row.state_json) as { rewardSeed: number };
      return chooseFishingCatch(createFishingRandom(state.rewardSeed), "PERFECT").rewardGold;
    });
    expect(result.gold).toBe(base);
    const duplicate = execute(
      store,
      alice.id,
      { action: "finish", requestId: "second-finish", attemptId: staged.attemptId },
      edgeAt + 10,
    );
    expect(duplicate).toMatchObject({ gold: base, totalCaught: 1 });
  });

  it.each(["snapshot", "settle", "finish"] as const)(
    "completes a missed finishing deadline at1x through %s without renewing its window",
    async (source) => {
      const { store, databasePath, alice } = await setup();
      const staged = stageCatch(store, alice.id);
      const now = staged.deadlineAt + 1000;
      const result =
        source === "snapshot"
          ? store.fishing.loadFishingSnapshot(alice.id, now)
          : execute(
              store,
              alice.id,
              { action: source, requestId: "late-completion", attemptId: staged.attemptId },
              now,
            );
      expect(result).toMatchObject({
        totalCaught: 1,
        attempt: {
          phase: "caught",
          result: { accuracy: 0, bonusMultiplier: 1, caughtAt: staged.deadlineAt },
        },
      });
      expect(result.gold).toBe(result.attempt!.result!.rewardGold);
      closeStore(store);
      const reopened = openStore(databasePath);
      const retry = execute(
        reopened,
        alice.id,
        { action: "finish", requestId: "late-after-reopen", attemptId: staged.attemptId },
        now + 10,
      );
      expect(retry).toMatchObject({ gold: result.gold, totalCaught: 1 });
    },
  );

  it("credits each catch once across retries, other tabs and database reopen", async () => {
    const { store, databasePath, alice, bob } = await setup();
    const caught = catchFish(store, alice.id);
    const fish = caught.attempt!.result!;
    expect(caught).toMatchObject({
      gold: fish.rewardGold,
      totalCaught: 1,
      totalEarnedGold: fish.rewardGold,
      goals: { dailyCaught: 1, weeklyCaught: 1 },
      bestCatch: { fishId: fish.fishId, lengthCm: fish.lengthCm, weightKg: fish.weightKg },
    });
    expect(fish.quality).toBe("PERFECT");
    for (const field of ["fishId", "fishLengthCm", "rarity"]) {
      expect(caught.attempt).not.toHaveProperty(field);
    }
    expect(caught.attempt!.difficulty).toBe(resolveFishingDifficulty(fish.fishId, fish.lengthCm));
    expect(fish.accuracy).toBeCloseTo(1, 3);
    expect(fish.bonusMultiplier).toBeCloseTo(2, 3);
    expect(JSON.stringify(caught)).not.toContain("rewardSeed");
    expect(JSON.stringify(caught)).not.toContain("rewardQuote");
    expect(caught).not.toHaveProperty("speciesRecords");
    const second = openStore(databasePath);
    const retry: FishingRequest = {
      action: "settle",
      requestId: "another-tab",
      attemptId: fish.id,
    };
    expect(execute(second, alice.id, retry, caught.serverNow + 100).gold).toBe(fish.rewardGold);
    expect(execute(second, alice.id, retry, caught.serverNow + 200).totalCaught).toBe(1);
    expect(second.fishing.loadFishingSnapshot(bob.id, START).gold).toBe(0);
    expect(await second.loadBaseballProgress(alice.id)).toMatchObject({ gold: fish.rewardGold });
    closeStore(store);
    closeStore(second);
    const reopened = openStore(databasePath);
    expect(reopened.fishing.loadFishingSnapshot(alice.id, caught.serverNow + 300)).toMatchObject({
      gold: fish.rewardGold,
      totalCaught: 1,
    });
    expect(readProfile(databasePath, alice.id)).toMatchObject({
      speciesRecordsComplete: true,
      speciesRecords: {
        [fish.fishId]: { count: 1, bestLengthCm: fish.lengthCm, bestWeightKg: fish.weightKg },
      },
    });
    inspect(databasePath, (db) => {
      expect(
        db
          .prepare(
            "SELECT reason, reference_id, delta FROM game_gold_transactions WHERE user_id = ?",
          )
          .all(alice.id),
      ).toEqual([{ reason: "fishing_catch", reference_id: fish.id, delta: fish.rewardGold }]);
      expect(() =>
        db
          .prepare("UPDATE fishing_receipts SET receipt_json = '{}' WHERE user_id = ?")
          .run(alice.id),
      ).toThrow(/immutable/);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    });
  });

  it("keeps one live attempt per account, rejects nonce reuse and allows another cast immediately after a result", async () => {
    const { store, databasePath, alice, bob } = await setup();
    const begin: FishingRequest = { action: "begin", requestId: "first" };
    const first = execute(store, alice.id, begin);
    const second = openStore(databasePath);
    expect(execute(second, alice.id, begin).attempt?.id).toBe(first.attempt?.id);
    expect(() => execute(second, alice.id, { action: "begin", requestId: "parallel" })).toThrow(
      /진행 중/,
    );
    expect(() =>
      execute(second, alice.id, {
        action: "hook",
        requestId: begin.requestId,
        attemptId: first.attempt!.id,
      }),
    ).toThrow(/요청 번호/);
    expect(() =>
      execute(second, bob.id, {
        action: "hook",
        requestId: "foreign",
        attemptId: first.attempt!.id,
      }),
    ).toThrow(/다른 세션/);
    let attempt = first.attempt!;
    for (let index = 0; index < 4; index++) {
      const now = START + (index + 1) * 1000;
      expect(
        execute(
          store,
          alice.id,
          { action: "hook", requestId: `early-${index}`, attemptId: attempt.id },
          now,
        ).attempt?.phase,
      ).toBe("missed");
      const next = execute(second, alice.id, { action: "begin", requestId: `next-${index}` }, now);
      expect(next.attempt).not.toHaveProperty("region");
      attempt = next.attempt!;
    }
    const missed = second.fishing.loadFishingSnapshot(alice.id, attempt.hookDeadlineAt + 1);
    expect(missed).toMatchObject({ totalCaught: 0, gold: 0, attempt: { phase: "missed" } });
    expect(second.fishing.loadFishingSnapshot(alice.id, 0).serverNow).toBe(missed.serverNow);
  });

  it.each([0, 1, 20, 59])(
    "accepts a physical release after %ims without leaving the server holding the line",
    async (releaseMs) => {
      const { store, alice } = await setup();
      const begin = execute(store, alice.id, { action: "begin", requestId: "quick-tap-begin" });
      const attempt = begin.attempt!;
      execute(
        store,
        alice.id,
        { action: "hook", requestId: "quick-tap-hook", attemptId: attempt.id },
        attempt.biteAt,
      );
      execute(
        store,
        alice.id,
        { action: "reel", requestId: "quick-tap-down", attemptId: attempt.id, held: true },
        attempt.biteAt,
      );
      const release = {
        action: "reel",
        requestId: "quick-tap-up",
        attemptId: attempt.id,
        held: false,
      } as const;
      const released = execute(store, alice.id, release, attempt.biteAt + releaseMs);
      expect(released.attempt!.inputs).toEqual([
        { atMs: 0, held: true },
        { atMs: releaseMs, held: false },
      ]);
      expect(execute(store, alice.id, release, attempt.biteAt + releaseMs).attempt!.inputs).toEqual(
        released.attempt!.inputs,
      );
      const observed = store.fishing.loadFishingSnapshot(alice.id, attempt.biteAt + 200);
      const prepared = observed.attempt!;
      const heldOnly = replayFishingFight(
        prepared.seed,
        prepared.difficulty!,
        [{ atMs: 0, held: true }],
        200,
        prepared.behavior!,
      );
      expect(prepared.fight).toEqual(
        replayFishingFight(
          prepared.seed,
          prepared.difficulty!,
          prepared.inputs,
          200,
          prepared.behavior!,
        ),
      );
      expect(prepared.fight!.tension).toBeLessThan(heldOnly.tension);
      if (releaseMs === 0) {
        expect(prepared.fight).toEqual(
          replayFishingFight(prepared.seed, prepared.difficulty!, [], 200, prepared.behavior!),
        );
      }
      expect(store.fishing.loadFishingSnapshot(alice.id, attempt.biteAt + 7000)).toMatchObject({
        gold: 0,
        totalCaught: 0,
        attempt: { phase: "escaped", fight: { escapeReason: "slack" } },
      });
    },
  );

  it("accepts the 48th release at the same server millisecond and rejects a 49th edge without a reward", async () => {
    const { store, alice } = await setup();
    const begin = execute(store, alice.id, { action: "begin", requestId: "edge-budget-begin" });
    const attempt = begin.attempt!;
    execute(
      store,
      alice.id,
      { action: "hook", requestId: "edge-budget-hook", attemptId: attempt.id },
      attempt.biteAt,
    );
    for (let index = 0; index < 48; index++) {
      const result = execute(
        store,
        alice.id,
        {
          action: "reel",
          requestId: `edge-${index}`,
          attemptId: attempt.id,
          held: index % 2 === 0,
        },
        attempt.biteAt,
      );
      expect(result.attempt!.inputs).toHaveLength(index + 1);
      expect(result.attempt!.inputs.at(-1)).toEqual({ atMs: 0, held: index % 2 === 0 });
    }
    expect(() =>
      execute(
        store,
        alice.id,
        { action: "reel", requestId: "edge-49", attemptId: attempt.id, held: true },
        attempt.biteAt,
      ),
    ).toThrow(/입력이 너무 많습니다/);
    const observed = store.fishing.loadFishingSnapshot(alice.id, attempt.biteAt + 200);
    const prepared = observed.attempt!;
    expect(prepared.inputs).toHaveLength(48);
    expect(prepared.inputs.at(-1)?.held).toBe(false);
    expect(prepared.fight).toEqual(
      replayFishingFight(prepared.seed, prepared.difficulty!, [], 200, prepared.behavior!),
    );
    expect(store.fishing.loadFishingSnapshot(alice.id, attempt.biteAt + 7000)).toMatchObject({
      gold: 0,
      totalCaught: 0,
      attempt: { phase: "escaped", fight: { escapeReason: "slack" } },
    });
  });

  it("does not credit hold-only or idle fights", async () => {
    const { store, alice } = await setup();
    for (const [index, held] of [true, false].entries()) {
      const begin = execute(
        store,
        alice.id,
        { action: "begin", requestId: `begin-${index}` },
        START + index * 30_000,
      );
      const attempt = begin.attempt!;
      execute(
        store,
        alice.id,
        { action: "hook", requestId: `hook-${index}`, attemptId: attempt.id },
        attempt.biteAt + 150,
      );
      if (held) {
        execute(
          store,
          alice.id,
          { action: "reel", requestId: `hold-${index}`, attemptId: attempt.id, held },
          attempt.biteAt + 150,
        );
      }
      expect(store.fishing.loadFishingSnapshot(alice.id, attempt.biteAt + 7151)).toMatchObject({
        totalCaught: 0,
        gold: 0,
        attempt: {
          phase: "escaped",
          quality: "GOOD",
          fight: { escapeReason: held ? "line_broken" : "slack" },
        },
      });
    }
  });

  it("rolls credit, ledger, phase and receipt back together when completion persistence fails", async () => {
    const { store, databasePath, alice } = await setup();
    const staged = stageCatch(store, alice.id);
    const finish: FishingRequest = {
      action: "finish",
      requestId: "faulted-finish",
      attemptId: staged.attemptId,
    };
    inspect(databasePath, (db) =>
      db.exec(`CREATE TRIGGER fishing_receipt_failure BEFORE INSERT ON fishing_receipts
      WHEN NEW.request_id = 'faulted-finish' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`),
    );
    expect(() => execute(store, alice.id, finish, staged.finishAt)).toThrow(
      /injected receipt failure/,
    );
    closeStore(store);
    inspect(databasePath, (db) => {
      expect(
        db.prepare("SELECT gold FROM baseball_game_progress WHERE user_id = ?").get(alice.id),
      ).toEqual({ gold: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ?")
          .get(alice.id),
      ).toEqual({ count: 0 });
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string };
      expect(JSON.parse(row.state_json)).toMatchObject({
        totalCaught: 0,
        totalEarnedGold: 0,
        speciesRecords: {},
        speciesRecordsComplete: true,
        attempt: { phase: "fighting" },
      });
      db.exec("DROP TRIGGER fishing_receipt_failure");
    });
    const reopened = openStore(databasePath);
    const result = execute(reopened, alice.id, finish, staged.finishAt + 100);
    expect(result).toMatchObject({ totalCaught: 1, gold: result.attempt!.result!.rewardGold });
    expect(execute(reopened, alice.id, finish, staged.finishAt + 200).gold).toBe(result.gold);
    expect(
      Object.values(readProfile(databasePath, alice.id).speciesRecords).map(
        (record) => record.count,
      ),
    ).toEqual([1]);
  });

  it("preserves preview records, credits saved fish once and replays historical nonces through canonical state", async () => {
    const { store, databasePath, alice } = await setup();
    store.fishing.loadFishingSnapshot(alice.id, START);
    const old = seedPreview(databasePath, alice.id);
    closeStore(store);
    const migrated = openStore(databasePath);
    const snapshot = migrated.fishing.loadFishingSnapshot(alice.id, START + 1000);
    expect(snapshot).toMatchObject({
      gold: 999,
      totalCaught: 9,
      totalEarnedGold: 92,
      bestCatch: { fishId: "crucian", lengthCm: 60, weightKg: 2 },
      attempt: { result: { lengthCm: 15, rewardGold: 12 }, fight: { escapeReason: null } },
    });
    expect(snapshot).not.toHaveProperty("inventory");
    expect(snapshot).not.toHaveProperty("catalog");
    expect(snapshot).not.toHaveProperty("auto");
    expect(execute(migrated, alice.id, old.legacyRequest, START + 2000)).toMatchObject({
      gold: 999,
      totalCaught: 9,
      attempt: { id: "saved-fish" },
    });
    closeStore(migrated);
    const reopened = openStore(databasePath);
    expect(reopened.fishing.loadFishingSnapshot(alice.id, START + 3000).gold).toBe(999);
    inspect(databasePath, (db) => {
      expect(
        db
          .prepare("SELECT receipt_json FROM fishing_receipts WHERE user_id = ? AND request_id = ?")
          .get(alice.id, old.legacyRequest.requestId),
      ).toEqual({ receipt_json: old.oldReceipt });
      const row = db
        .prepare("SELECT state_json, total_sold_gold FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string; total_sold_gold: number };
      expect(JSON.parse(row.state_json)).toMatchObject({ gameplayVersion: 2, totalEarnedGold: 92 });
      expect(row.total_sold_gold).toBe(92);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ? AND reference_id = 'migration:direct-play-v2'",
          )
          .get(alice.id),
      ).toEqual({ count: 1 });
    });
  });

  it.each(["waiting", "escaped"] as const)(
    "removes retired identity hints from the %s preview without changing gold, physics or receipts",
    async (phase) => {
      const { store, databasePath, alice } = await setup();
      const before = execute(store, alice.id, { action: "begin", requestId: "prior-display" });
      const receipts = inspect(databasePath, (db) => {
        const row = db
          .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
          .get(alice.id) as { state_json: string };
        const saved = JSON.parse(row.state_json);
        Object.assign(saved.attempt, { fishLengthCm: 15, fishId: "crucian", rarity: "common" });
        if (phase === "escaped") {
          saved.attempt.phase = "escaped";
          saved.attempt.difficulty = 6;
          saved.attempt.fight = { elapsedMs: 7000, tension: 1, progress: 0.2, status: "escaped" };
        }
        db.prepare("UPDATE fishing_profiles SET state_json = ? WHERE user_id = ?").run(
          JSON.stringify(saved),
          alice.id,
        );
        return db
          .prepare(
            "SELECT request_id, payload_digest, receipt_json FROM fishing_receipts WHERE user_id = ? ORDER BY request_id",
          )
          .all(alice.id);
      });
      closeStore(store);
      const reopened = openStore(databasePath);
      const after = reopened.fishing.loadFishingSnapshot(alice.id, START);
      expect(after).toMatchObject({
        gold: before.gold,
        totalCaught: 0,
        totalEarnedGold: 0,
        revision: before.revision + 1,
        attempt: { phase },
      });
      for (const field of ["fishId", "fishLengthCm", "rarity"]) {
        expect(after.attempt).not.toHaveProperty(field);
      }
      if (phase === "escaped") {
        expect(after.attempt).toMatchObject({
          difficulty: 6,
          fight: { tension: 1, elapsedMs: 7000, escapeReason: null },
        });
      }
      expect(reopened.fishing.loadFishingSnapshot(alice.id, START).revision).toBe(after.revision);
      inspect(databasePath, (db) => {
        expect(
          db
            .prepare(
              "SELECT request_id, payload_digest, receipt_json FROM fishing_receipts WHERE user_id = ? ORDER BY request_id",
            )
            .all(alice.id),
        ).toEqual(receipts);
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ?")
            .get(alice.id),
        ).toEqual({ count: 0 });
      });
    },
  );

  it("honors an existing preview finish quote once while new casts use current prices", async () => {
    const { store, databasePath, alice } = await setup();
    const before = execute(store, alice.id, { action: "begin", requestId: "quoted-preview" });
    let privateSeed = -1;
    for (let seed = 0; seed < 10_000; seed++) {
      if (chooseFishingCatch(createFishingRandom(seed), "GOOD").fishId === "crucian") {
        privateSeed = seed;
        break;
      }
    }
    expect(privateSeed).toBeGreaterThanOrEqual(0);
    const chosen = chooseFishingCatch(createFishingRandom(privateSeed), "GOOD");
    const random = createFishingRandom(privateSeed);
    random();
    const originalReward = Math.round(12 * (0.85 + 0.3 * random()));
    inspect(databasePath, (db) => {
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string };
      const saved = JSON.parse(row.state_json);
      saved.rewardSeed = privateSeed;
      delete saved.rewardQuote;
      Object.assign(saved.attempt, {
        phase: "finishing",
        quality: "GOOD",
        seed: 1200,
        fishId: chosen.fishId,
        fishLengthCm: chosen.lengthCm,
        difficulty: resolveFishingDifficulty(chosen.fishId, chosen.lengthCm),
        finishStartedAt: START,
        finishDeadlineAt: START + FISHING_FINISH_WINDOW_MS,
      });
      db.prepare("UPDATE fishing_profiles SET state_json = ? WHERE user_id = ?").run(
        JSON.stringify(saved),
        alice.id,
      );
    });
    closeStore(store);
    const reopened = openStore(databasePath);
    const request: FishingRequest = {
      action: "finish",
      requestId: "honor-preview",
      attemptId: before.attempt!.id,
    };
    const caught = execute(reopened, alice.id, request, START);
    expect(caught).toMatchObject({
      gold: originalReward,
      totalEarnedGold: originalReward,
      totalCaught: 1,
      attempt: { result: { rewardGold: originalReward, bonusMultiplier: 1 } },
    });
    expect(execute(reopened, alice.id, request, START + 1).gold).toBe(originalReward);
    execute(reopened, alice.id, { action: "begin", requestId: "current-quote" }, START + 2);
    inspect(databasePath, (db) => {
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string };
      const saved = JSON.parse(row.state_json);
      expect(saved.rewardQuote).toEqual({
        GOOD: chooseFishingCatch(createFishingRandom(saved.rewardSeed), "GOOD").rewardGold,
        PERFECT: chooseFishingCatch(createFishingRandom(saved.rewardSeed), "PERFECT").rewardGold,
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ?")
          .get(alice.id),
      ).toEqual({ count: 1 });
    });
  });

  it("rolls an interrupted cutover back before a safe one-time retry", async () => {
    const { store, databasePath, alice } = await setup();
    store.fishing.loadFishingSnapshot(alice.id, START);
    const old = seedPreview(databasePath, alice.id);
    closeStore(store);
    inspect(databasePath, (db) =>
      db.exec(`CREATE TRIGGER fishing_migration_failure BEFORE UPDATE ON fishing_profiles
      WHEN json_extract(NEW.state_json, '$.gameplayVersion') = 2
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;`),
    );
    const failed = openStore(databasePath);
    expect(() => failed.fishing.loadFishingSnapshot(alice.id, START + 1000)).toThrow(
      /injected migration failure/,
    );
    closeStore(failed);
    inspect(databasePath, (db) => {
      expect(
        db.prepare("SELECT gold FROM baseball_game_progress WHERE user_id = ?").get(alice.id),
      ).toEqual({ gold: 987 });
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(alice.id) as { state_json: string };
      expect(JSON.parse(row.state_json)).toEqual(old.prior);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM fishing_receipts WHERE request_id = 'migration:direct-play-v2'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ?")
          .get(alice.id),
      ).toEqual({ count: 0 });
      db.exec("DROP TRIGGER fishing_migration_failure");
    });
    expect(openStore(databasePath).fishing.loadFishingSnapshot(alice.id, START + 2000).gold).toBe(
      999,
    );
  });

  it("settles elapsed preview auto slots once and stops future automatic rewards", async () => {
    const { store, databasePath, alice } = await setup();
    store.fishing.loadFishingSnapshot(alice.id, START);
    seedPreview(databasePath, alice.id, true);
    closeStore(store);
    let expectedGold = 999;
    let expectedCaught = 9;
    const expectedFish: ReturnType<typeof chooseFishingCatch>[] = [];
    const previewPondPrices: Record<string, number> = {
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
    };
    for (let index = 0; index < 2; index++) {
      const random = createFishingRandom((12345 + Math.imul(index + 1, 0x9e3779b9)) >>> 0);
      if (random() < 0.7) {
        let first = true;
        let size = 0;
        const previewRandom = () => {
          const sample = random();
          if (!first) {
            size = sample;
          }
          const value = first ? sample / 4 : sample;
          first = false;
          return value;
        };
        const fish = chooseFishingCatch(previewRandom, "GOOD");
        expectedFish.push(fish);
        expectedGold += Math.round(previewPondPrices[fish.fishId]! * (0.85 + 0.3 * size));
        expectedCaught++;
      }
    }
    const migrated = openStore(databasePath);
    expect(migrated.fishing.loadFishingSnapshot(alice.id, START + 120_000)).toMatchObject({
      gold: expectedGold,
      totalCaught: expectedCaught,
    });
    const preserved = readProfile(databasePath, alice.id);
    expect(preserved.speciesRecordsComplete).toBe(true);
    expect(
      Object.values(preserved.speciesRecords).reduce((sum, record) => sum + record.count, 0),
    ).toBe(expectedCaught);
    expect(preserved.speciesRecords.crucian!.bestLengthCm).toBeGreaterThanOrEqual(60);
    expect(preserved.speciesRecords.crucian!.bestWeightKg).toBeGreaterThanOrEqual(2);
    for (const fish of expectedFish) {
      const record = preserved.speciesRecords[fish.fishId]!;
      expect(record.bestLengthCm).toBeGreaterThanOrEqual(fish.lengthCm);
      expect(record.bestWeightKg).toBeGreaterThanOrEqual(fish.weightKg);
    }
    expect(migrated.fishing.loadFishingSnapshot(alice.id, START + 86_400_000)).toMatchObject({
      gold: expectedGold,
      totalCaught: expectedCaught,
    });
    closeStore(migrated);
    expect(
      openStore(databasePath).fishing.loadFishingSnapshot(alice.id, START + 172_800_000).gold,
    ).toBe(expectedGold);
    expect(readProfile(databasePath, alice.id).speciesRecords).toEqual(preserved.speciesRecords);
  });

  it("resets UTC goal periods, ranks paid catches and rejects disabled users", async () => {
    const { store, alice, bob } = await setup();
    const caught = catchFish(store, alice.id, Date.parse("2026-11-01T23:59:50Z"));
    expect(caught.goals).toEqual({ dailyCaught: 1, weeklyCaught: 1 });
    expect(store.fishing.loadFishingLeaderboard(alice.id)).toEqual({
      catches: [{ displayName: "alice", value: 1, isCurrentUser: true }],
      earnedGold: [{ displayName: "alice", value: caught.gold, isCurrentUser: true }],
    });
    const nextWeek = Date.parse("2026-11-09T00:00:00Z");
    expect(store.fishing.loadFishingSnapshot(alice.id, nextWeek).goals).toEqual({
      dailyCaught: 0,
      weeklyCaught: 0,
    });
    await store.setManagedUserStatus({
      actorUserId: alice.id,
      targetUserId: bob.id,
      status: "disabled",
      changedAt: nextWeek,
    });
    expect(() => store.fishing.loadFishingSnapshot(bob.id, nextWeek)).toThrow(/로그인/);
  });
});
