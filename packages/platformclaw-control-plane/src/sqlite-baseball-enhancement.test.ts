import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseballKboTeamId } from "./baseball-contracts.js";
import { getBaseballEnhancementRule } from "./baseball-enhancement.js";
import { runImmediateTransaction } from "./kysely-sync.js";
import { SqliteGameEconomy } from "./sqlite-game-economy.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

const directories: string[] = [];
const stores: SqliteControlPlaneStore[] = [];

function openStore(databasePath: string, roll: () => number) {
  const store = new SqliteControlPlaneStore(
    {
      databasePath,
      buildAgentMainSessionKey: ({ agentId }) => `agent:${agentId}:main`,
      initialAdminAccountIds: ["synthetic.player"],
    },
    { enhancementRoll: roll },
  );
  stores.push(store);
  return store;
}

async function setup(gold = 100_000) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "baseball-enhancement-")));
  directories.push(directory);
  const databasePath = join(directory, "control.sqlite");
  let rollValue = 0;
  const roll = vi.fn(() => rollValue);
  const store = openStore(databasePath, roll);
  const { user } = await store.upsertPrincipal(
    {
      provider: "ldap",
      subject: "synthetic.player",
      accountId: "synthetic.player",
      employeeId: "synthetic.employee",
      displayName: "Synthetic Player",
    },
    1_000,
  );
  await store.loadBaseballProgress(user.id);
  const write = (sql: string, ...values: (string | number)[]) => {
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(sql).run(...values);
    } finally {
      db.close();
    }
  };
  const read = (sql: string) => {
    const db = new DatabaseSync(databasePath);
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  write("UPDATE baseball_game_progress SET gold = ? WHERE user_id = ?", gold, user.id);
  const equip = () =>
    store.equipEnhancedBaseballBat({
      userId: user.id,
      requestId: "start-enhanced",
      expectedRevision: 0,
    });
  const state = (level: number, status: "ready" | "broken" = "ready") =>
    write(
      "UPDATE baseball_bat_enhancements SET level = ?, status = ? WHERE user_id = ?",
      level,
      status,
      user.id,
    );
  const spendRacingGold = (amount: number, reference = "synthetic-race-ticket") => {
    const db = new DatabaseSync(databasePath);
    try {
      const economy = new SqliteGameEconomy(db);
      economy.ensureSchema();
      runImmediateTransaction(db, () =>
        economy.change(user.id, -amount, "horse_bet", reference, 2_000),
      );
    } finally {
      db.close();
    }
  };
  return {
    store,
    userId: user.id,
    databasePath,
    roll,
    setRoll: (value: number) => {
      rollValue = value;
    },
    write,
    read,
    equip,
    state,
    spendRacingGold,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("atomic opt-in baseball enhancements", () => {
  it("retains existing bats, wallet, records and SQLite version until the user explicitly starts", async () => {
    const ctx = await setup(12_345);
    ctx.write(
      "INSERT INTO baseball_owned_bats (user_id,bat_id) VALUES (?,?)",
      ctx.userId,
      "diamond",
    );
    ctx.write(
      "UPDATE baseball_game_progress SET equipped_bat_id = 'diamond', total_homers = 9, best_distance_m = 147, revision = 42 WHERE user_id = ?",
      ctx.userId,
    );
    const prior = await ctx.store.loadBaseballProgress(ctx.userId);
    expect(prior).toMatchObject({
      gold: 12_345,
      equippedBatId: "diamond",
      ownedBatIds: ["wood", "diamond"],
      totalHomers: 9,
      bestDistanceM: 147,
      revision: 42,
    });
    expect(prior).not.toHaveProperty("enhancement");
    expect(prior).not.toHaveProperty("teamId");
    const atBat = await ctx.store.beginBaseballAtBat({
      userId: ctx.userId,
      requestId: "legacy-pitch",
      now: 1_000,
    });
    expect(atBat.batId).toBe("diamond");
    expect(atBat).not.toHaveProperty("enhancementLevel");
    const version = ctx.read("PRAGMA user_version");
    const activated = await ctx.store.equipEnhancedBaseballBat({
      userId: ctx.userId,
      requestId: "explicit-activation",
      expectedRevision: 42,
    });
    expect(activated).toMatchObject({
      changed: true,
      progress: {
        ...prior,
        revision: 43,
        enhancement: { level: 0, status: "ready", equipped: true, version: 1 },
      },
    });
    expect(ctx.read("PRAGMA user_version")).toEqual(version);
    expect(ctx.read("SELECT * FROM game_gold_transactions")).toHaveLength(0);
    expect(ctx.roll).not.toHaveBeenCalled();
  });

  it.each([
    ["success", 0, 1, 100],
    ["maintain", 9_975, 0, 100],
  ] as const)(
    "charges one +1 attempt on %s and replays the exact receipt",
    async (outcome, rollValue, level, cost) => {
      const ctx = await setup(500);
      await ctx.equip();
      ctx.setRoll(rollValue);
      const request = { userId: ctx.userId, requestId: "attempt", expectedRevision: 1 };
      const receipt = await ctx.store.enhanceBaseballBat(request);
      expect(receipt).toMatchObject({
        requestId: "attempt",
        outcome,
        fromLevel: 0,
        targetLevel: 1,
        level,
        chargedGold: cost,
        evolved: false,
        automaticRestart: false,
        progress: { gold: 400, revision: 2, enhancement: { level, status: "ready" } },
      });
      expect(await ctx.store.enhanceBaseballBat(request)).toEqual(receipt);
      const reopened = openStore(ctx.databasePath, ctx.roll);
      expect(await reopened.enhanceBaseballBat(request)).toEqual(receipt);
      expect(ctx.roll).toHaveBeenCalledTimes(1);
      expect(ctx.read("SELECT delta,balance_after,reason FROM game_gold_transactions")).toEqual([
        { delta: -100, balance_after: 400, reason: "bat_enhancement" },
      ]);
      await expect(
        ctx.store.enhanceBaseballBat({ ...request, requestId: "held-click-new-id" }),
      ).rejects.toMatchObject({ code: "stale_progress" });
      expect(ctx.roll).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [4, 2],
    [5, 3],
    [6, 4],
    [7, 5],
    [8, 6],
    [9, 7],
    [10, 8],
    [11, 9],
    [12, 10],
    [13, 11],
    [14, 12],
    [15, 13],
    [16, 14],
    [17, 15],
    [18, 15],
    [19, 16],
    [20, 17],
  ])("lands a failed +%i attempt at +%i and charges the fee", async (target, landing) => {
    const ctx = await setup();
    await ctx.equip();
    ctx.state(target - 1);
    const rule = getBaseballEnhancementRule(target);
    ctx.setRoll(rule.success + rule.maintain);
    const result = await ctx.store.enhanceBaseballBat({
      userId: ctx.userId,
      requestId: "drop",
      expectedRevision: 1,
    });
    expect(result).toMatchObject({
      outcome: "drop",
      fromLevel: target - 1,
      targetLevel: target,
      level: landing,
      chargedGold: rule.costGold,
      progress: { gold: 100_000 - rule.costGold, enhancement: { level: landing, status: "ready" } },
    });
  });

  it("reports tier evolution without adding or replacing any previously owned bat", async () => {
    const ctx = await setup();
    await ctx.equip();
    ctx.state(2);
    const result = await ctx.store.enhanceBaseballBat({
      userId: ctx.userId,
      requestId: "evolve-silver",
      expectedRevision: 1,
    });
    expect(result).toMatchObject({
      outcome: "success",
      level: 3,
      evolved: true,
      chargedGold: 200,
      progress: { equippedBatId: "wood", ownedBatIds: ["wood"] },
    });
    const atBat = await ctx.store.beginBaseballAtBat({
      userId: ctx.userId,
      requestId: "silver-appearance",
      now: 1_000,
    });
    expect(atBat).toMatchObject({
      batId: "silver",
      enhancementLevel: 3,
      powerRuleVersion: "sweetspot-v1",
    });
    await ctx.store.equipBaseballBat({
      userId: ctx.userId,
      requestId: "legacy-wood",
      batId: "wood",
    });
    expect(await ctx.store.loadBaseballProgress(ctx.userId)).toMatchObject({
      enhancement: { level: 3, equipped: false },
    });
    const progress = await ctx.store.loadBaseballProgress(ctx.userId);
    const reequipped = await ctx.store.equipEnhancedBaseballBat({
      userId: ctx.userId,
      requestId: "reequip",
      expectedRevision: progress.revision,
    });
    expect(reequipped.progress.enhancement).toMatchObject({ level: 3, equipped: true });
  });

  it("resets total destruction to ready +0 while preserving gold after the fee and all records", async () => {
    const ctx = await setup(50_000);
    await ctx.equip();
    ctx.state(3);
    ctx.write(
      "UPDATE baseball_game_progress SET total_homers = 11, best_distance_m = 160 WHERE user_id = ?",
      ctx.userId,
    );
    ctx.setRoll(9_999);
    const result = await ctx.store.enhanceBaseballBat({
      userId: ctx.userId,
      requestId: "total-destroy",
      expectedRevision: 1,
    });
    expect(result).toMatchObject({
      outcome: "total_destroy",
      level: 0,
      chargedGold: 300,
      automaticRestart: false,
      progress: {
        gold: 49_700,
        totalHomers: 11,
        bestDistanceM: 160,
        enhancement: { level: 0, status: "ready", equipped: true },
      },
    });
  });

  it.each([15_000, 14_999])(
    "offers recovery only when the balance after the fee is sufficient (%iG)",
    async (remainingGold) => {
      const ctx = await setup(10_000 + remainingGold);
      await ctx.equip();
      ctx.state(15);
      ctx.setRoll(9_650);
      const broken = await ctx.store.enhanceBaseballBat({
        userId: ctx.userId,
        requestId: "normal-destroy",
        expectedRevision: 1,
      });
      const enough = remainingGold >= 15_000;
      expect(broken).toMatchObject({
        outcome: "destroy",
        automaticRestart: !enough,
        level: 0,
        progress: {
          gold: remainingGold,
          enhancement: { level: 0, status: enough ? "broken" : "ready" },
        },
      });
      if (!enough) {
        return;
      }
      await expect(
        ctx.store.beginBaseballAtBat({ userId: ctx.userId, requestId: "broken-pitch", now: 1_000 }),
      ).rejects.toMatchObject({ code: "bat_broken" });
      await expect(
        ctx.store.enhanceBaseballBat({
          userId: ctx.userId,
          requestId: "broken-attempt",
          expectedRevision: 2,
        }),
      ).rejects.toMatchObject({ code: "bat_broken" });
      const request = {
        userId: ctx.userId,
        requestId: "restore",
        expectedRevision: 2,
        action: "restore" as const,
      };
      const restored = await ctx.store.recoverBaseballBat(request);
      expect(restored).toMatchObject({
        outcome: "restored",
        chargedGold: 15_000,
        progress: { gold: 0, revision: 3, enhancement: { level: 12, status: "ready" } },
      });
      expect(await ctx.store.recoverBaseballBat(request)).toEqual(restored);
      await expect(
        ctx.store.recoverBaseballBat({
          ...request,
          requestId: "restore-again",
          expectedRevision: 3,
        }),
      ).rejects.toMatchObject({ code: "bat_not_broken" });
      expect(ctx.roll).toHaveBeenCalledTimes(1);
      expect(
        ctx.read("SELECT reason,delta,balance_after FROM game_gold_transactions ORDER BY rowid"),
      ).toEqual([
        { reason: "bat_enhancement", delta: -10_000, balance_after: 15_000 },
        { reason: "bat_recovery", delta: -15_000, balance_after: 0 },
      ]);
    },
  );

  it.each(["restart", "restore"] as const)(
    "keeps recovery atomic when racing spends shared gold before %s",
    async (action) => {
      const ctx = await setup(35_000);
      await ctx.equip();
      ctx.state(15);
      ctx.setRoll(9_650);
      await ctx.store.enhanceBaseballBat({
        userId: ctx.userId,
        requestId: "break",
        expectedRevision: 1,
      });
      ctx.spendRacingGold(20_000);
      await expect(
        ctx.store.recoverBaseballBat({
          userId: ctx.userId,
          requestId: "stale-recovery",
          expectedRevision: 2,
          action,
        }),
      ).rejects.toMatchObject({ code: "stale_progress" });
      const receipt = await ctx.store.recoverBaseballBat({
        userId: ctx.userId,
        requestId: "recover-after-racing",
        expectedRevision: 3,
        action,
      });
      expect(receipt).toMatchObject({
        outcome: "restarted",
        chargedGold: 0,
        progress: { gold: 5_000, revision: 4, enhancement: { level: 0, status: "ready" } },
      });
      expect(ctx.read("SELECT reason FROM game_gold_transactions")).toHaveLength(2);
    },
  );

  it("rejects unaffordable, inactive and max-level attempts before drawing or charging", async () => {
    const ctx = await setup(99);
    await expect(
      ctx.store.enhanceBaseballBat({
        userId: ctx.userId,
        requestId: "inactive",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_enhancement" });
    await ctx.equip();
    const request = { userId: ctx.userId, requestId: "poor", expectedRevision: 1 };
    await expect(ctx.store.enhanceBaseballBat(request)).rejects.toMatchObject({
      code: "insufficient_gold",
    });
    ctx.write("UPDATE baseball_game_progress SET gold = 1000 WHERE user_id = ?", ctx.userId);
    await expect(ctx.store.enhanceBaseballBat(request)).rejects.toMatchObject({
      code: "insufficient_gold",
    });
    ctx.state(20);
    await expect(
      ctx.store.enhanceBaseballBat({ ...request, requestId: "max" }),
    ).rejects.toMatchObject({ code: "enhancement_max" });
    expect(ctx.roll).not.toHaveBeenCalled();
    expect(ctx.read("SELECT * FROM game_gold_transactions")).toHaveLength(0);
    expect((await ctx.store.loadBaseballProgress(ctx.userId)).gold).toBe(1_000);
  });

  it("serializes same-request retries and different stale clicks across SQLite connections", async () => {
    const ctx = await setup(1_000);
    await ctx.equip();
    ctx.setRoll(9_975);
    const second = openStore(ctx.databasePath, ctx.roll);
    const request = { userId: ctx.userId, requestId: "same-attempt", expectedRevision: 1 };
    const results = await Promise.all([
      ctx.store.enhanceBaseballBat(request),
      second.enhanceBaseballBat(request),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(ctx.roll).toHaveBeenCalledTimes(1);
    const next = { userId: ctx.userId, requestId: "next-a", expectedRevision: 2 };
    const concurrent = await Promise.allSettled([
      ctx.store.enhanceBaseballBat(next),
      second.enhanceBaseballBat({ ...next, requestId: "next-b" }),
    ]);
    expect(concurrent.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(concurrent.find((entry) => entry.status === "rejected")).toMatchObject({
      reason: { code: "stale_progress" },
    });
    expect(ctx.roll).toHaveBeenCalledTimes(2);
    expect(await ctx.store.loadBaseballProgress(ctx.userId)).toMatchObject({
      gold: 800,
      revision: 3,
      enhancement: { level: 0 },
    });
    await expect(
      second.recoverBaseballBat({
        userId: ctx.userId,
        requestId: request.requestId,
        expectedRevision: 1,
        action: "restart",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("sees a racing debit before an enhancement and cannot make the wallet negative", async () => {
    const ctx = await setup(100);
    await ctx.equip();
    ctx.spendRacingGold(50);
    await expect(
      ctx.store.enhanceBaseballBat({
        userId: ctx.userId,
        requestId: "before-refresh",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "stale_progress" });
    await expect(
      ctx.store.enhanceBaseballBat({
        userId: ctx.userId,
        requestId: "after-refresh",
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "insufficient_gold" });
    expect(ctx.roll).not.toHaveBeenCalled();
    expect(await ctx.store.loadBaseballProgress(ctx.userId)).toMatchObject({
      gold: 50,
      enhancement: { level: 0 },
    });
  });

  it.each(["racing-first", "enhance-first"] as const)(
    "shares one wallet with the real racing API in %s order",
    async (order) => {
      const ctx = await setup(100);
      await ctx.equip();
      const second = openStore(ctx.databasePath, ctx.roll);
      const now = Date.parse("2026-10-15T10:50:00+09:00");
      const race = second.racing.snapshot(ctx.userId, now).race!;
      expect(race.status).toBe("betting");
      const enhance = () =>
        ctx.store.enhanceBaseballBat({
          userId: ctx.userId,
          requestId: "shared-wallet-enhance",
          expectedRevision: 1,
        });
      const bet = () =>
        second.racing.placeBet(
          ctx.userId,
          {
            requestId: "shared-wallet-ticket",
            raceId: race.id,
            market: "win",
            selection: ["1"],
            amount: 50,
          },
          now,
        );
      const operations = order === "racing-first" ? [bet, enhance] : [enhance, bet];
      const results = await Promise.allSettled(
        operations.map((operation) => Promise.resolve().then<unknown>(operation)),
      );
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const expectedGold = order === "racing-first" ? 50 : 0;
      expect(await ctx.store.loadBaseballProgress(ctx.userId)).toMatchObject({
        gold: expectedGold,
        revision: 2,
      });
      expect(second.racing.snapshot(ctx.userId, now).gold).toBe(expectedGold);
      expect(ctx.read("SELECT delta,balance_after FROM game_gold_transactions")).toEqual([
        { delta: order === "racing-first" ? -50 : -100, balance_after: expectedGold },
      ]);
      expect(ctx.roll).toHaveBeenCalledTimes(order === "racing-first" ? 0 : 1);
    },
  );

  it("stores server-owned teams, charges only changes after the first selection and replays receipts", async () => {
    const ctx = await setup(2_000);
    const first = await ctx.store.selectBaseballTeam({
      userId: ctx.userId,
      requestId: "first-team",
      expectedRevision: 0,
      teamId: "kia",
    });
    expect(first).toMatchObject({
      changed: true,
      chargedGold: 0,
      progress: { gold: 2_000, revision: 1, teamId: "kia" },
    });
    const same = await ctx.store.selectBaseballTeam({
      userId: ctx.userId,
      requestId: "same-team",
      expectedRevision: 1,
      teamId: "kia",
    });
    expect(same).toMatchObject({ changed: false, chargedGold: 0, progress: { revision: 1 } });
    const request = {
      userId: ctx.userId,
      requestId: "paid-team",
      expectedRevision: 1,
      teamId: "lg" as const,
    };
    const changed = await ctx.store.selectBaseballTeam(request);
    expect(changed).toMatchObject({
      chargedGold: 2_000,
      progress: { gold: 0, revision: 2, teamId: "lg" },
    });
    expect(await ctx.store.selectBaseballTeam(request)).toEqual(changed);
    await expect(
      ctx.store.selectBaseballTeam({
        ...request,
        requestId: "poor-team",
        expectedRevision: 2,
        teamId: "lotte",
      }),
    ).rejects.toMatchObject({ code: "insufficient_gold" });
    await expect(
      ctx.store.selectBaseballTeam({
        ...request,
        requestId: "invalid-team",
        expectedRevision: 2,
        teamId: "neutral" as BaseballKboTeamId,
      }),
    ).rejects.toMatchObject({ code: "invalid_team" });
    expect(await ctx.store.loadBaseballProgress(ctx.userId)).toMatchObject({
      gold: 0,
      teamId: "lg",
    });
    expect(ctx.read("SELECT reason,delta FROM game_gold_transactions")).toEqual([
      { reason: "baseball_team_change", delta: -2_000 },
    ]);
  });

  it("fixes issued enhancement snapshots even if the bat changes or breaks before retry", async () => {
    const ctx = await setup();
    await ctx.equip();
    ctx.state(20);
    const issued = await ctx.store.beginBaseballAtBat({
      userId: ctx.userId,
      requestId: "pinned",
      now: 1_000,
    });
    expect(issued).toMatchObject({
      batId: "diamond",
      enhancementLevel: 20,
      powerRuleVersion: "sweetspot-v1",
    });
    ctx.state(0, "broken");
    expect(
      await ctx.store.beginBaseballAtBat({ userId: ctx.userId, requestId: "pinned", now: 2_000 }),
    ).toEqual(issued);
    await expect(
      ctx.store.beginBaseballAtBat({ userId: ctx.userId, requestId: "blocked", now: 2_000 }),
    ).rejects.toMatchObject({ code: "bat_broken" });
    const reward = await ctx.store.rewardBaseballPlateAppearance({
      userId: ctx.userId,
      requestId: "pinned-swing",
      atBatId: issued.id,
      timingDeltaMs: 25,
      now: 2_000,
    });
    // +20's frozen sweet-spot rule remains base power at +25ms; legacy diamond would homer here.
    expect(reward.awardedGold).toBe(0);
    expect(reward.progress.totalHomers).toBe(0);
  });
});
