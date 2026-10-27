import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { FishingRequest } from "./fishing-contracts.js";
import { FISHING_FINISH_WINDOW_MS, replayFishingFight } from "./fishing-simulation.js";
import type { SqliteFishingState } from "./sqlite-fishing-state.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

export const START = Date.parse("2026-10-26T10:00:00Z");

/** Each test file owns its stores and registers cleanup explicitly, including cached modules. */
export function createFishingFixtures() {
  const directories: string[] = [];
  const stores = new Set<SqliteControlPlaneStore>();
  function openStore(databasePath: string) {
    const store = new SqliteControlPlaneStore({
      databasePath,
      initialAdminAccountIds: ["alice"],
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    });
    stores.add(store);
    return store;
  }
  function closeStore(store: SqliteControlPlaneStore) {
    stores.delete(store);
    store.close();
  }
  async function setup() {
    const directory = mkdtempSync(join(tmpdir(), "platformclaw-fishing-"));
    directories.push(directory);
    const databasePath = join(directory, "control.sqlite");
    const store = openStore(databasePath);
    const createUser = async (name: string) =>
      (
        await store.upsertPrincipal(
          {
            provider: "ldap",
            subject: name,
            accountId: name,
            employeeId: name,
            displayName: name,
          },
          START,
        )
      ).user;
    return { store, databasePath, alice: await createUser("alice"), bob: await createUser("bob") };
  }
  function inspect<T>(path: string, operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path);
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
  function execute(
    store: SqliteControlPlaneStore,
    userId: string,
    request: FishingRequest,
    now = START,
  ) {
    return store.fishing.executeFishing(userId, request, now);
  }
  function stageCatch(store: SqliteControlPlaneStore, userId: string, now = START) {
    let state = execute(store, userId, { action: "begin", requestId: `begin-${now}` }, now);
    const attempt = state.attempt!;
    state = execute(
      store,
      userId,
      { action: "hook", requestId: `hook-${now}`, attemptId: attempt.id },
      attempt.biteAt,
    );
    let held = false;
    for (let atMs = 0; atMs <= 7000; atMs += 100) {
      const current = state.attempt!;
      const fight = replayFishingFight(
        current.seed,
        current.difficulty!,
        current.inputs,
        atMs,
        current.behavior!,
      );
      if (fight.status === "caught") {
        const landedAt = Math.ceil(attempt.biteAt + fight.elapsedMs);
        const phase = ((attempt.seed >>> 0) % 1200) / 1200;
        const centerAt = Math.round(((0.5 - phase + 2) % 2) * 1200);
        return {
          attemptId: attempt.id,
          landedAt,
          finishAt: landedAt + centerAt,
          deadlineAt: landedAt + FISHING_FINISH_WINDOW_MS,
        };
      }
      expect(fight.status).toBe("fighting");
      const nextHeld: boolean = held ? fight.tension < 0.7 : fight.tension < 0.36;
      if (nextHeld !== held) {
        held = nextHeld;
        state = execute(
          store,
          userId,
          { action: "reel", requestId: `reel-${now}-${atMs}`, attemptId: attempt.id, held },
          attempt.biteAt + atMs,
        );
      }
    }
    throw new Error("Skilled input did not land its fish");
  }
  function catchFish(store: SqliteControlPlaneStore, userId: string, now = START) {
    const staged = stageCatch(store, userId, now);
    const result = execute(
      store,
      userId,
      { action: "finish", requestId: `finish-${now}`, attemptId: staged.attemptId },
      staged.finishAt,
    );
    expect(result.attempt?.phase).toBe("caught");
    return result;
  }
  function seedPreview(databasePath: string, userId: string, auto = false) {
    const priorFish = {
      id: "saved-fish",
      fishId: "crucian",
      lengthCm: 15,
      weightKg: 0.1,
      salePrice: 12,
      quality: "GOOD",
      caughtAt: START - 1000,
    };
    const legacyRequest = { action: "begin", requestId: "legacy-completed", region: "pond" };
    const prior = {
      economyVersion: 1,
      revision: 7,
      rodLevel: 5,
      unlockedRegions: ["pond", "river"],
      inventory: [priorFish],
      catalog: [{ fishId: "crucian", count: 9, bestLengthCm: 60, bestWeightKg: 2 }],
      totalCaught: 9,
      totalSoldGold: 80,
      attempt: {
        id: "saved-fish",
        region: "pond",
        issuedAt: START - 30_000,
        biteAt: START - 15_000,
        hookDeadlineAt: START - 14_350,
        seed: 7,
        rodLevel: 5,
        phase: "caught",
        quality: "GOOD",
        rarity: "common",
        behavior: "steady",
        hookedAt: START - 15_000,
        inputs: [],
        fight: { elapsedMs: 5000, tension: 0.5, progress: 1, status: "caught" },
        result: priorFish,
      },
      auto: auto ? { region: "pond", startedAt: START, expiresAt: START + 30 * 60_000 } : null,
      autoSeed: 12345,
      autoProcessed: 0,
      rewardSeed: 7,
      lastBeginAt: START - 30_000,
      lastNowAt: START,
      goalDay: Math.floor(START / 86_400_000),
      goalWeek: Math.floor((Math.floor(START / 86_400_000) + 3) / 7),
      dailyCaught: 2,
      weeklyCaught: 5,
    };
    const oldReceipt = JSON.stringify({
      action: "begin",
      revision: 7,
      attemptId: "saved-fish",
      goldDelta: 0,
      acceptedAt: START - 30_000,
    });
    inspect(databasePath, (db) => {
      db.prepare("UPDATE baseball_game_progress SET gold = 987 WHERE user_id = ?").run(userId);
      db.prepare(
        "UPDATE fishing_profiles SET state_json = ?, total_caught = 9, total_sold_gold = 80 WHERE user_id = ?",
      ).run(JSON.stringify(prior), userId);
      const digest = createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(legacyRequest).toSorted(([a], [b]) => a.localeCompare(b)),
            ),
          ),
        )
        .digest("hex");
      db.prepare(
        "INSERT INTO fishing_receipts (user_id,request_id,payload_digest,receipt_json) VALUES (?,?,?,?)",
      ).run(userId, legacyRequest.requestId, digest, oldReceipt);
    });
    return { prior, oldReceipt, legacyRequest: legacyRequest as FishingRequest };
  }
  function readProfile(path: string, userId: string): SqliteFishingState {
    return inspect(path, (db) => {
      const row = db
        .prepare("SELECT state_json FROM fishing_profiles WHERE user_id = ?")
        .get(userId) as { state_json: string };
      return JSON.parse(row.state_json) as SqliteFishingState;
    });
  }
  function writeProfile(
    path: string,
    userId: string,
    state: { totalCaught: number } & ({ totalEarnedGold: number } | { totalSoldGold: number }),
  ): void {
    const earned = "totalEarnedGold" in state ? state.totalEarnedGold : state.totalSoldGold;
    inspect(path, (db) =>
      db
        .prepare(
          "UPDATE fishing_profiles SET state_json = ?, total_caught = ?, total_sold_gold = ? WHERE user_id = ?",
        )
        .run(JSON.stringify(state), state.totalCaught, earned, userId),
    );
  }
  function cleanup() {
    for (const store of stores) {
      store.close();
    }
    stores.clear();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return {
    setup,
    openStore,
    closeStore,
    inspect,
    execute,
    stageCatch,
    catchFish,
    seedPreview,
    readProfile,
    writeProfile,
    cleanup,
  };
}
