import { describe, expect, it } from "vitest";
import {
  BASEBALL_BATS,
  BASEBALL_KBO_TEAM_IDS,
  BASEBALL_RPC,
  BASEBALL_TEAM_CHANGE_COST,
  BaseballGameError,
  isBaseballKboTeamId,
  isBaseballRpcMethod,
  type BaseballAtBat,
  type BaseballEnhancementOutcome,
} from "./baseball-contracts.js";
import {
  BASEBALL_ENHANCEMENT_MAX_LEVEL,
  BASEBALL_ENHANCEMENT_RECOVERY_COST,
  BASEBALL_ENHANCEMENT_RULES,
  BASEBALL_ENHANCEMENT_RULE_VERSION,
  getBaseballEnhancementAppearance,
  getBaseballEnhancementRule,
  resolveBaseballAtBatPower,
  resolveBaseballEnhancement,
} from "./baseball-enhancement.js";
import { advanceBattedBall, createBattedBall } from "./baseball-simulation.js";

function enhancedPower(level: number, timingDeltaMs: number): number {
  return resolveBaseballAtBatPower(
    {
      batId: "wood",
      enhancementLevel: level,
      powerRuleVersion: BASEBALL_ENHANCEMENT_RULE_VERSION,
    },
    timingDeltaMs,
  );
}

function simulate(level: number, timingDeltaMs: number) {
  return advanceBattedBall(
    createBattedBall({
      timingDeltaMs,
      batPower: enhancedPower(level, timingDeltaMs),
    }),
    30_000,
  ).result!;
}

