import { describe, expect, it, vi } from "vitest";
import {
  BASEBALL_RPC,
  BaseballGameError,
  type BaseballGameStore,
  type BaseballProgress,
} from "./baseball-contracts.js";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";
import { BROWSER_SESSION_POLICY } from "./contracts.js";

function progress(overrides: Partial<BaseballProgress> = {}): BaseballProgress {
  return {
    gold: 0,
    ownedBatIds: ["wood"],
    equippedBatId: "wood",
    totalHomers: 0,
    bestDistanceM: 0,
    currentHomeRunStreak: 0,
    bestHomeRunStreak: 0,
    revision: 0,
    ...overrides,
  };
}

function baseballStore() {
  return {
    beginBaseballAtBat: vi.fn<BaseballGameStore["beginBaseballAtBat"]>(async () => ({
      id: "at-bat-1",
      pitchSample: 0.4,
      batId: "wood",
      issuedAt: NOW,
      expiresAt: NOW + 180_000,
    })),
    loadBaseballProgress: vi.fn<BaseballGameStore["loadBaseballProgress"]>(async () => progress()),
    loadBaseballLeaderboard: vi.fn<BaseballGameStore["loadBaseballLeaderboard"]>(async () => ({
      distance: [{ displayName: "Person One", value: 140, isCurrentUser: true }],
      homeRunStreak: [{ displayName: "Person One", value: 3, isCurrentUser: true }],
    })),
    rewardBaseballPlateAppearance: vi.fn<BaseballGameStore["rewardBaseballPlateAppearance"]>(
      async () => ({
        awardedGold: 1 as const,
        progress: progress({ gold: 1, totalHomers: 1, bestDistanceM: 130, revision: 1 }),
      }),
    ),
    purchaseBaseballBat: vi.fn<BaseballGameStore["purchaseBaseballBat"]>(async () => {
      throw new BaseballGameError("legacy_purchase_closed", "Fixed-price bat purchases are closed");
    }),
    equipBaseballBat: vi.fn<BaseballGameStore["equipBaseballBat"]>(async () => {
      throw new BaseballGameError("legacy_bat_closed", "Fixed-price bats are retired");
    }),
    enhanceBaseballBat: vi.fn<BaseballGameStore["enhanceBaseballBat"]>(async ({ requestId }) => ({
      requestId,
      outcome: "success",
      fromLevel: 0,
      targetLevel: 1,
      level: 1,
      chargedGold: 100,
      evolved: false,
      automaticRestart: false,
      progress: progress({
        gold: 900,
        revision: 1,
        enhancement: { level: 1, status: "ready", equipped: true, version: 1 },
      }),
    })),
    recoverBaseballBat: vi.fn<BaseballGameStore["recoverBaseballBat"]>(async ({ requestId }) => ({
      requestId,
      outcome: "restored",
      chargedGold: 15_000,
      progress: progress({
        revision: 1,
        enhancement: { level: 12, status: "ready", equipped: true, version: 1 },
      }),
    })),
    equipEnhancedBaseballBat: vi.fn<BaseballGameStore["equipEnhancedBaseballBat"]>(
      async ({ requestId }) => ({
        requestId,
        changed: true,
        progress: progress({
          revision: 1,
          enhancement: { level: 0, status: "ready", equipped: true, version: 1 },
        }),
      }),
    ),
    selectBaseballTeam: vi.fn<BaseballGameStore["selectBaseballTeam"]>(
      async ({ requestId, teamId }) => ({
        requestId,
        teamId,
        changed: true,
        chargedGold: 0,
        progress: progress({ revision: 1, teamId }),
      }),
    ),
  } satisfies BaseballGameStore;
}

