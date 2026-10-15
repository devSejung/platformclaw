import {
  BASEBALL_RPC,
  BaseballGameError,
  isBaseballBatId,
  isBaseballRpcMethod,
  type BaseballGameStore,
} from "./baseball-contracts.js";
import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";

type JsonObject = Record<string, unknown>;

function requiredRequestId(value: unknown): string {
  if (typeof value !== "string") {
    throw new BrowserGatewayProxyError("invalid-params", "baseball requestId is required");
  }
  const requestId = value.trim();
  if (!requestId || requestId.length > 128) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "baseball requestId must be between 1 and 128 characters",
    );
  }
  return requestId;
}

function requiredAtBatId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "baseball atBatId is required; begin a new at-bat before submitting a swing",
    );
  }
  return value;
}

function swingTiming(value: unknown): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 2_000) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "baseball timingDeltaMs must be a number between -2000 and 2000, or null for a miss",
    );
  }
  return value;
}

function requiredBatId(value: unknown) {
  if (!isBaseballBatId(value)) {
    throw new BrowserGatewayProxyError("invalid-params", "baseball batId is invalid");
  }
  return value;
}

export async function requestBrowserBaseball(params: {
  store?: BaseballGameStore;
  userId: string;
  method: string;
  request: JsonObject;
  now?: number;
}): Promise<{ handled: false } | { handled: true; result: unknown }> {
  if (!isBaseballRpcMethod(params.method)) {
    return { handled: false };
  }
  if (!params.store) {
    throw new BrowserGatewayProxyError("method-not-allowed", "baseball game state is unavailable");
  }
  try {
    if (params.method === BASEBALL_RPC.progress) {
      return { handled: true, result: await params.store.loadBaseballProgress(params.userId) };
    }
    if (params.method === BASEBALL_RPC.leaderboard) {
      return { handled: true, result: await params.store.loadBaseballLeaderboard(params.userId) };
    }
    if (params.method === BASEBALL_RPC.beginAtBat) {
      return {
        handled: true,
        result: await params.store.beginBaseballAtBat({
          userId: params.userId,
          requestId: requiredRequestId(params.request.requestId),
          now: params.now ?? Date.now(),
        }),
      };
    }
    if (params.method === BASEBALL_RPC.plateAppearance) {
      const requestId = requiredRequestId(params.request.requestId);
      const atBatId = requiredAtBatId(params.request.atBatId);
      const timingDeltaMs = swingTiming(params.request.timingDeltaMs);
      return {
        handled: true,
        result: await params.store.rewardBaseballPlateAppearance({
          userId: params.userId,
          requestId,
          atBatId,
          timingDeltaMs,
          now: params.now ?? Date.now(),
        }),
      };
    }
    const requestId = requiredRequestId(params.request.requestId);
    const batId = requiredBatId(params.request.batId);
    if (params.method === BASEBALL_RPC.purchaseBat) {
      return {
        handled: true,
        result: await params.store.purchaseBaseballBat({ userId: params.userId, requestId, batId }),
      };
    }
    return {
      handled: true,
      result: await params.store.equipBaseballBat({ userId: params.userId, requestId, batId }),
    };
  } catch (error) {
    if (error instanceof BaseballGameError) {
      throw new BrowserGatewayProxyError("invalid-params", error.message);
    }
    throw error;
  }
}
