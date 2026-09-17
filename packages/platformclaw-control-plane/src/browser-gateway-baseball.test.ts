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
    revision: 0,
    ...overrides,
  };
}

function baseballStore() {
  return {
    loadBaseballProgress: vi.fn<BaseballGameStore["loadBaseballProgress"]>(async () => progress()),
    rewardBaseballPlateAppearance: vi.fn<BaseballGameStore["rewardBaseballPlateAppearance"]>(
      async () => ({
        awardedGold: 1 as const,
        progress: progress({ gold: 1, totalHomers: 1, bestDistanceM: 130, revision: 1 }),
      }),
    ),
    purchaseBaseballBat: vi.fn<BaseballGameStore["purchaseBaseballBat"]>(async () => ({
      batId: "silver" as const,
      price: 50,
      purchased: true,
      progress: progress({ gold: 0, ownedBatIds: ["wood", "silver"], revision: 1 }),
    })),
    equipBaseballBat: vi.fn<BaseballGameStore["equipBaseballBat"]>(async () => ({
      batId: "silver" as const,
      changed: true,
      progress: progress({
        ownedBatIds: ["wood", "silver"],
        equippedBatId: "silver",
        revision: 2,
      }),
    })),
  } satisfies BaseballGameStore;
}

describe("BrowserGatewayProxy baseball BFF", () => {
  it("uses the authenticated platform user for local baseball reads and writes", async () => {
    const game = baseballStore();
    const { proxy, request, token, user } = await setup({ baseballStore: game });

    await expect(proxy.request(token, BASEBALL_RPC.progress, {})).resolves.toEqual(progress());
    expect(game.loadBaseballProgress).toHaveBeenCalledWith(user.id);
    await expect(
      proxy.request(token, BASEBALL_RPC.plateAppearance, {
        requestId: "plate-1",
        outcome: "home_run",
        distanceM: 130,
      }),
    ).resolves.toMatchObject({ awardedGold: 1 });
    expect(game.rewardBaseballPlateAppearance).toHaveBeenCalledWith({
      userId: user.id,
      requestId: "plate-1",
      outcome: "home_run",
      distanceM: 130,
    });
    await proxy.request(token, BASEBALL_RPC.plateAppearance, {
      requestId: "plate-2",
      outcome: "out",
      distanceM: 999,
    });
    expect(game.rewardBaseballPlateAppearance).toHaveBeenLastCalledWith({
      userId: user.id,
      requestId: "plate-2",
      outcome: "out",
    });
    await expect(
      proxy.request(token, BASEBALL_RPC.purchaseBat, { requestId: "buy-1", batId: "silver" }),
    ).resolves.toMatchObject({ batId: "silver", price: 50 });
    expect(game.purchaseBaseballBat).toHaveBeenCalledWith({
      userId: user.id,
      requestId: "buy-1",
      batId: "silver",
    });
    expect(request).not.toHaveBeenCalled();
  });

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
    expect(game.loadBaseballProgress).not.toHaveBeenCalled();
    expect(game.rewardBaseballPlateAppearance).not.toHaveBeenCalled();
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
    game.purchaseBaseballBat.mockRejectedValueOnce(
      new BaseballGameError("insufficient_gold", "not enough baseball gold for silver"),
    );
    const { proxy, request, token } = await setup({ baseballStore: game });

    await expect(
      proxy.request(token, BASEBALL_RPC.plateAppearance, {
        requestId: "bad-outcome",
        outcome: "HOME_RUN",
        distanceM: 130,
      }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    await expect(
      proxy.request(token, BASEBALL_RPC.purchaseBat, { requestId: "bad-bat", batId: "mythril" }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    await expect(
      proxy.request(token, BASEBALL_RPC.purchaseBat, { requestId: "buy-1", batId: "silver" }),
    ).rejects.toMatchObject({
      code: "invalid-params",
      message: "not enough baseball gold for silver",
    });
    expect(request).not.toHaveBeenCalled();
  });
});
