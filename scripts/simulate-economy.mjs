#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FISHING_SPECIES,
  FISHING_TOTAL_WEIGHT,
  chooseFishingCatch,
  createFishingRandom,
  getFishingSpecies,
  resolveFishingDifficulty,
  calculateFishingFinishRewardGold,
  calculateFishingRewardGold,
} from "../packages/platformclaw-control-plane/src/fishing-economy.ts";
import {
  FISHING_FIGHT_DURATION_MS,
  replayFishingFight,
  resolveFishingFinish,
} from "../packages/platformclaw-control-plane/src/fishing-simulation.ts";

const SEED = 20261027;
const CATCHES = 400_000;
const EXPECTED_BASE_PRICE = 15.4905;

function quantiles(values) {
  const sorted = values.toSorted((left, right) => left - right);
  return Object.fromEntries(
    [10, 50, 90].map((percent) => [
      "p" + percent,
      Math.round(sorted[Math.floor(((sorted.length - 1) * percent) / 100)] * 100) / 100,
    ]),
  );
}

function drawPoolSamples() {
  assert.equal(FISHING_TOTAL_WEIGHT, 40_000);
  assert.equal(FISHING_SPECIES.length, 40);
  const random = createFishingRandom(SEED);
  const counts = new Map(FISHING_SPECIES.map((fish) => [fish.id, 0]));
  let baseGold = 0;
  let rewardGold = 0;
  let perfectRewardGold = 0;
  let maximumPrecisionRewardGold = 0;
  for (let index = 0; index < CATCHES; index += 1) {
    const draw = random();
    const size = random();
    const goodSamples = [draw, size];
    const perfectSamples = [draw, size];
    const caught = chooseFishingCatch(() => goodSamples.shift(), "GOOD");
    const perfect = chooseFishingCatch(() => perfectSamples.shift(), "PERFECT");
    const species = getFishingSpecies(caught.fishId);
    baseGold += species.basePrice;
    rewardGold += caught.rewardGold;
    perfectRewardGold += perfect.rewardGold;
    maximumPrecisionRewardGold += calculateFishingFinishRewardGold(perfect.rewardGold, 1);
    counts.set(species.id, counts.get(species.id) + 1);
  }
  const observedBasePrice = baseGold / CATCHES;
  const relativeError = Math.abs(observedBasePrice / EXPECTED_BASE_PRICE - 1);
  assert.ok(relativeError <= 0.03, "Single-pool mean exceeds 3% error");
  return {
    conditionalCatches: CATCHES,
    totalWeight: FISHING_TOTAL_WEIGHT,
    expectedBasePrice: EXPECTED_BASE_PRICE,
    observedBasePrice,
    observedBaseCatchReward: rewardGold / CATCHES,
    observedPerfectHookReward: perfectRewardGold / CATCHES,
    observedMaximumPrecisionReward: maximumPrecisionRewardGold / CATCHES,
    relativeErrorPercent: Math.round(relativeError * 10_000) / 100,
    species: FISHING_SPECIES.map((fish) => ({
      fishId: fish.id,
      difficulty: fish.difficulty,
      probabilityWeight: fish.probabilityWeight,
      probability: fish.probabilityWeight / FISHING_TOTAL_WEIGHT,
      catches: counts.get(fish.id),
    })),
  };
}

