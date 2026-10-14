import { BaseballGameError } from "./baseball-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import {
  HORSE_RACING_RPC,
  HorseRacingError,
  type HorseBetRequest,
  type HorseRacingStore,
} from "./horse-racing-contracts.js";

export function requestBrowserHorseRacing(params: {
  store?: HorseRacingStore;
  userId: string;
  method: string;
  request: Record<string, unknown>;
  now: number;
}): { handled: false } | { handled: true; result: unknown } {
  if (
    params.method !== HORSE_RACING_RPC.snapshot &&
    params.method !== HORSE_RACING_RPC.bet &&
    params.method !== HORSE_RACING_RPC.cancel
  ) {
    return { handled: false };
  }
  if (!params.store) {
    throw new BrowserGatewayProxyError("method-not-allowed", "경마 서비스를 사용할 수 없습니다.");
  }
  try {
    if (params.method === HORSE_RACING_RPC.cancel) {
      if (
        typeof params.request.betId !== "string" ||
        !params.request.betId.trim() ||
        params.request.betId.length > 128
      ) {
        throw new HorseRacingError("invalid_bet", "취소할 베팅표 번호가 올바르지 않습니다.");
      }
      return {
        handled: true,
        result: params.store.cancelBet(params.userId, params.request.betId, params.now),
      };
    }
    if (params.method === HORSE_RACING_RPC.snapshot) {
      if (
        params.request.raceId !== undefined &&
        (typeof params.request.raceId !== "string" || params.request.raceId.length > 128)
      ) {
        throw new HorseRacingError("invalid_race", "경주 번호가 올바르지 않습니다.");
      }
      return {
        handled: true,
        result: params.store.snapshot(
          params.userId,
          params.now,
          params.request.raceId as string | undefined,
        ),
      };
    }
    const request = params.request as unknown as HorseBetRequest;
    return { handled: true, result: params.store.placeBet(params.userId, request, params.now) };
  } catch (error) {
    if (error instanceof HorseRacingError || error instanceof BaseballGameError) {
      throw new BrowserGatewayProxyError("invalid-params", error.message);
    }
    throw error;
  }
}
