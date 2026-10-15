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
): void {
  const db = new DatabaseSync(databasePath);
  db.prepare(
    "INSERT INTO baseball_idempotency (user_id,request_id,operation,payload_digest,result_json) VALUES (?,?,?,?,?)",
  ).run(
    userId,
    requestId,
    "purchase_bat",
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
  it("persists progress across reopen and rewards three gold per hit and five per home run", async () => {
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
    });
    const homeRun = await first.rewardBaseballPlateAppearance({
      userId: user.id,
      requestId: "plate-1",
      outcome: "home_run",
      distanceM: 132,
    });
    expect(homeRun).toMatchObject({
      awardedGold: 5,
      homeRunBonusGold: 0,
      progress: {
        gold: 5,
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
      awardedGold: 3,
      progress: {
        gold: 8,
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
      progress: { gold: 8, totalHomers: 1, bestDistanceM: 140, revision: 2 },
    });
    await expect(
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "plate-3",
        outcome: "out",
      }),
    ).resolves.toMatchObject({
      awardedGold: 0,
      progress: { gold: 8, totalHomers: 1, bestDistanceM: 140, revision: 2 },
    });
    first.close();

    const reopened = createStore(databasePath);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 8,
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
        awardedGold: 5,
        progress: { gold: homer * 5, totalHomers: homer, revision: homer * 2 - 1 },
      });
      await expect(
        first.rewardBaseballPlateAppearance({
          userId: user.id,
          requestId: `miss-${homer}`,
          outcome: "miss",
        }),
      ).resolves.toMatchObject({
        awardedGold: 0,
        progress: { gold: homer * 5, currentHomeRunStreak: 0, revision: homer * 2 },
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
      awardedGold: 10,
      homeRunBonusGold: 5,
      progress: {
        gold: 30,
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
      gold: 30,
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
      awardedGold: 3,
      progress: { gold: 33, totalHomers: 5, revision: 10 },
    });
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
    await expect(upgraded.loadBaseballProgress(user.id)).resolves.toEqual(priorProgress);
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
      awardedGold: 10,
      homeRunBonusGold: 5,
      progress: {
        ...priorProgress,
        gold: 1_244,
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
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(store.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 5,
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
      gold: 5,
      totalHomers: 1,
      bestDistanceM: 125,
    });
    await expect(store.loadBaseballProgress(userB.id)).resolves.toMatchObject({
      gold: 3,
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

  it("preserves a prior insufficient-funds purchase receipt after new purchases close", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    await store.loadBaseballProgress(user.id);

    const purchase = {
      userId: user.id,
      requestId: "silver-failed",
      batId: "silver" as const,
      historicalOnly: true,
    };
    seedLegacyReceipt(databasePath, user.id, purchase.requestId, {
      ok: false,
      error: { code: "insufficient_gold", message: "Legacy purchase lacked gold" },
    });
    await expect(store.purchaseBaseballBat(purchase)).rejects.toMatchObject({
      code: "insufficient_gold",
    });
    setGold(databasePath, user.id, 50);
    await expect(store.purchaseBaseballBat(purchase)).rejects.toMatchObject({
      code: "insufficient_gold",
    });
    await expect(store.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 50,
      ownedBatIds: ["wood"],
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
      gold: 15,
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
    expect(rewards.map((reward) => reward.awardedGold).toSorted((a, b) => a - b)).toEqual([
      5, 10, 10,
    ]);
    await expect(first.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 35,
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
        historicalOnly: true,
      }),
      second.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-tab-b",
        batId: "diamond",
        historicalOnly: true,
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

  it("replays prior successful purchases and keeps existing owned bats usable without another charge", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    const initial = await store.loadBaseballProgress(user.id);
    setGold(databasePath, user.id, 50);
    const db = new DatabaseSync(databasePath);
    db.prepare("INSERT INTO baseball_owned_bats (user_id,bat_id) VALUES (?,?)").run(
      user.id,
      "silver",
    );
    db.prepare("UPDATE baseball_game_progress SET revision = 1 WHERE user_id = ?").run(user.id);
    db.close();
    const priorResult = {
      batId: "silver",
      price: 50,
      purchased: true,
      progress: { ...initial, gold: 50, ownedBatIds: ["wood", "silver"], revision: 1 },
    };
    seedLegacyReceipt(databasePath, user.id, "buy-silver", { ok: true, result: priorResult });

    await expect(
      store.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver",
        batId: "silver",
        historicalOnly: true,
      }),
    ).resolves.toEqual(priorResult);
    await expect(
      store.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-again",
        batId: "silver",
        historicalOnly: true,
      }),
    ).resolves.toMatchObject({
      price: 50,
      purchased: false,
      progress: { gold: 50, revision: 1 },
    });
    await expect(
      store.equipBaseballBat({ userId: user.id, requestId: "equip-gold", batId: "gold" }),
    ).rejects.toMatchObject({ code: "bat_not_owned" });
    await expect(
      store.equipBaseballBat({ userId: user.id, requestId: "equip-silver", batId: "silver" }),
    ).resolves.toMatchObject({
      batId: "silver",
      changed: true,
      progress: { equippedBatId: "silver", revision: 2 },
    });
    store.close();
    const reopened = createStore(databasePath);
    await expect(
      reopened.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver",
        batId: "silver",
        historicalOnly: true,
      }),
    ).resolves.toEqual(priorResult);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 50,
      equippedBatId: "silver",
      ownedBatIds: ["wood", "silver"],
      revision: 2,
    });
    reopened.close();
  });
});