function probeFightPolicies() {
  return FISHING_SPECIES.flatMap((fish) =>
    [0, 0.5, 1].map((size) => {
      const lengthCm = fish.lengthCm[0] + (fish.lengthCm[1] - fish.lengthCm[0]) * size;
      const difficulty = resolveFishingDifficulty(fish.id, lengthCm);
      const times = [];
      const escapeReasons = { line_broken: 0, slack: 0, timeout: 0 };
      let holdOnlyCatches = 0;
      let idleCatches = 0;
      let skilledCatches = 0;
      for (let seed = 1; seed <= 100; seed += 1) {
        const inputs = [{ atMs: 0, held: true }];
        let held = true;
        for (let atMs = 100; atMs < FISHING_FIGHT_DURATION_MS; atMs += 100) {
          const fight = replayFishingFight(seed * 307, difficulty, inputs, atMs, fish.behavior);
          if (fight.status !== "fighting") break;
          if ((held && fight.tension > 0.72) || (!held && fight.tension < 0.28)) {
            held = !held;
            inputs.push({ atMs, held });
          }
        }
        const result = replayFishingFight(
          seed * 307,
          difficulty,
          inputs,
          FISHING_FIGHT_DURATION_MS,
          fish.behavior,
        );
        skilledCatches += Number(result.status === "caught");
        if (result.escapeReason) escapeReasons[result.escapeReason] += 1;
        times.push(result.elapsedMs);
        const holdOnly = replayFishingFight(
          seed,
          difficulty,
          [{ atMs: 0, held: true }],
          FISHING_FIGHT_DURATION_MS,
          fish.behavior,
        );
        const idle = replayFishingFight(
          seed,
          difficulty,
          [],
          FISHING_FIGHT_DURATION_MS,
          fish.behavior,
        );
        holdOnlyCatches += Number(holdOnly.status === "caught");
        idleCatches += Number(idle.status === "caught");
        assert.equal(holdOnly.escapeReason, "line_broken");
        assert.equal(idle.escapeReason, "slack");
      }
      assert.equal(holdOnlyCatches, 0);
      assert.equal(idleCatches, 0);
      assert.ok(skilledCatches >= 80, fish.id + " size " + size + " must permit skilled play");
      return {
        fishId: fish.id,
        behavior: fish.behavior,
        size,
        lengthCm,
        difficulty,
        samples: 100,
        skilledCatches,
        holdOnlyCatches,
        idleCatches,
        escapeReasons,
        fightDurationMs: quantiles(times),
      };
    }),
  );
}

try {
  const report = {
    economyVersion: 1,
    seed: SEED,
    mode: "manual",
    reward: "base catch gold plus one server-timed finish accuracy bonus",
    notes: [
      "One theme and one pool contain all forty species.",
      "Integer weights preserve the original proportions; divide each by the total weight of 40000.",
      "Conditional base reward sampling excludes failed attempts and finish bonuses.",
      "Base prices are divided by 10; fractional values preserve species rank, with a minimum 1 G integer catch reward.",
      "The finish bonus applies once to the displayed integer base reward.",
      "Missed and expired finish timing preserves the base reward.",
      "PERFECT hook and perfect finish reward means are recorded separately from the GOOD base quote.",
      "Scripted policy outcomes do not estimate human success rates or hourly income.",
    ],
    rewardExamples: [
      "crucian",
      "minnow",
      "bass",
      "catfish",
      "tuna",
      "legendary-carp",
      "ancient-leviathan",
    ].map((fishId) => {
      const fish = getFishingSpecies(fishId);
      const good = calculateFishingRewardGold(fish.basePrice, 0.5, "GOOD");
      const perfect = calculateFishingRewardGold(fish.basePrice, 0.5, "PERFECT");
      return {
        fishId,
        basePrice: fish.basePrice,
        midpointGoodReward: good,
        midpointPerfectHookReward: perfect,
        midpointMaximumReward: calculateFishingFinishRewardGold(perfect, 1),
      };
    }),
    pool: drawPoolSamples(),
    fightPolicies: probeFightPolicies(),
    finishExamples: [0, 300, 600, 4000].map((elapsedMs) => {
      const outcome = resolveFishingFinish(0, elapsedMs);
      return {
        elapsedMs,
        ...outcome,
        baseGold: 100,
        rewardGold: calculateFishingFinishRewardGold(100, outcome.accuracy),
      };
    }),
  };
  const json = JSON.stringify(report, null, 2) + "\n";
  const outputIndex = process.argv.indexOf("--output");
  const output =
    outputIndex >= 0 ? process.argv[outputIndex + 1] : ".artifacts/fishing/BALANCE_DATA.json";
  assert.ok(output, "--output requires a report path");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, json, "utf8");
  console.log("Fishing economy verified: 400000 single-pool catches; report saved to " + output);
} catch (error) {
  console.error(error);
  console.error("[simulate-economy] FAILED (exit 1)");
  process.exitCode = 1;
}
