export const BASEBALL_BATS = [
  { id: "wood", price: 0, exitVelocityMultiplier: 1 },
  { id: "silver", price: 50, exitVelocityMultiplier: 1.04 },
  { id: "gold", price: 200, exitVelocityMultiplier: 1.08 },
  { id: "platinum", price: 500, exitVelocityMultiplier: 1.12 },
  { id: "titanium", price: 1_000, exitVelocityMultiplier: 1.16 },
  { id: "emerald", price: 2_000, exitVelocityMultiplier: 1.21 },
  { id: "diamond", price: 4_000, exitVelocityMultiplier: 1.27 },
] as const;

export type BaseballBatId = (typeof BASEBALL_BATS)[number]["id"];
export type BaseballBatDefinition = (typeof BASEBALL_BATS)[number];

export const BASEBALL_DEFAULT_BAT_ID: BaseballBatId = "wood";

export function getBaseballBatDefinition(batId: string): BaseballBatDefinition | undefined {
  return BASEBALL_BATS.find((bat) => bat.id === batId);
}

export function isBaseballBatId(value: unknown): value is BaseballBatId {
  return typeof value === "string" && getBaseballBatDefinition(value) !== undefined;
}

export const BASEBALL_RPC_METHODS = [
  "platformclaw.baseball.progress",
  "platformclaw.baseball.plateAppearance",
  "platformclaw.baseball.purchaseBat",
  "platformclaw.baseball.equipBat",
  "platformclaw.baseball.leaderboard",
] as const;

export type BaseballRpcMethod = (typeof BASEBALL_RPC_METHODS)[number];

export const BASEBALL_RPC = {
  progress: BASEBALL_RPC_METHODS[0],
  plateAppearance: BASEBALL_RPC_METHODS[1],
  purchaseBat: BASEBALL_RPC_METHODS[2],
  equipBat: BASEBALL_RPC_METHODS[3],
  leaderboard: BASEBALL_RPC_METHODS[4],
} as const;

const BASEBALL_RPC_METHOD_SET = new Set<string>(BASEBALL_RPC_METHODS);

export function isBaseballRpcMethod(method: string): method is BaseballRpcMethod {
  return BASEBALL_RPC_METHOD_SET.has(method);
}

export type BaseballPlateAppearanceOutcome = "home_run" | "hit" | "out" | "miss";

export type BaseballProgress = {
  gold: number;
  ownedBatIds: BaseballBatId[];
  equippedBatId: BaseballBatId;
  totalHomers: number;
  bestDistanceM: number;
  currentHomeRunStreak: number;
  bestHomeRunStreak: number;
  revision: number;
};

export type BaseballLeaderboardEntry = {
  displayName: string;
  value: number;
  isCurrentUser: boolean;
};

export type BaseballLeaderboard = {
  distance: BaseballLeaderboardEntry[];
  homeRunStreak: BaseballLeaderboardEntry[];
};

export type BaseballPlateAppearanceRequest = {
  requestId: string;
  outcome: BaseballPlateAppearanceOutcome;
  distanceM?: number;
};

export type BaseballPlateAppearanceResult = {
  awardedGold: number;
  progress: BaseballProgress;
};

export type BaseballPurchaseBatRequest = {
  requestId: string;
  batId: BaseballBatId;
};

export type BaseballPurchaseBatResult = {
  batId: BaseballBatId;
  price: number;
  purchased: boolean;
  progress: BaseballProgress;
};

export type BaseballEquipBatRequest = {
  requestId: string;
  batId: BaseballBatId;
};

export type BaseballEquipBatResult = {
  batId: BaseballBatId;
  changed: boolean;
  progress: BaseballProgress;
};

export type BaseballGameErrorCode =
  | "idempotency_conflict"
  | "unknown_bat"
  | "insufficient_gold"
  | "bat_not_owned";

export class BaseballGameError extends Error {
  constructor(
    readonly code: BaseballGameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BaseballGameError";
  }
}

export interface BaseballGameStore {
  loadBaseballProgress(userId: string): Promise<BaseballProgress>;
  loadBaseballLeaderboard(userId: string): Promise<BaseballLeaderboard>;
  rewardBaseballPlateAppearance(params: {
    userId: string;
    requestId: string;
    outcome: BaseballPlateAppearanceOutcome;
    distanceM?: number;
  }): Promise<BaseballPlateAppearanceResult>;
  purchaseBaseballBat(params: {
    userId: string;
    requestId: string;
    batId: BaseballBatId;
  }): Promise<BaseballPurchaseBatResult>;
  equipBaseballBat(params: {
    userId: string;
    requestId: string;
    batId: BaseballBatId;
  }): Promise<BaseballEquipBatResult>;
}
