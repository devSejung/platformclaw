import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntry,
} from "../config/sessions/session-accessor.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";
import { loadSessionCostSummary } from "./session-cost-usage.js";

describe("session usage accounting conservation", () => {
  it("retains unknown models and token uncertainty across SQLite rollup rebuilds", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "usage-accounting-")));
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
        const agentId = "main";
        const sessionId = "report-source";
        const sessionKey = "agent:main:report-source";
        const storePath = path.join(root, "agents", agentId, "sessions", "sessions.json");
        const target = { agentId, sessionId, sessionKey, storePath };
        const september = Date.parse("2026-09-30T14:59:59.000Z");
        const october = september + 1_000;
        const componentCases = [
          { model: "input-only", usage: { input: 10 }, tokens: 10, missingTokenEntries: 1 },
          { model: "output-only", usage: { output: 5 }, tokens: 5, missingTokenEntries: 1 },
          { model: "cache-only", usage: { cacheRead: 4 }, tokens: 4, missingTokenEntries: 1 },
          {
            model: "zero-components",
            usage: { input: 0, output: 0 },
            tokens: 0,
            missingTokenEntries: 0,
          },
          {
            model: "zero-output",
            usage: { input: 10, output: 0 },
            tokens: 10,
            missingTokenEntries: 0,
          },
        ];
        await upsertSessionEntry(
          { agentId, sessionKey, storePath },
          { sessionId, updatedAt: october },
        );
        await persistSessionTranscriptTurn(target, {
          messages: [
            {
              message: {
                role: "assistant",
                content: "No model attribution",
                timestamp: september,
                usage: { totalTokens: 12 },
              },
            },
            {
              message: {
                role: "assistant",
                content: "Literal provider and model IDs",
                provider: "unknown",
                model: "unknown",
                timestamp: september,
                usage: { totalTokens: 7 },
              },
            },
            {
              message: {
                role: "assistant",
                content: "Context-only usage does not measure tokens",
                provider: "example-provider",
                model: "example-model",
                timestamp: october,
                usage: { reasoningTokens: 4 },
              },
            },
            {
              message: {
                role: "assistant",
                content: "Measured zero",
                provider: "example-provider",
                model: "example-model",
                timestamp: october + 1,
                usage: { totalTokens: 0 },
              },
            },
            {
              message: {
                role: "assistant",
                content: "Recorded component counts",
                provider: "example-provider",
                model: "example-model",
                timestamp: october + 2,
                usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 2 },
              },
            },
            {
              message: {
                role: "assistant",
                content: "Provider total has priority over component subtotal",
                provider: "example-provider",
                model: "example-model",
                timestamp: october + 3,
                usage: { input: 1, output: 2, totalTokens: 99 },
              },
            },
            ...componentCases.map((entry, index) => ({
              message: {
                role: "assistant",
                content: "Component coverage fixture",
                provider: "example-provider",
                model: entry.model,
                timestamp: october + 4 + index,
                usage: entry.usage,
              },
            })),
          ],
          touchSessionEntry: false,
        });
        const query = {
          agentId,
          sessionId,
          sessionTarget: target,
          startMs: september - 1,
          endMs: october + 10,
          dayBucket: { mode: "time-zone", timeZone: "Asia/Seoul" } as const,
        };
        const first = expectDefined(await loadSessionCostSummary(query), "usage summary");
        expect(first.totalTokens).toBe(155);
        expect(first.missingTokenEntries).toBe(4);
        expect(first.modelUsage).toHaveLength(8);
        expect(first.modelUsage?.find((entry) => entry.provider === undefined)).toMatchObject({
          count: 1,
          totals: { totalTokens: 12 },
        });
        expect(first.modelUsage?.find((entry) => entry.provider === "unknown")).toMatchObject({
          model: "unknown",
          count: 1,
          totals: { totalTokens: 7 },
        });
        expect(first.dailyModelUsage).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ date: "2026-09-30", tokens: 12, count: 1 }),
            expect.objectContaining({ date: "2026-09-30", tokens: 7, count: 1 }),
            expect.objectContaining({
              date: "2026-10-01",
              provider: "example-provider",
              model: "example-model",
              tokens: 107,
              count: 4,
              missingTokenEntries: 1,
            }),
          ]),
        );
        expect(first.modelUsage?.reduce((sum, model) => sum + model.totals.totalTokens, 0)).toBe(
          first.totalTokens,
        );
        expect(first.dailyModelUsage?.reduce((sum, model) => sum + model.count, 0)).toBe(11);
        for (const entry of componentCases) {
          const daily = expectDefined(
            first.dailyModelUsage?.find((model) => model.model === entry.model),
            entry.model,
          );
          expect(daily).toMatchObject({ date: "2026-10-01", tokens: entry.tokens, count: 1 });
          expect(daily.missingTokenEntries ?? 0).toBe(entry.missingTokenEntries);
        }

        const row = expectDefined(readSessionCostUsageRollupRows(agentId)[0], "persisted rollup");
        const oldRollup = JSON.parse(row.valueJson);
        oldRollup.version = 2;
        for (const key of Object.keys(oldRollup.rollup.buckets)) {
          oldRollup.rollup.buckets[key].models = [];
        }
        expect(
          writeSessionCostUsageRollup({
            agentId,
            rollupId: row.key,
            previousValueJson: row.valueJson,
            valueJson: JSON.stringify(oldRollup),
            updatedAt: row.updatedAt,
          }),
        ).toBe(true);
        const rebuilt = expectDefined(await loadSessionCostSummary(query), "rebuilt usage summary");
        expect(rebuilt.dailyModelUsage).toEqual(first.dailyModelUsage);
        expect(rebuilt.missingTokenEntries).toBe(4);
        const rebuiltRow = expectDefined(
          readSessionCostUsageRollupRows(agentId)[0],
          "rebuilt rollup",
        );
        expect(JSON.parse(rebuiltRow.valueJson).version).toBe(3);
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
