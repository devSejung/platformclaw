import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { BaseballProgress } from "./baseball-contracts.js";
import type { ControlPlaneIdFactory, EnterprisePrincipal } from "./contracts.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "platformclaw-baseball-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "control.sqlite");
}

function createIdFactory(): ControlPlaneIdFactory {
  let user = 0;
  let binding = 0;
  let session = 0;
  let scope = 0;
  let audit = 0;
  return {
    nextUserId: () => `user-${++user}`,
    nextBindingId: () => `binding-${++binding}`,
    nextSessionId: () => `session-${++session}`,
    nextManagedScopeId: () => `scope-${++scope}`,
    nextAuditEventId: () => `audit-${++audit}`,
  };
}

function createStore(databasePath: string) {
  return new SqliteControlPlaneStore({
    databasePath,
    buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
    initialAdminAccountIds: ["admin.user"],
    idFactory: createIdFactory(),
  });
}

function principal(accountId = "admin.user"): EnterprisePrincipal {
  return {
    provider: "ldap",
    subject: accountId,
    accountId,
    employeeId: `employee-${accountId}`,
    displayName: accountId,
  };
}

async function seedUser(store: SqliteControlPlaneStore) {
  return (await store.upsertPrincipal(principal(), 1_000)).user;
}

function setGold(databasePath: string, userId: string, gold: number): void {
  const db = new DatabaseSync(databasePath);
  db.prepare("UPDATE baseball_game_progress SET gold = ? WHERE user_id = ?").run(gold, userId);
  db.close();
}