describe("BrowserGatewayProxy baseball BFF", () => {
  it("scopes enhancement, recovery, loadout and paid teams to the authenticated account", async () => {
    const game = baseballStore();
    const { proxy, token, user } = await setup({ baseballStore: game });
    const common = { requestId: "forge-1", expectedRevision: 0 };
    await proxy.request(token, BASEBALL_RPC.enhanceBat, common);
    expect(game.enhanceBaseballBat).toHaveBeenCalledWith({ ...common, userId: user.id });
    await proxy.request(token, BASEBALL_RPC.recoverBat, { ...common, action: "restore" });
    expect(game.recoverBaseballBat).toHaveBeenCalledWith({
      ...common,
      action: "restore",
      userId: user.id,
    });
    await proxy.request(token, BASEBALL_RPC.equipEnhancedBat, common);
    expect(game.equipEnhancedBaseballBat).toHaveBeenCalledWith({ ...common, userId: user.id });
    await proxy.request(token, BASEBALL_RPC.selectTeam, { ...common, teamId: "lg" });
    expect(game.selectBaseballTeam).toHaveBeenCalledWith({
      ...common,
      teamId: "lg",
      userId: user.id,
    });
  });

  it("rejects client-controlled RNG, levels, identities and malformed workshop inputs", async () => {
    const game = baseballStore();
    const { proxy, token } = await setup({ baseballStore: game });
    for (const extra of [{ roll: 0 }, { level: 20 }, { userId: "other" }, { costGold: 0 }]) {
      await expect(
        proxy.request(token, BASEBALL_RPC.enhanceBat, {
          requestId: "bad",
          expectedRevision: 0,
          ...extra,
        }),
      ).rejects.toBeDefined();
    }
    for (const expectedRevision of [-1, 0.5, "0", null, undefined]) {
      await expect(
        proxy.request(token, BASEBALL_RPC.enhanceBat, { requestId: "bad", expectedRevision }),
      ).rejects.toBeDefined();
    }
    await expect(
      proxy.request(token, BASEBALL_RPC.recoverBat, {
        requestId: "bad",
        expectedRevision: 0,
        action: "protect",
      }),
    ).rejects.toBeDefined();
    await expect(
      proxy.request(token, BASEBALL_RPC.selectTeam, {
        requestId: "bad",
        expectedRevision: 0,
        teamId: "neutral",
      }),
    ).rejects.toBeDefined();
    expect(game.enhanceBaseballBat).not.toHaveBeenCalled();
    expect(game.recoverBaseballBat).not.toHaveBeenCalled();
    expect(game.selectBaseballTeam).not.toHaveBeenCalled();
  });
  it("uses the authenticated platform user for local baseball reads and writes", async () => {
    const game = baseballStore();
    const { proxy, request, token, user } = await setup({ baseballStore: game });

    await expect(proxy.request(token, BASEBALL_RPC.progress, {})).resolves.toEqual(progress());
    expect(game.loadBaseballProgress).toHaveBeenCalledWith(user.id);
    await expect(proxy.request(token, BASEBALL_RPC.leaderboard, {})).resolves.toMatchObject({
      distance: [{ value: 140, isCurrentUser: true }],
      homeRunStreak: [{ value: 3, isCurrentUser: true }],
    });
    expect(game.loadBaseballLeaderboard).toHaveBeenCalledWith(user.id);
    await expect(
      proxy.request(token, BASEBALL_RPC.beginAtBat, { requestId: "begin-1" }),
    ).resolves.toMatchObject({ id: "at-bat-1", pitchSample: 0.4, batId: "wood" });
    expect(game.beginBaseballAtBat).toHaveBeenCalledWith({
      userId: user.id,
      requestId: "begin-1",
      now: NOW,
    });
    await expect(
      proxy.request(token, BASEBALL_RPC.plateAppearance, {
        requestId: "plate-1",
        atBatId: "at-bat-1",
        timingDeltaMs: 0,
        outcome: "home_run",
        distanceM: 130,
      }),
    ).resolves.toMatchObject({ awardedGold: 1 });
    expect(game.rewardBaseballPlateAppearance).toHaveBeenCalledWith({
      userId: user.id,
      requestId: "plate-1",
      atBatId: "at-bat-1",
      timingDeltaMs: 0,
      now: NOW,
    });
    await proxy.request(token, BASEBALL_RPC.plateAppearance, {
      requestId: "plate-2",
      atBatId: "at-bat-2",
      timingDeltaMs: null,
      outcome: "out",
      distanceM: 999,
    });
    expect(game.rewardBaseballPlateAppearance).toHaveBeenLastCalledWith({
      userId: user.id,
      requestId: "plate-2",
      atBatId: "at-bat-2",
      timingDeltaMs: null,
      now: NOW,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([BASEBALL_RPC.purchaseBat, BASEBALL_RPC.equipBat])(
    "rejects retired %s without calling the store or forwarding upstream",
    async (method) => {
      const game = baseballStore();
      const { proxy, request, token } = await setup({ baseballStore: game });
      for (const batId of ["wood", "silver", "titanium", "diamond"]) {
        await expect(
          proxy.request(token, method, { requestId: `retired-${batId}`, batId }),
        ).rejects.toMatchObject({ code: "method-not-allowed" });
      }
      await expect(
        proxy.request(token, method, {
          requestId: "bypass",
          batId: "diamond",
          historicalOnly: false,
        }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
      expect(game.purchaseBaseballBat).not.toHaveBeenCalled();
      expect(game.equipBaseballBat).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects client-selected user identity before the baseball store runs", async () => {
    const game = baseballStore();
    const { proxy, request, token } = await setup({ baseballStore: game });

    await expect(
      proxy.request(token, BASEBALL_RPC.progress, { userId: "user-other" }),
    ).rejects.toMatchObject({
      code: "method-not-allowed",
      requestDisposition: "rejected-before-dispatch",
    });
    await expect(
      proxy.request(token, BASEBALL_RPC.plateAppearance, {
        userId: "user-other",
        requestId: "spoofed",
        outcome: "home_run",
        distanceM: 130,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, BASEBALL_RPC.beginAtBat, {
        userId: "user-other",
        requestId: "spoofed-begin",
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, BASEBALL_RPC.leaderboard, { userId: "user-other" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(game.loadBaseballProgress).not.toHaveBeenCalled();
    expect(game.loadBaseballLeaderboard).not.toHaveBeenCalled();
    expect(game.rewardBaseballPlateAppearance).not.toHaveBeenCalled();
    expect(game.beginBaseballAtBat).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("re-authenticates each baseball call and rejects an expired browser session", async () => {
    let now = NOW;
    const game = baseballStore();
    const { proxy, request, token } = await setup({ baseballStore: game, now: () => now });
    now = NOW + BROWSER_SESSION_POLICY.absoluteTimeoutMs + 1;

    await expect(proxy.request(token, BASEBALL_RPC.progress, {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(game.loadBaseballProgress).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("validates narrow baseball payloads and maps domain failures without upstream dispatch", async () => {
    const game = baseballStore();
    game.enhanceBaseballBat.mockRejectedValueOnce(
      new BaseballGameError("insufficient_gold", "not enough baseball gold for enhancement"),
    );
    const { proxy, request, token } = await setup({ baseballStore: game });

    await expect(
      proxy.request(token, BASEBALL_RPC.plateAppearance, {
        requestId: "fabricated-home-run",
        outcome: "home_run",
        distanceM: 130,
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    for (const timingDeltaMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 2_001, "0"]) {
      await expect(
        proxy.request(token, BASEBALL_RPC.plateAppearance, {
          requestId: "bad-timing",
          atBatId: "at-bat-1",
          timingDeltaMs,
        }),
      ).rejects.toMatchObject({ code: "invalid-params" });
    }
    expect(game.rewardBaseballPlateAppearance).not.toHaveBeenCalled();
    await expect(
      proxy.request(token, BASEBALL_RPC.enhanceBat, {
        requestId: "enhance-1",
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: "invalid-params",
      message: "not enough baseball gold for enhancement",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
