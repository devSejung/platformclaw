import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BaseballGameError } from "./baseball-contracts.js";
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteControlPlaneStore baseball state", () => {
  it("persists progress across reopen and rewards exactly one gold only for a home run", async () => {
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
      awardedGold: 1,
      progress: {
        gold: 1,
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
      awardedGold: 0,
      progress: {
        gold: 1,
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
      progress: { gold: 1, totalHomers: 1, bestDistanceM: 140, revision: 2 },
    });
    await expect(
      first.rewardBaseballPlateAppearance({
        userId: user.id,
        requestId: "plate-3",
        outcome: "out",
      }),
    ).resolves.toMatchObject({
      awardedGold: 0,
      progress: { gold: 1, totalHomers: 1, bestDistanceM: 140, revision: 2 },
    });
    first.close();

    const reopened = createStore(databasePath);
    await expect(reopened.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 1,
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
      gold: 1,
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
      gold: 1,
      totalHomers: 1,
      bestDistanceM: 125,
    });
    await expect(store.loadBaseballProgress(userB.id)).resolves.toMatchObject({
      gold: 0,
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

  it("replays an insufficient-funds result even when the user's balance later changes", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    await store.loadBaseballProgress(user.id);

    const purchase = {
      userId: user.id,
      requestId: "silver-failed",
      batId: "silver" as const,
    };
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

  it("serializes rewards and purchases across separate SQLite store connections", async () => {
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
      gold: 3,
      totalHomers: 3,
      bestDistanceM: 123,
      currentHomeRunStreak: 3,
      bestHomeRunStreak: 3,
      revision: 3,
    });

    setGold(databasePath, user.id, 200);
    const purchases = await Promise.allSettled([
      first.purchaseBaseballBat({ userId: user.id, requestId: "buy-silver", batId: "silver" }),
      second.purchaseBaseballBat({ userId: user.id, requestId: "buy-gold", batId: "gold" }),
    ]);
    expect(purchases.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(purchases.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = purchases.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(
      BaseballGameError,
    );
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({ code: "insufficient_gold" });
    }
    const progress = await first.loadBaseballProgress(user.id);
    expect(progress.gold).toBeGreaterThanOrEqual(0);
    expect(progress.ownedBatIds.filter((id) => id === "silver" || id === "gold")).toHaveLength(1);
    first.close();
    second.close();
  });

  it("prevents double-charging the same bat across separate SQLite store connections", async () => {
    const databasePath = createDatabasePath();
    const seed = createStore(databasePath);
    const user = await seedUser(seed);
    await seed.loadBaseballProgress(user.id);
    seed.close();
    setGold(databasePath, user.id, 50);

    const first = createStore(databasePath);
    const second = createStore(databasePath);
    const results = await Promise.all([
      first.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-tab-a",
        batId: "silver",
      }),
      second.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-tab-b",
        batId: "silver",
      }),
    ]);

    expect(
      results
        .map((result) => result.purchased)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    await expect(first.loadBaseballProgress(user.id)).resolves.toMatchObject({
      gold: 0,
      ownedBatIds: ["wood", "silver"],
      revision: 1,
    });
    first.close();
    second.close();
  });

  it("charges the canonical server price once and only equips owned bats", async () => {
    const databasePath = createDatabasePath();
    const store = createStore(databasePath);
    const user = await seedUser(store);
    await store.loadBaseballProgress(user.id);
    setGold(databasePath, user.id, 100);

    await expect(
      store.purchaseBaseballBat({ userId: user.id, requestId: "buy-silver", batId: "silver" }),
    ).resolves.toMatchObject({
      batId: "silver",
      price: 50,
      purchased: true,
      progress: { gold: 50, ownedBatIds: ["wood", "silver"], revision: 1 },
    });
    await expect(
      store.purchaseBaseballBat({
        userId: user.id,
        requestId: "buy-silver-again",
        batId: "silver",
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
  });
});
