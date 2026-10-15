import {
  BaseballGameError,
  getBaseballBatDefinition,
  type BaseballAtBat,
  type BaseballBatId,
  type BaseballEnhancementOutcome,
} from "./baseball-contracts.js";

export const BASEBALL_ENHANCEMENT_RULE_VERSION = "sweetspot-v1";
const BASEBALL_ENHANCEMENT_BASIS_POINTS = 10_000;
export const BASEBALL_ENHANCEMENT_RECOVERY_COST = 15_000;
export const BASEBALL_ENHANCEMENT_MAX_LEVEL = 20;

type BaseballEnhancementRule = {
  targetLevel: number;
  costGold: number;
  success: number;
  maintain: number;
  drop: number;
  dropTo: number | null;
  destroy: number;
  totalDestroy: number;
};

// Integer basis points keep the five mutually exclusive outcomes exact, including 0.25%.
export const BASEBALL_ENHANCEMENT_RULES = [
  {
    targetLevel: 1,
    costGold: 100,
    success: 9975,
    maintain: 25,
    drop: 0,
    dropTo: null,
    destroy: 0,
    totalDestroy: 0,
  },
  {
    targetLevel: 2,
    costGold: 150,
    success: 9450,
    maintain: 550,
    drop: 0,
    dropTo: null,
    destroy: 0,
    totalDestroy: 0,
  },
  {
    targetLevel: 3,
    costGold: 200,
    success: 8925,
    maintain: 1075,
    drop: 0,
    dropTo: null,
    destroy: 0,
    totalDestroy: 0,
  },
  {
    targetLevel: 4,
    costGold: 300,
    success: 8925,
    maintain: 525,
    drop: 500,
    dropTo: 2,
    destroy: 0,
    totalDestroy: 50,
  },
  {
    targetLevel: 5,
    costGold: 450,
    success: 8400,
    maintain: 950,
    drop: 600,
    dropTo: 3,
    destroy: 0,
    totalDestroy: 50,
  },
  {
    targetLevel: 6,
    costGold: 650,
    success: 7875,
    maintain: 1275,
    drop: 800,
    dropTo: 4,
    destroy: 0,
    totalDestroy: 50,
  },
  {
    targetLevel: 7,
    costGold: 900,
    success: 7350,
    maintain: 1575,
    drop: 1000,
    dropTo: 5,
    destroy: 0,
    totalDestroy: 75,
  },
  {
    targetLevel: 8,
    costGold: 1250,
    success: 6825,
    maintain: 1900,
    drop: 1200,
    dropTo: 6,
    destroy: 0,
    totalDestroy: 75,
  },
  {
    targetLevel: 9,
    costGold: 1750,
    success: 6300,
    maintain: 2225,
    drop: 1400,
    dropTo: 7,
    destroy: 0,
    totalDestroy: 75,
  },
  {
    targetLevel: 10,
    costGold: 2500,
    success: 5775,
    maintain: 2625,
    drop: 1500,
    dropTo: 8,
    destroy: 0,
    totalDestroy: 100,
  },
  {
    targetLevel: 11,
    costGold: 3200,
    success: 5250,
    maintain: 3150,
    drop: 1500,
    dropTo: 9,
    destroy: 0,
    totalDestroy: 100,
  },
  {
    targetLevel: 12,
    costGold: 4000,
    success: 4725,
    maintain: 3675,
    drop: 1500,
    dropTo: 10,
    destroy: 0,
    totalDestroy: 100,
  },
  {
    targetLevel: 13,
    costGold: 5000,
    success: 4200,
    maintain: 4175,
    drop: 1500,
    dropTo: 11,
    destroy: 0,
    totalDestroy: 125,
  },
  {
    targetLevel: 14,
    costGold: 6500,
    success: 3675,
    maintain: 4700,
    drop: 1500,
    dropTo: 12,
    destroy: 0,
    totalDestroy: 125,
  },
  {
    targetLevel: 15,
    costGold: 8500,
    success: 3150,
    maintain: 5225,
    drop: 1500,
    dropTo: 13,
    destroy: 0,
    totalDestroy: 125,
  },
  {
    targetLevel: 16,
    costGold: 10000,
    success: 3150,
    maintain: 6000,
    drop: 500,
    dropTo: 14,
    destroy: 200,
    totalDestroy: 150,
  },
  {
    targetLevel: 17,
    costGold: 12000,
    success: 3150,
    maintain: 6000,
    drop: 500,
    dropTo: 15,
    destroy: 200,
    totalDestroy: 150,
  },
  {
    targetLevel: 18,
    costGold: 15000,
    success: 2000,
    maintain: 6800,
    drop: 500,
    dropTo: 15,
    destroy: 500,
    totalDestroy: 200,
  },
  {
    targetLevel: 19,
    costGold: 18000,
    success: 2000,
    maintain: 6800,
    drop: 500,
    dropTo: 16,
    destroy: 500,
    totalDestroy: 200,
  },
  {
    targetLevel: 20,
    costGold: 20000,
    success: 2000,
    maintain: 6700,
    drop: 500,
    dropTo: 17,
    destroy: 600,
    totalDestroy: 200,
  },
] as const satisfies readonly BaseballEnhancementRule[];

