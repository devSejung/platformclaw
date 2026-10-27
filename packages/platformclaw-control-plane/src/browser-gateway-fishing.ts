import { BrowserGatewayProxyError } from "./browser-gateway-contracts.js";
import {
  FISHING_RPC,
  FishingError,
  type FishingRequest,
  type FishingStore,
} from "./fishing-contracts.js";

function requestString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) {
    throw new FishingError(
      "invalid_request",
      `${field} 값이 올바르지 않습니다. 새로고침 후 다시 시도하세요.`,
    );
  }
  return value;
}

function parseFishingMutation(method: string, params: Record<string, unknown>): FishingRequest {
  const requestId = requestString(params.requestId, "요청 번호");
  if (method === FISHING_RPC.begin) {
    return { action: "begin", requestId };
  }
  if (method === FISHING_RPC.finish) {
    return { action: "finish", requestId, attemptId: requestString(params.attemptId, "낚시 번호") };
  }
  if (method === FISHING_RPC.hook || method === FISHING_RPC.settle) {
    return {
      action: method === FISHING_RPC.hook ? "hook" : "settle",
      requestId,
      attemptId: requestString(params.attemptId, "낚시 번호"),
    };
  }
  if (method === FISHING_RPC.reel) {
    if (typeof params.held !== "boolean") {
      throw new FishingError("invalid_request", "누르기 또는 놓기를 입력하세요.");
    }
    return {
      action: "reel",
      requestId,
      attemptId: requestString(params.attemptId, "낚시 번호"),
      held: params.held,
    };
  }
  throw new FishingError("invalid_request", "낚시 입력을 확인하세요.");
}

export function requestBrowserFishing(params: {
  store?: FishingStore;
  userId: string;
  method: string;
  request: Record<string, unknown>;
  now: number;
}): { handled: false } | { handled: true; result: unknown } {
  if (!Object.values(FISHING_RPC).some((method) => method === params.method)) {
    return { handled: false };
  }
  if (!params.store) {
    throw new BrowserGatewayProxyError(
      "method-not-allowed",
      "낚시 저장 서비스를 사용할 수 없습니다. 관리자에게 문의하세요.",
    );
  }
  try {
    if (params.method === FISHING_RPC.snapshot) {
      return { handled: true, result: params.store.loadFishingSnapshot(params.userId, params.now) };
    }
    if (params.method === FISHING_RPC.leaderboard) {
      return { handled: true, result: params.store.loadFishingLeaderboard(params.userId) };
    }
    return {
      handled: true,
      result: params.store.executeFishing(
        params.userId,
        parseFishingMutation(params.method, params.request),
        params.now,
      ),
    };
  } catch (error) {
    if (error instanceof FishingError) {
      throw new BrowserGatewayProxyError("invalid-params", error.message);
    }
    throw error;
  }
}