describe("baseball enhancement rules", () => {
  it("preserves the approved costs, integer probabilities, and drop landings at all 20 targets", () => {
    expect(BASEBALL_ENHANCEMENT_MAX_LEVEL).toBe(20);
    expect(BASEBALL_ENHANCEMENT_RECOVERY_COST).toBe(15_000);
    expect(
      BASEBALL_ENHANCEMENT_RULES.map((rule) => [
        rule.targetLevel,
        rule.costGold,
        rule.success,
        rule.maintain,
        rule.drop,
        rule.dropTo,
        rule.destroy,
        rule.totalDestroy,
      ]),
    ).toEqual([
      [1, 100, 9975, 25, 0, null, 0, 0],
      [2, 150, 9450, 550, 0, null, 0, 0],
      [3, 200, 8925, 1075, 0, null, 0, 0],
      [4, 300, 8925, 525, 500, 2, 0, 50],
      [5, 450, 8400, 950, 600, 3, 0, 50],
      [6, 650, 7875, 1275, 800, 4, 0, 50],
      [7, 900, 7350, 1575, 1000, 5, 0, 75],
      [8, 1250, 6825, 1900, 1200, 6, 0, 75],
      [9, 1750, 6300, 2225, 1400, 7, 0, 75],
      [10, 2500, 5775, 2625, 1500, 8, 0, 100],
      [11, 3200, 5250, 3150, 1500, 9, 0, 100],
      [12, 4000, 4725, 3675, 1500, 10, 0, 100],
      [13, 5000, 4200, 4175, 1500, 11, 0, 125],
      [14, 6500, 3675, 4700, 1500, 12, 0, 125],
      [15, 8500, 3150, 5225, 1500, 13, 0, 125],
      [16, 10000, 3150, 6000, 500, 14, 200, 150],
      [17, 12000, 3150, 6000, 500, 15, 200, 150],
      [18, 15000, 2000, 6800, 500, 15, 500, 200],
      [19, 18000, 2000, 6800, 500, 16, 500, 200],
      [20, 20000, 2000, 6700, 500, 17, 600, 200],
    ]);
  });

  it.each(BASEBALL_ENHANCEMENT_RULES)(
    "maps every +$targetLevel roll to exactly one approved outcome",
    (rule) => {
      const buckets = [
        ["success", rule.success],
        ["maintain", rule.maintain],
        ["drop", rule.drop],
        ["destroy", rule.destroy],
        ["total_destroy", rule.totalDestroy],
      ] as const;
      expect(buckets.reduce((sum, [, weight]) => sum + weight, 0)).toBe(10_000);
      let boundary = 0;
      for (const [outcome, weight] of buckets) {
        expect(Number.isInteger(weight)).toBe(true);
        if (weight > 0) {
          expect(resolveBaseballEnhancement(rule.targetLevel, boundary)).toBe(outcome);
          expect(resolveBaseballEnhancement(rule.targetLevel, boundary + weight - 1)).toBe(outcome);
        }
        boundary += weight;
      }
      const counts: Record<BaseballEnhancementOutcome, number> = {
        success: 0,
        maintain: 0,
        drop: 0,
        destroy: 0,
        total_destroy: 0,
      };
      for (let roll = 0; roll < 10_000; roll += 1) {
        counts[resolveBaseballEnhancement(rule.targetLevel, roll)] += 1;
      }
      expect(counts).toEqual(Object.fromEntries(buckets));
      expect(getBaseballEnhancementRule(rule.targetLevel)).toEqual(rule);
    },
  );

  it.each([-1, 0, 1.5, 21, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid target %s",
    (target) => {
      expect(() => getBaseballEnhancementRule(target)).toThrow(BaseballGameError);
      expect(() => resolveBaseballEnhancement(target, 0)).toThrow(BaseballGameError);
    },
  );

  it.each([-1, 0.5, 10000, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid integer roll %s",
    (roll) => {
      expect(() => resolveBaseballEnhancement(1, roll)).toThrow(BaseballGameError);
    },
  );
});

describe("enhanced bat power and snapshots", () => {
  it.each([0, 1, 5, 10, 11, 15, 20])("limits +%i power to the approved sweet spot", (level) => {
    const bonus = (0.1 * Math.min(level, 10)) / 10 + (0.02 * Math.max(level - 10, 0)) / 10;
    expect(enhancedPower(level, 0)).toBeCloseTo(1 + bonus, 12);
    expect(enhancedPower(level, -12.5)).toBeCloseTo(1 + bonus * 0.5625, 12);
    expect(enhancedPower(level, 12.5)).toBe(enhancedPower(level, -12.5));
    for (const delta of [-100, -50, -25, 25, 50, 100]) {
      expect(enhancedPower(level, delta)).toBe(1);
    }
  });

  it("strengthens centered +20 contact without turning every Perfect input into a home run", () => {
    expect(enhancedPower(20, 0)).toBeCloseTo(1.12, 12);
    expect(simulate(20, 0).kind).toBe("HOME_RUN");
    expect(simulate(20, 0).distanceM).toBeGreaterThan(simulate(0, 0).distanceM);
    for (let level = 0; level <= BASEBALL_ENHANCEMENT_MAX_LEVEL; level += 1) {
      // Zero sweet-spot bonus at the inclusive Perfect edges preserves baseline physics, including catches.
      expect(simulate(level, -25)).toEqual(simulate(0, -25));
      expect(simulate(level, 25)).toEqual(simulate(0, 25));
    }
    const outcomes = Array.from({ length: 501 }, (_, index) => simulate(20, -25 + index / 10).kind);
    expect(outcomes).toContain("HOME_RUN");
    expect(outcomes).toContain("HIT");
    expect(outcomes).toContain("OUT");
  });

  it.each([-1, 0.5, 21, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid level %s",
    (level) => {
      expect(() => enhancedPower(level, 0)).toThrow(BaseballGameError);
      expect(() => getBaseballEnhancementAppearance(level)).toThrow(BaseballGameError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects nonfinite timing %s",
    (delta) => {
      expect(() => enhancedPower(20, delta)).toThrow(BaseballGameError);
    },
  );

  it("uses the issued enhancement snapshot independently of its visual material", () => {
    const snapshot = {
      batId: "diamond",
      enhancementLevel: 20,
      powerRuleVersion: BASEBALL_ENHANCEMENT_RULE_VERSION,
    } as const;
    expect(resolveBaseballAtBatPower(snapshot, 0)).toBeCloseTo(1.12, 12);
    expect(resolveBaseballAtBatPower(snapshot, -25)).toBe(1);
    expect(resolveBaseballAtBatPower(snapshot, 25)).toBe(1);
    for (const bat of BASEBALL_BATS) {
      expect(resolveBaseballAtBatPower({ batId: bat.id }, 25)).toBe(bat.exitVelocityMultiplier);
    }
  });

  it("rejects incomplete or unsupported snapshots instead of using a legacy multiplier", () => {
    for (const snapshot of [
      { batId: "diamond", enhancementLevel: 20 },
      { batId: "diamond", powerRuleVersion: BASEBALL_ENHANCEMENT_RULE_VERSION },
      {
        batId: "diamond",
        enhancementLevel: 21,
        powerRuleVersion: BASEBALL_ENHANCEMENT_RULE_VERSION,
      },
      { batId: "diamond", enhancementLevel: 20, powerRuleVersion: "future-rule" },
    ]) {
      expect(() => resolveBaseballAtBatPower(snapshot as BaseballAtBat, 0)).toThrow(
        BaseballGameError,
      );
    }
  });
});

describe("enhanced bat appearance and team contract", () => {
  it.each([
    [0, "wood", "나무"],
    [2, "wood", "나무"],
    [3, "silver", "실버"],
    [5, "silver", "실버"],
    [6, "gold", "골드"],
    [8, "gold", "골드"],
    [9, "platinum", "플래티넘"],
    [11, "platinum", "플래티넘"],
    [12, "titanium", "티타늄"],
    [14, "titanium", "티타늄"],
    [15, "emerald", "에메랄드"],
    [17, "emerald", "에메랄드"],
    [18, "diamond", "다이아"],
    [19, "diamond", "다이아"],
    [20, "star-diamond", "스타 다이아"],
  ] as const)("evolves +%i at its threshold", (level, appearanceId, name) => {
    expect(getBaseballEnhancementAppearance(level)).toEqual({
      batId: appearanceId === "star-diamond" ? "diamond" : appearanceId,
      appearanceId,
      name,
    });
  });

  it("accepts exactly the ten KBO team IDs and exposes all mutation methods", () => {
    expect(BASEBALL_KBO_TEAM_IDS).toEqual([
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
    ]);
    expect(BASEBALL_TEAM_CHANGE_COST).toBe(2_000);
    for (const teamId of BASEBALL_KBO_TEAM_IDS) {
      expect(isBaseballKboTeamId(teamId)).toBe(true);
    }
    for (const value of ["neutral", "KIA", "", null, undefined, 1]) {
      expect(isBaseballKboTeamId(value)).toBe(false);
    }
    for (const key of ["enhanceBat", "recoverBat", "equipEnhancedBat", "selectTeam"] as const) {
      expect(BASEBALL_RPC[key]).toBe(`platformclaw.baseball.${key}`);
      expect(isBaseballRpcMethod(BASEBALL_RPC[key])).toBe(true);
    }
  });
});
