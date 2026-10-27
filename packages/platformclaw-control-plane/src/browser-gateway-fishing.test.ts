import { describe, expect, it, vi } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";
import { FISHING_RPC, FishingError, type FishingStore } from "./fishing-contracts.js";

function gameStore() {
  return {
    executeFishing: vi.fn<FishingStore["executeFishing"]>(),
    loadFishingSnapshot: vi.fn<FishingStore["loadFishingSnapshot"]>(),
    loadFishingLeaderboard: vi.fn<FishingStore["loadFishingLeaderboard"]>(),
  };
}

describe("authenticated fishing browser boundary", () => {
  it("pins identity and server time, never forwards to Gateway, and rejects client economy/timing authority", async () => {
    const game = gameStore();
    const { proxy, token, user, request } = await setup({ fishingStore: game });
    await proxy.request(token, FISHING_RPC.snapshot, {});
    expect(game.loadFishingSnapshot).toHaveBeenCalledWith(user.id, 1_000_000);
    await proxy.request(token, FISHING_RPC.leaderboard, {});
    expect(game.loadFishingLeaderboard).toHaveBeenCalledWith(user.id);
    await proxy.request(token, FISHING_RPC.begin, { requestId: "begin" });
    expect(game.executeFishing).toHaveBeenCalledWith(
      user.id,
      { action: "begin", requestId: "begin" },
      1_000_000,
    );
    await proxy.request(token, FISHING_RPC.reel, {
      requestId: "reel",
      attemptId: "server-attempt",
      held: true,
    });
    expect(game.executeFishing).toHaveBeenLastCalledWith(
      user.id,
      { action: "reel", requestId: "reel", attemptId: "server-attempt", held: true },
      1_000_000,
    );
    await proxy.request(token, FISHING_RPC.finish, {
      requestId: "finish",
      attemptId: "server-attempt",
    });
    expect(game.executeFishing).toHaveBeenLastCalledWith(
      user.id,
      { action: "finish", requestId: "finish", attemptId: "server-attempt" },
      1_000_000,
    );
    for (const foreign of [
      { userId: "other" },
      { seed: 123 },
      { now: 0 },
      { quality: "PERFECT" },
      { rewardGold: 1_000_000 },
      { atMs: 0 },
      { region: "pond" },
      { accuracy: 1 },
      { bonusMultiplier: 2 },
      { fishLengthCm: 1 },
      { fishId: "minnow" },
      { difficulty: 1 },
      { escapeReason: "slack" },
    ]) {
      await expect(
        proxy.request(token, FISHING_RPC.begin, { requestId: "hack", ...foreign }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
    }
    expect(game.executeFishing).toHaveBeenCalledTimes(3);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects client-supplied individual size and physics during hook and reel", async () => {
    const game = gameStore();
    const { proxy, token } = await setup({ fishingStore: game });
    for (const method of [FISHING_RPC.hook, FISHING_RPC.reel]) {
      for (const foreign of [
        { fishLengthCm: 1 },
        { fishId: "minnow" },
        { difficulty: 1 },
        { seed: 123 },
        { escapeReason: "line_broken" },
      ]) {
        await expect(
          proxy.request(token, method, {
            requestId: "forged-physics",
            attemptId: "server-attempt",
            ...(method === FISHING_RPC.reel ? { held: true } : {}),
            ...foreign,
          }),
        ).rejects.toMatchObject({ code: "method-not-allowed" });
      }
    }
    expect(game.executeFishing).not.toHaveBeenCalled();
  });

  it("validates mutations before dispatch and surfaces actionable game errors", async () => {
    const game = gameStore();
    const { proxy, token } = await setup({ fishingStore: game });
    for (const params of [{}, { requestId: "" }, { requestId: "x".repeat(129) }]) {
      await expect(proxy.request(token, FISHING_RPC.begin, params)).rejects.toMatchObject({
        code: "invalid-params",
      });
    }
    for (const attemptId of [undefined, "", " ", 1, null, "a".repeat(129)]) {
      for (const method of [FISHING_RPC.hook, FISHING_RPC.finish]) {
        await expect(
          proxy.request(token, method, { requestId: "r", attemptId }),
        ).rejects.toMatchObject({ code: "invalid-params" });
      }
    }
    for (const foreign of [
      { position: 0.5 },
      { accuracy: 1 },
      { bonusMultiplier: 2 },
      { atMs: 600 },
      { now: 0 },
    ]) {
      await expect(
        proxy.request(token, FISHING_RPC.finish, {
          requestId: "forged-finish",
          attemptId: "a",
          ...foreign,
        }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
    }
    await expect(
      proxy.request(token, FISHING_RPC.reel, { requestId: "r", attemptId: "a", held: 1 }),
    ).rejects.toMatchObject({ code: "invalid-params" });
    expect(game.executeFishing).not.toHaveBeenCalled();
    game.executeFishing.mockImplementationOnce(() => {
      throw new FishingError("attempt_active", "진행 중인 낚시를 먼저 마치세요.");
    });
    await expect(
      proxy.request(token, FISHING_RPC.begin, { requestId: "begin" }),
    ).rejects.toMatchObject({ code: "invalid-params", message: "진행 중인 낚시를 먼저 마치세요." });
  });

  it.each(["auto", "sell", "upgrade", "unlock"])(
    "does not expose the removed %s API",
    async (action) => {
      const game = gameStore();
      const { proxy, token, request } = await setup({ fishingStore: game });
      await expect(
        proxy.request(token, `platformclaw.fishing.${action}`, {}),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
      expect(game.executeFishing).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("authenticates each request and fails visibly when persistence is unavailable", async () => {
    let now = 1_000_000;
    const game = gameStore();
    const { proxy, token } = await setup({ fishingStore: game, now: () => now });
    now += 24 * 3_600_000;
    await expect(proxy.request(token, FISHING_RPC.snapshot, {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(game.loadFishingSnapshot).not.toHaveBeenCalled();
    const missing = await setup();
    await expect(
      missing.proxy.request(missing.token, FISHING_RPC.snapshot, {}),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(missing.request).not.toHaveBeenCalled();
  });
});