function seedLegacyReceipt(
  databasePath: string,
  userId: string,
  requestId: string,
  envelope: unknown,
  operation: "purchase_bat" | "equip_bat" = "purchase_bat",
): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    "INSERT INTO baseball_idempotency (user_id,request_id,operation,payload_digest,result_json) VALUES (?,?,?,?,?)",
  ).run(
    userId,
    requestId,
    operation,
    createHash("sha256")
      .update(JSON.stringify({ batId: "silver" }), "utf8")
      .digest("hex"),
    JSON.stringify(envelope),
  );
  db.close();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteControlPlaneStore baseball state", () => {
  it("persists progress across reopen and rewards five gold per hit and eight per home run", async () => {
    const databasePath = createDatabasePath();
    const first = createStore(databasePath);
    const user = await seedUser(first);

    await expect(first.loadBaseballProgress(user.id)).resolves.toEqual({
      gold: 0,
      ownedBatIds: ["wood"],
      equippedBatId: "wood",
      totalHomers: 0,
      bestDistanceM: 0,
      currentHomeRunStreak: 0,
      bestHomeRunStreak: 0,
      revision: 0,
      enhancement: { level: 0, status: "ready", equipped: true, version: 1 },
    });
    const homeRun = await first.rewardBaseballPlateAppearance({
      userId: user.id,
      requestId: "plate-1",
      outcome: "home_run",
      distanceM: 132,
    });
    expect(homeRun).toMatchObject({
      awardedGold: 8,
      homeRunBonusGold: 0,
      homeRunStreakBonusGold: 0,
      progress: {
        gold: 8,
        totalHomers: 1,
        bestDistanceM: 132,
        currentHomeRunStreak: 1,
        bestHomeRunStreak: 1,
        revision: 1,
      },
    });
    await expect(
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "plate-2",
        outcome: "hit",
        distanceM: 140,
      }),
    ).resolves.toMatchObject({
      awardedGold: 5,
      progress: {
        gold: 13,
        totalHomers: 1,
        bestDistanceM: 140,
        currentHomeRunStreak: 0,
        bestHomeRunStreak: 1,
        revision: 2,
      },
    });
    await expect(
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "plate-3",
        outcome: "out",
        distanceM: 999,
      }),
    ).resolves.toMatchObject({
      awardedGold: 0,
      progress: { gold: 13, totalHomers: 1, bestDistanceM: 140, revision: 2 },
    });
    await expect(
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "plate-3",
        outcome: "out",
      }),
    ).resolves.toMatchObject({
      awardedGold: 0,
      progress: { gold: 13, totalHomers: 1, bestDistanceM: 140, revision: 2 },
    });
    first.close();

    const reopened = createStore(databasePath);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 13,
      ownedBatIds: ["wood"],
      equippedBatId: "wood",
      totalHomers: 1,
      bestDistanceM: 140,
      currentHomeRunStreak: 0,
      bestHomeRunStreak: 1,
      revision: 2,
    });
    reopened.close();
  });

  it("awards the cumulative bonus after nonconsecutive home runs and keeps it across reconnects", async () => {
    const databasePath = createDatabasePath();
    const first = createStore(databasePath);
    const user = await seedUser(first);

    for (let homer = 1; homer < 5; homer += 1) {
      await expect(
        first.rewardBaseballPlateAppearance({
          userId: user.id,
          requestId: `homer-${homer}`,
          outcome: "home_run",
          distanceM: 120 + homer,
        }),
      ).resolves.toMatchObject({
        awardedGold: 8,
        homeRunBonusGold: 0,
        homeRunStreakBonusGold: 0,
        progress: { gold: homer * 8, totalHomers: homer, revision: homer * 2 - 1 },
      });
      await expect(
        first.rewardBaseballPlateAppearance({
          userId: user.id,
          requestId: `miss-${homer}`,
          outcome: "miss",
        }),
      ).resolves.toMatchObject({
        awardedGold: 0,
        progress: { gold: homer * 8, currentHomeRunStreak: 0, revision: homer * 2 },
      });
    }
    const milestoneRequest = {
      userId: user.id,
      requestId: "homer-5",
      outcome: "home_run" as const,
      distanceM: 125,
    };
    const milestone = await first.rewardBaseballPlateAppearance(milestoneRequest);
    expect(milestone).toMatchObject({
      awardedGold: 18,
      homeRunBonusGold: 10,
      homeRunStreakBonusGold: 0,
      progress: {
        gold: 50,
        totalHomers: 5,
        currentHomeRunStreak: 1,
        bestHomeRunStreak: 1,
        revision: 9,
      },
    });
    expect(await first.rewardBaseballPlateAppearance(milestoneRequest)).toEqual(milestone);
    first.close();

    const reopened = createStore(databasePath);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 50,
      totalHomers: 5,
      revision: 9,
    });
    await expect(
      reopened.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "hit-after-reconnect",
        outcome: "hit",
        distanceM: 90,
      }),
    ).resolves.toMatchObject({
      awardedGold: 5,
      progress: { gold: 55, totalHomers: 5, revision: 10 },
    });
    reopened.close();
  });

  it("awards both periodic bonuses through fifteen consecutive home runs and replays the overlap once", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    const expectedAwards = [8, 8, 18, 8, 18, 18, 8, 8, 18, 18, 8, 18, 8, 8, 28];
    let balance = 0;
    for (let homer = 1; homer <= 15; homer++) {
      const request = {
        userId: user.id,
        requestId: `periodic-${homer}`,
        outcome: "home_run" as const,
        distanceM: 130,
      };
      const result = await store.rewardBaseballPlateAppearance(request);
      balance += expectedAwards[homer - 1]!;
      expect(result).toMatchObject({
        awardedGold: expectedAwards[homer - 1],
        homeRunBonusGold: homer % 5 === 0 ? 10 : 0,
        homeRunStreakBonusGold: homer % 3 === 0 ? 10 : 0,
        progress: {
          gold: balance,
          totalHomers: homer,
          currentHomeRunStreak: homer,
          bestHomeRunStreak: homer,
          revision: homer,
        },
      });
      expect(await store.rewardBaseballPlateAppearance(request)).toEqual(result);
    }
    expect(balance).toBe(200);
    store.close();
    const reopened = createStore(databasePath);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 200,
      totalHomers: 15,
      currentHomeRunStreak: 15,
    });
    const db = new DatabaseSync(databasePath);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count, SUM(delta) AS total FROM game_gold_transactions WHERE user_id = ? AND reason = 'baseball_reward'",
        )
        .get(user.id),
    ).toEqual({ count: 15, total: 200 });
    db.close();
    reopened.close();
  });

  it.each(["hit", "miss", "out"] as const)(
    "resets the current home-run bonus with a %s while retaining cumulative milestones",
    async (outcome) => {
      const store = createStore(createDatabasePath());
      const user = await seedUser(store);
      for (let homer = 1; homer <= 2; homer++) {
        await store.rewardBaseballPlateAppearance({
          userId: user.id,
          requestId: `before-${homer}`,
          outcome: "home_run",
        });
      }
      const reset = await store.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "reset-streak",
        outcome,
      });
      expect(reset).toMatchObject({
        awardedGold: outcome === "hit" ? 5 : 0,
        homeRunBonusGold: 0,
        homeRunStreakBonusGold: 0,
        progress: { totalHomers: 2, currentHomeRunStreak: 0, bestHomeRunStreak: 2 },
      });
      for (let homer = 1; homer <= 3; homer++) {
        const result = await store.rewardBaseballPlateAppearance({
          userId: user.id,
          requestId: `after-${homer}`,
          outcome: "home_run",
        });
        expect(result).toMatchObject({
          awardedGold: homer === 3 ? 28 : 8,
          homeRunBonusGold: homer === 3 ? 10 : 0,
          homeRunStreakBonusGold: homer === 3 ? 10 : 0,
          progress: { currentHomeRunStreak: homer, totalHomers: homer + 2 },
        });
      }
      store.close();
    },
  );

  it("rolls overlapping bonuses, pitch consumption and the ledger back when the receipt fails", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    for (let homer = 1; homer <= 14; homer++) {
      await store.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: `rollback-seed-${homer}`,
        outcome: "home_run",
      });
    }
    const before = await store.loadBaseballProgress(user.id);
    const atBat = await store.beginBaseballAtBat({
      userId: user.id,
      requestId: "overlap-pitch",
      now: 1000,
    });
    const request = {
      userId: user.id,
      requestId: "faulted-overlap",
      atBatId: atBat.id,
      timingDeltaMs: 0,
      now: 2000,
    };
    const db = new DatabaseSync(databasePath);
    db.exec(
      "CREATE TRIGGER fail_overlap_receipt BEFORE INSERT ON baseball_idempotency WHEN NEW.request_id = 'faulted-overlap' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END",
    );
    await expect(store.rewardBaseballPlateAppearance(request)).rejects.toThrow(
      /injected receipt failure/,
    );
    expect(await store.loadBaseballProgress(user.id)).toEqual(before);
    expect(
      db.prepare("SELECT consumed_at FROM baseball_at_bats WHERE id = ?").get(atBat.id),
    ).toEqual({ consumed_at: null });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ?")
        .get(user.id),
    ).toEqual({ count: 14 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM baseball_idempotency WHERE request_id = 'faulted-overlap'",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.exec("DROP TRIGGER fail_overlap_receipt");
    db.close();
    store.close();
    const reopened = createStore(databasePath);
    const result = await reopened.rewardBaseballPlateAppearance(request);
    expect(result).toMatchObject({
      awardedGold: 28,
      homeRunBonusGold: 10,
      homeRunStreakBonusGold: 10,
      progress: { gold: before.gold + 28, totalHomers: 15, currentHomeRunStreak: 15 },
    });
    expect(await reopened.rewardBaseballPlateAppearance(request)).toEqual(result);
    reopened.close();
  });

  it("preserves saved balances, bat IDs, records, and old reward receipts after an upgrade", async () => {
    const databasePath = createDatabasePath();
    const seed = createStore(databasePath);
    const user = await seedUser(seed);
    await seed.loadBaseballProgress(user.id);
    seed.close();
    const priorProgress: BaseballProgress = {
      gold: 1_234,
      ownedBatIds: ["wood", "titanium", "diamond"],
      equippedBatId: "diamond",
      totalHomers: 9,
      bestDistanceM: 147,
      currentHomeRunStreak: 0,
      bestHomeRunStreak: 4,
      revision: 42,
    };
    const request = {
      userId: user.id,
      requestId: "old-hit",
      outcome: "hit" as const,
      distanceM: 90,
    };
    const priorResult = { awardedGold: 1, progress: priorProgress };
    const db = new DatabaseSync(databasePath);
    db.prepare("INSERT INTO baseball_owned_bats (user_id, bat_id) VALUES (?, ?), (?, ?)").run(
      user.id,
      "titanium",
      user.id,
      "diamond",
    );
    db.prepare(
      "UPDATE baseball_game_progress SET gold = ?, equipped_bat_id = ?, total_homers = ?, best_distance_m = ?, revision = ? WHERE user_id = ?",
    ).run(1_234, "diamond", 9, 147, 42, user.id);
    db.prepare(
      "UPDATE baseball_home_run_streaks SET current_streak = 0, best_streak = 4 WHERE user_id = ?",
    ).run(user.id);
    db.prepare(
      "INSERT INTO baseball_idempotency (user_id, request_id, operation, payload_digest, result_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      user.id,
      request.requestId,
      "plate_appearance",
      createHash("sha256")
        .update(JSON.stringify({ outcome: "hit", distanceM: 90 }), "utf8")
        .digest("hex"),
      JSON.stringify({ ok: true, result: priorResult }),
    );
    db.close();
    const upgraded = createStore(databasePath);
    const expectedProgress = {
      ...priorProgress,
      enhancement: { level: 0, status: "ready", equipped: true, version: 1 },
    };
    await expect(upgraded.loadBaseballProgress(user.id)).resolves.toEqual(expectedProgress);
    await expect(upgraded.loadBaseballLeaderboard(user.id)).resolves.toEqual({
      distance: [{ displayName: "admin.user", value: 147, isCurrentUser: true }],
      homeRunStreak: [{ displayName: "admin.user", value: 4, isCurrentUser: true }],
    });
    await expect(upgraded.rewardBaseballPlateAppearance(request)).resolves.toEqual(priorResult);
    const reward = await upgraded.rewardBaseballPlateAppearance({
      userId: user.id,
      requestId: "new-tenth-homer",
      outcome: "home_run",
      distanceM: 130,
    });
    expect(reward).toEqual({
      awardedGold: 18,
      homeRunBonusGold: 10,
      homeRunStreakBonusGold: 0,
      progress: {
        ...expectedProgress,
        gold: 1_252,
        totalHomers: 10,
        currentHomeRunStreak: 1,
        revision: 43,
      },
    });
    await expect(upgraded.rewardBaseballPlateAppearance(request)).resolves.toEqual(priorResult);
    upgraded.close();
    const reopened = createStore(databasePath);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toEqual(reward.progress);
    await expect(reopened.rewardBaseballPlateAppearance(request)).resolves.toEqual(priorResult);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toEqual(reward.progress);
    reopened.close();
  });

  it("replays an immutable historical five-gold bonus without repricing its balance", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    const initial = await store.loadBaseballProgress(user.id);
    const priorProgress = {
      ...initial,
      gold: 30,
      totalHomers: 5,
      currentHomeRunStreak: 5,
      bestHomeRunStreak: 5,
      revision: 5,
    };
    const priorResult = { awardedGold: 10, homeRunBonusGold: 5, progress: priorProgress };
    const request = {
      userId: user.id,
      requestId: "historical-fifth",
      outcome: "home_run" as const,
      distanceM: 125,
    };
    const receipt = JSON.stringify({ ok: true, result: priorResult });
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE baseball_game_progress SET gold = 30, total_homers = 5, revision = 5 WHERE user_id = ?",
    ).run(user.id);
    db.prepare(
      "UPDATE baseball_home_run_streaks SET current_streak = 5, best_streak = 5 WHERE user_id = ?",
    ).run(user.id);
    db.prepare(
      "INSERT INTO baseball_idempotency (user_id, request_id, operation, payload_digest, result_json) VALUES (?, ?, 'plate_appearance', ?, ?)",
    ).run(
      user.id,
      request.requestId,
      createHash("sha256")
        .update(JSON.stringify({ outcome: "home_run", distanceM: 125 }), "utf8")
        .digest("hex"),
      receipt,
    );
    store.close();
    const reopened = createStore(databasePath);
    expect(await reopened.rewardBaseballPlateAppearance(request)).toEqual(priorResult);
    expect(await reopened.loadBaseballProgress(user.id)).toEqual(priorProgress);
    const current = await reopened.rewardBaseballPlateAppearance({
      userId: user.id,
      requestId: "new-sixth",
      outcome: "home_run",
    });
    expect(current).toMatchObject({
      awardedGold: 18,
      homeRunBonusGold: 0,
      homeRunStreakBonusGold: 10,
      progress: { gold: 48, totalHomers: 6, currentHomeRunStreak: 6 },
    });
    expect(await reopened.rewardBaseballPlateAppearance(request)).toEqual(priorResult);
    expect(
      db
        .prepare(
          "SELECT result_json FROM baseball_idempotency WHERE user_id = ? AND request_id = ?",
        )
        .get(user.id, request.requestId),
    ).toEqual({ result_json: receipt });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM game_gold_transactions WHERE user_id = ?")
        .get(user.id),
    ).toEqual({ count: 1 });
    db.close();
    reopened.close();
  });

  it("replays matching request IDs and rejects request-ID reuse with another payload or operation", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    const request = {
      userId: user.id,
      requestId: "same-request",
      outcome: "home_run" as const,
      distanceM: 125,
    };

    const first = await store.rewardBaseballPlateAppearance(request);
    const retry = await store.rewardBaseballPlateAppearance(request);
    expect(retry).toEqual(first);
    await expect(
      store.rewardBaseballPlateAppearance({ ...request, distanceM: 126 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      store.purchaseBaseballBat({
        userId: user.id,
        requestId: request.requestId,
        batId: "silver",
      }),
    ).rejects.toMatchObject({ code: "legacy_purchase_closed" });
    await expect(store.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 8,
      totalHomers: 1,
      bestDistanceM: 125,
      currentHomeRunStreak: 1,
      bestHomeRunStreak: 1,
      revision: 1,
    });
    store.close();
  });

  it("isolates progress and request IDs by authenticated platform user", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const userA = await seedUser(store);
    const userB = (await store.upsertPrincipal(principal("member.user"), 1_001)).user;

    await store.rewardBaseballPlateAppearance({
      userId: userA.id,
      requestId: "shared-request-id",
      outcome: "home_run",
      distanceM: 125,
    });
    await store.rewardBaseballPlateAppearance({
      userId: userB.id,
      requestId: "shared-request-id",
      outcome: "hit",
      distanceM: 90,
    });

    await expect(store.loadBaseballProgress(userA.id)).resolves.toMatchObject({
      gold: 8,
      totalHomers: 1,
      bestDistanceM: 125,
    });
    await expect(store.loadBaseballProgress(userB.id)).resolves.toMatchObject({
      gold: 5,
      totalHomers: 0,
      bestDistanceM: 90,
    });
    store.close();
  });

  it("ranks best distance and consecutive home runs across active users", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const userA = await seedUser(store);
    const userB = (await store.upsertPrincipal(principal("member.b"), 1_001)).user;
    const userC = (await store.upsertPrincipal(principal("member.c"), 1_002)).user;
    const userD = (await store.upsertPrincipal(principal("member.disabled"), 1_003)).user;

    await store.rewardBaseballPlateAppearance({
      userId: userA.id,
      requestId: "a-1",
      outcome: "home_run",
      distanceM: 130,
    });
    await store.rewardBaseballPlateAppearance({
      userId: userA.id,
      requestId: "a-2",
      outcome: "home_run",
      distanceM: 135,
    });
    await store.rewardBaseballPlateAppearance({
      userId: userB.id,
      requestId: "b-1",
      outcome: "hit",
      distanceM: 150,
    });
    await store.rewardBaseballPlateAppearance({
      userId: userC.id,
      requestId: "c-1",
      outcome: "home_run",
      distanceM: 140,
    });
    await store.rewardBaseballPlateAppearance({
      userId: userC.id,
      requestId: "c-2",
      outcome: "out",
    });
    await store.rewardBaseballPlateAppearance({
      userId: userD.id,
      requestId: "d-1",
      outcome: "home_run",
      distanceM: 999,
    });
    await store.setManagedUserStatus({
      actorUserId: userA.id,
      targetUserId: userD.id,
      status: "disabled",
      changedAt: 1_004,
    });

    await expect(store.loadBaseballProgress(userA.id)).resolves.toMatchObject({
      currentHomeRunStreak: 2,
      bestHomeRunStreak: 2,
    });
    await expect(store.loadBaseballProgress(userC.id)).resolves.toMatchObject({
      currentHomeRunStreak: 0,
      bestHomeRunStreak: 1,
    });
    await expect(store.loadBaseballLeaderboard(userA.id)).resolves.toEqual({
      distance: [
        { displayName: "member.b", value: 150, isCurrentUser: false },
        { displayName: "member.c", value: 140, isCurrentUser: false },
        { displayName: "admin.user", value: 135, isCurrentUser: true },
      ],
      homeRunStreak: [
        { displayName: "admin.user", value: 2, isCurrentUser: true },
        { displayName: "member.c", value: 1, isCurrentUser: false },
      ],
    });
    store.close();
  });

  it("serializes rewards across separate SQLite store connections", async () => {
    const databasePath = createDatabasePath();
    const seed = createStore(databasePath);
    const user = await seedUser(seed);
    await seed.loadBaseballProgress(user.id);
    seed.close();

    const first = createStore(databasePath);
    const second = createStore(databasePath);
    await Promise.all([
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "reward-a",
        outcome: "home_run",
        distanceM: 121,
      }),
      second.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "reward-b",
        outcome: "home_run",
        distanceM: 122,
      }),
    ]);
    const duplicateResults = await Promise.all([
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "duplicate-reward",
        outcome: "home_run",
        distanceM: 123,
      }),
      second.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "duplicate-reward",
        outcome: "home_run",
        distanceM: 123,
      }),
    ]);
    expect(duplicateResults[0]).toEqual(duplicateResults[1]);
    await expect(first.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 34,
      totalHomers: 3,
      bestDistanceM: 123,
      currentHomeRunStreak: 3,
      bestHomeRunStreak: 3,
      revision: 3,
    });

    first.close();
    second.close();
  });

  it("serializes and deduplicates the fifth-home-run bonus across separate SQLite connections", async () => {
    const databasePath = createDatabasePath();
    const seed = createStore(databasePath);
    const user = await seedUser(seed);
    for (let homer = 1; homer <= 4; homer += 1) {
      await seed.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: `seed-homer-${homer}`,
        outcome: "home_run",
        distanceM: 120 + homer,
      });
    }
    seed.close();

    const first = createStore(databasePath);
    const second = createStore(databasePath);
    const rewards = await Promise.all([
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "concurrent-homer-a",
        outcome: "home_run",
        distanceM: 130,
      }),
      second.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "concurrent-homer-a",
        outcome: "home_run",
        distanceM: 130,
      }),
      second.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "concurrent-homer-b",
        outcome: "home_run",
        distanceM: 131,
      }),
    ]);

    expect(rewards[0]).toEqual(rewards[1]);
    expect(rewards[0]).toMatchObject({ homeRunBonusGold: 10, homeRunStreakBonusGold: 0 });
    expect(rewards[2]).toMatchObject({ homeRunBonusGold: 0, homeRunStreakBonusGold: 10 });
    expect(rewards.map((reward) => reward.awardedGold).toSorted((a, b) => a - b)).toEqual([
      18, 18, 18,
    ]);
    await expect(first.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 78,
      totalHomers: 6,
      revision: 6,
    });
    first.close();
    second.close();
  });

  it("rejects new browser fixed-price purchases across connections without gold or inventory changes", async () => {
    const databasePath = createDatabasePath();
    const seed = createStore(databasePath);
    const user = await seedUser(seed);
    await seed.loadBaseballProgress(user.id);
    seed.close();
    setGold(databasePath, user.id, 50_000);

    const first = createStore(databasePath);
    const second = createStore(databasePath);
    const results = await Promise.allSettled([
      first.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-tab-a",
        batId: "platinum",
      }),
      second.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-tab-b",
        batId: "diamond",
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "legacy_purchase_closed" }),
      }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "legacy_purchase_closed" }),
      }),
    ]);
    await expect(
      first.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-tab-a",
        batId: "platinum",
      }),
    ).rejects.toMatchObject({ code: "legacy_purchase_closed" });
    await expect(first.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 50_000,
      ownedBatIds: ["wood"],
      revision: 0,
    });
    const db = new DatabaseSync(databasePath);
    expect(db.prepare("SELECT COUNT(*) AS count FROM game_gold_transactions").get()).toEqual({
      count: 0,
    });
    db.close();
    first.close();
    second.close();
  });

  it("rejects retired purchases and equipment before replay while preserving historical refund evidence", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    const initial = await store.loadBaseballProgress(user.id);
    const db = new DatabaseSync(databasePath);
    db.prepare("INSERT INTO baseball_owned_bats (user_id,bat_id) VALUES (?,?)").run(
      user.id,
      "silver",
    );
    db.prepare(
      "UPDATE baseball_game_progress SET gold = 1750, equipped_bat_id = 'silver', revision = 42 WHERE user_id = ?",
    ).run(user.id);
    db.close();
    const historicalProgress = {
      ...initial,
      gold: 1750,
      ownedBatIds: ["wood", "silver"],
      equippedBatId: "silver",
      revision: 42,
    };
    seedLegacyReceipt(databasePath, user.id, "buy-silver", {
      ok: true,
      result: { batId: "silver", price: 50, purchased: true, progress: historicalProgress },
    });
    seedLegacyReceipt(databasePath, user.id, "failed-silver", {
      ok: false,
      error: { code: "insufficient_gold", message: "Historical insufficient funds" },
    });
    seedLegacyReceipt(
      databasePath,
      user.id,
      "equip-silver",
      {
        ok: true,
        result: { batId: "silver", changed: true, progress: historicalProgress },
      },
      "equip_bat",
    );
    const persisted = () => {
      const connection = new DatabaseSync(databasePath);
      try {
        return [
          "baseball_game_progress",
          "baseball_owned_bats",
          "baseball_home_run_streaks",
          "baseball_bat_enhancements",
          "baseball_idempotency",
          "game_gold_transactions",
        ].map((table) => connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
      } finally {
        connection.close();
      }
    };
    const before = persisted();
    for (const requestId of ["buy-silver", "failed-silver", "new-purchase"]) {
      await expect(
        store.purchaseBaseballBat({ userId: user.id, requestId, batId: "silver" }),
      ).rejects.toMatchObject({ code: "legacy_purchase_closed" });
    }
    for (const requestId of ["equip-silver", "new-equip"]) {
      await expect(
        store.equipBaseballBat({ userId: user.id, requestId, batId: "silver" }),
      ).rejects.toMatchObject({ code: "legacy_bat_closed" });
    }
    expect(persisted()).toEqual(before);
    store.close();
    const reopened = createStore(databasePath);
    await expect(
      reopened.purchaseBaseballBat({ userId: user.id, requestId: "buy-silver", batId: "silver" }),
    ).rejects.toMatchObject({ code: "legacy_purchase_closed" });
    await expect(
      reopened.equipBaseballBat({ userId: user.id, requestId: "equip-silver", batId: "silver" }),
    ).rejects.toMatchObject({ code: "legacy_bat_closed" });
    expect(persisted()).toEqual(before);
    expect(await reopened.loadBaseballProgress(user.id)).toMatchObject({
      ...historicalProgress,
      enhancement: { level: 0, equipped: true },
    });
    reopened.close();
  });
});
