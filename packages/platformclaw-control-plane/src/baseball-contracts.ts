// Retain material IDs and historical prices for stored ownership and purchase receipts.
export const BASEBALL_BATS = [
  { id: "wood", price: 0 },
  { id: "silver", price: 50 },
  { id: "gold", price: 200 },
  { id: "platinum", price: 500 },
  { id: "titanium", price: 1_000 },
  { id: "emerald", price: 2_000 },
  { id: "diamond", price: 4_000 },
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

export const BASEBALL_KBO_TEAM_IDS = [
  "kia",
  "kt",
  "lg",
  "nc",
  "ssg",
  "doosan",
  "lotte",
  "samsung",
  "kiwoom",
  "hanwha",
] as const;

export type BaseballKboTeamId = (typeof BASEBALL_KBO_TEAM_IDS)[number];
export const BASEBALL_TEAM_CHANGE_COST = 2_000;

export function isBaseballKboTeamId(value: unknown): value is BaseballKboTeamId {
  return BASEBALL_KBO_TEAM_IDS.some((teamId) => teamId === value);
}

export const BASEBALL_RPC_METHODS = [
  "platformclaw.baseball.progress",
  "platformclaw.baseball.plateAppearance",
  "platformclaw.baseball.purchaseBat",
  "platformclaw.baseball.equipBat",
  "platformclaw.baseball.leaderboard",
  "platformclaw.baseball.beginAtBat",
  "platformclaw.baseball.enhanceBat",
  "platformclaw.baseball.recoverBat",
  "platformclaw.baseball.equipEnhancedBat",
  "platformclaw.baseball.selectTeam",
] as const;

export type BaseballRpcMethod = (typeof BASEBALL_RPC_METHODS)[number];

export const BASEBALL_RPC = {
  progress: BASEBALL_RPC_METHODS[0],
  plateAppearance: BASEBALL_RPC_METHODS[1],
  purchaseBat: BASEBALL_RPC_METHODS[2],
  equipBat: BASEBALL_RPC_METHODS[3],
  leaderboard: BASEBALL_RPC_METHODS[4],
  beginAtBat: BASEBALL_RPC_METHODS[5],
  enhanceBat: BASEBALL_RPC_METHODS[6],
  recoverBat: BASEBALL_RPC_METHODS[7],
  equipEnhancedBat: BASEBALL_RPC_METHODS[8],
  selectTeam: BASEBALL_RPC_METHODS[9],
} as const;

const BASEBALL_RPC_METHOD_SET = new Set<string>(BASEBALL_RPC_METHODS);

export function isBaseballRpcMethod(method: string): method is BaseballRpcMethod {
  return BASEBALL_RPC_METHOD_SET.has(method);
}

export type BaseballPlateAppearanceOutcome = "home_run" | "hit" | "out" | "miss";

export type BaseballEnhancementState = {
  level: number;
  status: "ready" | "broken";
  equipped: boolean;
  version: 1;
};

export type BaseballProgress = {
  gold: number;
  ownedBatIds: BaseballBatId[];
  equippedBatId: BaseballBatId;
  totalHomers: number;
  bestDistanceM: number;
  currentHomeRunStreak: number;
  bestHomeRunStreak: number;
  revision: number;
  /** Current progress always includes this; older immutable receipts may omit it. */
  enhancement?: BaseballEnhancementState;
  teamId?: BaseballKboTeamId | null;
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
  atBatId: string;
  timingDeltaMs: number | null;
};

export type BaseballAtBat = {
  id: string;
  pitchSample: number;
  batId: BaseballBatId;
  issuedAt: number;
  expiresAt: number;
  enhancementLevel?: number;
  powerRuleVersion?: "sweetspot-v1";
};

export type BaseballPlateAppearanceResult = {
  awardedGold: number;
  /** Older immutable receipts may omit this or retain the historical 5G bonus. */
  homeRunBonusGold?: 0 | 5 | 10;
  /** Absent on receipts issued before the three-home-run streak bonus. */
  homeRunStreakBonusGold?: 0 | 10;
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

export type BaseballEnhancementOutcome =
  | "success"
  | "maintain"
  | "drop"
  | "destroy"
  | "total_destroy";

export type BaseballEnhanceBatRequest = {
  requestId: string;
  expectedRevision: number;
};

export type BaseballEnhanceBatResult = {
  requestId: string;
  outcome: BaseballEnhancementOutcome;
  fromLevel: number;
  targetLevel: number;
  level: number;
  chargedGold: number;
  evolved: boolean;
  automaticRestart: boolean;
  progress: BaseballProgress;
};

export type BaseballRecoverBatRequest = {
  requestId: string;
  expectedRevision: number;
  action: "restore" | "restart";
};

export type BaseballRecoverBatResult = {
  requestId: string;
  outcome: "restored" | "restarted";
  chargedGold: number;
  progress: BaseballProgress;
};

export type BaseballEquipEnhancedBatRequest = {
  requestId: string;
  expectedRevision: number;
};

export type BaseballEquipEnhancedBatResult = {
  requestId: string;
  changed: boolean;
  progress: BaseballProgress;
};

export type BaseballSelectTeamRequest = {
  requestId: string;
  expectedRevision: number;
  teamId: BaseballKboTeamId;
};

export type BaseballSelectTeamResult = {
  requestId: string;
  teamId: BaseballKboTeamId;
  changed: boolean;
  chargedGold: number;
  progress: BaseballProgress;
};

export type BaseballGameErrorCode =
  | "idempotency_conflict"
  | "legacy_purchase_closed"
  | "legacy_bat_closed"
  | "unknown_bat"
  | "insufficient_gold"
  | "bat_not_owned"
  | "at_bat_unavailable"
  | "at_bat_consumed"
  | "at_bat_expired"
  | "at_bat_too_early"
  | "at_bat_rate_limited"
  | "invalid_swing"
  | "stale_progress"
  | "enhancement_max"
  | "bat_broken"
  | "bat_not_broken"
  | "invalid_enhancement"
  | "invalid_team";

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
  beginBaseballAtBat(params: {
    userId: string;
    requestId: string;
    now: number;
  }): Promise<BaseballAtBat>;
  rewardBaseballPlateAppearance(params: {
    userId: string;
    requestId: string;
    /** Trusted in-process callers only; browser requests require a server-issued at-bat. */
    outcome?: BaseballPlateAppearanceOutcome;
    distanceM?: number;
    atBatId?: string;
    timingDeltaMs?: number | null;
    now?: number;
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
  enhanceBaseballBat(
    params: BaseballEnhanceBatRequest & { userId: string },
  ): Promise<BaseballEnhanceBatResult>;
  recoverBaseballBat(
    params: BaseballRecoverBatRequest & { userId: string },
  ): Promise<BaseballRecoverBatResult>;
  equipEnhancedBaseballBat(
    params: BaseballEquipEnhancedBatRequest & { userId: string },
  ): Promise<BaseballEquipEnhancedBatResult>;
  selectBaseballTeam(
    params: BaseballSelectTeamRequest & { userId: string },
  ): Promise<BaseballSelectTeamResult>;
}
