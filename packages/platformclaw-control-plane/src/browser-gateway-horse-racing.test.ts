import { describe, expect, it, vi } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";
import {
  HORSE_RACING_RPC,
  HorseRacingError,
  type HorseRacingStore,
} from "./horse-racing-contracts.js";

describe("authenticated racing browser boundary", () => {
  it("pins identity and rejects foreign identities and secret parameters before dispatch", async () => {
    const game = {
      snapshot: vi.fn<HorseRacingStore["snapshot"]>(),
      placeBet: vi.fn<HorseRacingStore["placeBet"]>(),
      cancelBet: vi.fn<HorseRacingStore["cancelBet"]>(),
      advance: vi.fn(),
    };
    const { proxy, token, user, request } = await setup({ racingStore: game });
    await proxy.request(token, HORSE_RACING_RPC.snapshot, {});
    expect(game.snapshot).toHaveBeenCalledWith(user.id, 1_000_000, undefined);
    for (const foreign of [
      { userId: "another-user" },
      { seed: "chosen-winner" },
      { startsAt: 0 },
    ]) {
      await expect(proxy.request(token, HORSE_RACING_RPC.snapshot, foreign)).rejects.toMatchObject({
        code: "method-not-allowed",
      });
    }
    const bet = {
      requestId: "ticket-1",
      raceId: "race-1",
      market: "win",
      selection: ["1"],
      amount: 50,
    };
    await proxy.request(token, HORSE_RACING_RPC.bet, bet);
    expect(game.placeBet).toHaveBeenCalledWith(user.id, bet, 1_000_000);
    const topThreeBet = {
      ...bet,
      requestId: "top-three",
      market: "quinella-place",
      selection: ["1", "2"],
    };
    await proxy.request(token, HORSE_RACING_RPC.bet, topThreeBet);
    expect(game.placeBet).toHaveBeenLastCalledWith(user.id, topThreeBet, 1_000_000);
    await proxy.request(token, HORSE_RACING_RPC.cancel, { betId: "ticket-1" });
    expect(game.cancelBet).toHaveBeenCalledWith(user.id, "ticket-1", 1_000_000);
    for (const foreign of [
      { betId: "ticket-1", userId: "another-user" },
      { betId: "ticket-1", now: 0 },
    ]) {
      await expect(proxy.request(token, HORSE_RACING_RPC.cancel, foreign)).rejects.toMatchObject({
        code: "method-not-allowed",
      });
    }
    expect(game.cancelBet).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    vi.mocked(game.placeBet).mockImplementationOnce(() => {
      throw new HorseRacingError("betting_closed", "베팅 마감");
    });
    await expect(proxy.request(token, HORSE_RACING_RPC.bet, bet)).rejects.toMatchObject({
      code: "invalid-params",
      message: "베팅 마감",
    });
    vi.mocked(game.cancelBet).mockImplementationOnce(() => {
      throw new HorseRacingError("betting_closed", "취소 마감");
    });
    await expect(
      proxy.request(token, HORSE_RACING_RPC.cancel, { betId: "ticket-1" }),
    ).rejects.toMatchObject({ code: "invalid-params", message: "취소 마감" });
  });

  it("keeps the racing clock separate from session authentication", async () => {
    const virtualNow = Date.parse("2026-10-15T11:00:00+09:00");
    const game = { snapshot: vi.fn(), placeBet: vi.fn(), cancelBet: vi.fn(), advance: vi.fn() };
    const { proxy, token, user } = await setup({ racingStore: game, racingNow: () => virtualNow });
    await proxy.request(token, HORSE_RACING_RPC.snapshot, {});
    expect(game.snapshot).toHaveBeenCalledWith(user.id, virtualNow, undefined);
    await proxy.request(token, HORSE_RACING_RPC.cancel, { betId: "ticket-1" });
    expect(game.cancelBet).toHaveBeenCalledWith(user.id, "ticket-1", virtualNow);
  });

  it("rejects an expired session before accessing a wallet or race", async () => {
    let now = 1_000_000;
    const game = { snapshot: vi.fn(), placeBet: vi.fn(), cancelBet: vi.fn(), advance: vi.fn() };
    const { proxy, token } = await setup({ racingStore: game, now: () => now });
    now += 24 * 3_600_000;
    await expect(proxy.request(token, HORSE_RACING_RPC.snapshot, {})).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(game.snapshot).not.toHaveBeenCalled();
    await expect(
      proxy.request(token, HORSE_RACING_RPC.cancel, { betId: "ticket-1" }),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    expect(game.cancelBet).not.toHaveBeenCalled();
  });

  it("validates cancellation IDs before accessing the store", async () => {
    const game = { snapshot: vi.fn(), placeBet: vi.fn(), cancelBet: vi.fn(), advance: vi.fn() };
    const { proxy, token } = await setup({ racingStore: game });
    for (const betId of [undefined, "", " ", "x".repeat(129), 1, null]) {
      await expect(proxy.request(token, HORSE_RACING_RPC.cancel, { betId })).rejects.toMatchObject({
        code: "invalid-params",
      });
    }
    expect(game.cancelBet).not.toHaveBeenCalled();
  });
});
