import {
  BASEBALL_RPC,
  BaseballGameError,
  isBaseballBatId,
  isBaseballRpcMethod,
  type BaseballGameStore,
  type BaseballPlateAppearanceOutcome,
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

function plateAppearanceOutcome(value: unknown): BaseballPlateAppearanceOutcome {
  if (value === "home_run" || value === "hit" || value === "out" || value === "miss") {
    return value;
  }
  throw new BrowserGatewayProxyError(
    "invalid-params",
    "baseball outcome must be home_run, hit, out, or miss",
  );
}

function optionalDistance(
  value: unknown,
  outcome: BaseballPlateAppearanceOutcome,
): number | undefined {
  if (outcome === "out" || outcome === "miss") {
    return undefined;
  }
  if (value === undefined) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "baseball distanceM is required for a hit or home run",
    );
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000) {
    throw new BrowserGatewayProxyError(
      "invalid-params",
      "baseball distanceM must be an integer from 0 to 1000 for a hit or home run",
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
    if (params.method === BASEBALL_RPC.plateAppearance) {
      const requestId = requiredRequestId(params.request.requestId);
      const outcome = plateAppearanceOutcome(params.request.outcome);
      const distanceM = optionalDistance(params.request.distanceM, outcome);
      return {
        handled: true,
        result: await params.store.rewardBaseballPlateAppearance({
          userId: params.userId,
          requestId,
          outcome,
          ...(distanceM === undefined ? {} : { distanceM }),
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