function isBaseballEnhancementLevel(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= BASEBALL_ENHANCEMENT_MAX_LEVEL
  );
}

export function getBaseballEnhancementRule(targetLevel: number): BaseballEnhancementRule {
  const rule = BASEBALL_ENHANCEMENT_RULES[targetLevel - 1];
  if (!Number.isInteger(targetLevel) || !rule) {
    throw new BaseballGameError(
      "invalid_enhancement",
      "Enhancement target must be between +1 and +20",
    );
  }
  return rule;
}

export function resolveBaseballEnhancement(
  targetLevel: number,
  rollBasisPoints: number,
): BaseballEnhancementOutcome {
  const rule = getBaseballEnhancementRule(targetLevel);
  if (
    !Number.isInteger(rollBasisPoints) ||
    rollBasisPoints < 0 ||
    rollBasisPoints >= BASEBALL_ENHANCEMENT_BASIS_POINTS
  ) {
    throw new BaseballGameError(
      "invalid_enhancement",
      "Enhancement roll must be an integer from 0 to 9999",
    );
  }
  let remaining = rollBasisPoints;
  for (const [outcome, weight] of [
    ["success", rule.success],
    ["maintain", rule.maintain],
    ["drop", rule.drop],
    ["destroy", rule.destroy],
    ["total_destroy", rule.totalDestroy],
  ] as const) {
    if (remaining < weight) {
      return outcome;
    }
    remaining -= weight;
  }
  throw new BaseballGameError(
    "invalid_enhancement",
    "Enhancement probabilities must total 10000 basis points",
  );
}

function getBaseballEnhancementPower(level: number, timingDeltaMs: number): number {
  if (!isBaseballEnhancementLevel(level) || !Number.isFinite(timingDeltaMs)) {
    throw new BaseballGameError(
      "invalid_enhancement",
      "Enhancement requires a level from +0 to +20 and finite timing",
    );
  }
  const sweet = Math.max(0, 1 - (Math.abs(timingDeltaMs) / 25) ** 2) ** 2;
  const bonus = (0.1 * Math.min(level, 10)) / 10 + (0.02 * Math.max(level - 10, 0)) / 10;
  return 1 + bonus * sweet;
}

const ENHANCEMENT_APPEARANCES = [
  { minLevel: 0, batId: "wood", appearanceId: "wood", name: "나무" },
  { minLevel: 3, batId: "silver", appearanceId: "silver", name: "실버" },
  { minLevel: 6, batId: "gold", appearanceId: "gold", name: "골드" },
  { minLevel: 9, batId: "platinum", appearanceId: "platinum", name: "플래티넘" },
  { minLevel: 12, batId: "titanium", appearanceId: "titanium", name: "티타늄" },
  { minLevel: 15, batId: "emerald", appearanceId: "emerald", name: "에메랄드" },
  { minLevel: 18, batId: "diamond", appearanceId: "diamond", name: "다이아" },
  { minLevel: 20, batId: "diamond", appearanceId: "star-diamond", name: "스타 다이아" },
] as const satisfies readonly {
  minLevel: number;
  batId: BaseballBatId;
  appearanceId: string;
  name: string;
}[];

export function getBaseballEnhancementAppearance(level: number) {
  if (!isBaseballEnhancementLevel(level)) {
    throw new BaseballGameError(
      "invalid_enhancement",
      "Enhancement level must be between +0 and +20",
    );
  }
  const { batId, appearanceId, name } = ENHANCEMENT_APPEARANCES.findLast(
    (entry) => level >= entry.minLevel,
  )!;
  return { batId, appearanceId, name };
}

export function resolveBaseballAtBatPower(
  atBat: Pick<BaseballAtBat, "batId" | "enhancementLevel" | "powerRuleVersion">,
  timingDeltaMs: number,
): number {
  if (atBat.enhancementLevel !== undefined || atBat.powerRuleVersion !== undefined) {
    // Reject incomplete snapshots instead of silently applying an owned legacy bat's stronger multiplier.
    if (
      atBat.powerRuleVersion !== BASEBALL_ENHANCEMENT_RULE_VERSION ||
      atBat.enhancementLevel === undefined
    ) {
      throw new BaseballGameError(
        "invalid_enhancement",
        "At-bat has an invalid enhancement snapshot; start a new at-bat",
      );
    }
    return getBaseballEnhancementPower(atBat.enhancementLevel, timingDeltaMs);
  }
  const bat = getBaseballBatDefinition(atBat.batId);
  if (!bat) {
    throw new BaseballGameError("unknown_bat", "At-bat has an unknown bat; start a new at-bat");
  }
  return bat.exitVelocityMultiplier;
}
