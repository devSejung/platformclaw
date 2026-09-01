import { describe, expect, it } from "vitest";
import { loadShortTermPromotionDreamingStats } from "./short-term-promotion-stats.js";
import { createMemoryCoreTestHarness, shortTermTestState } from "./test-helpers.js";

const NOW_ISO = "2026-08-31T12:00:00.000Z";

function recallEntry(params: {
  key: string;
  path: string;
  lastRecalledAt: string;
  promotedAt?: string;
}) {
  return {
    key: params.key,
    path: params.path,
    startLine: 1,
    endLine: 1,
    source: "memory" as const,
    snippet: `Recall from ${params.path}`,
    recallCount: 1,
    dailyCount: 1,
    groundedCount: 0,
    totalScore: 1,
    maxScore: 1,
    firstRecalledAt: params.lastRecalledAt,
    lastRecalledAt: params.lastRecalledAt,
    queryHashes: [params.key],
    recallDays: [params.lastRecalledAt.slice(0, 10)],
    conceptTags: [],
    ...(params.promotedAt ? { promotedAt: params.promotedAt } : {}),
  };
}

describe("short-term promotion dreaming stats", () => {
  const harness = createMemoryCoreTestHarness();

  it("projects current session corpus and canonicalizes legacy basename paths", async () => {
    const workspaceDir = await harness.createTempWorkspace("status-paths-");
    const sessionCorpusPath = "memory/.dreams/session-corpus/2026-08-31.txt";
    const legacyPath = "2026-08-30-legacy.md";
    const promotedLegacyPath = "2026-08-29-promoted.md";
    await shortTermTestState.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: NOW_ISO,
      entries: {
        corpus: recallEntry({
          key: "corpus",
          path: sessionCorpusPath,
          lastRecalledAt: "2026-08-31T11:00:00.000Z",
        }),
        legacy: recallEntry({
          key: "legacy",
          path: legacyPath,
          lastRecalledAt: "2026-08-30T11:00:00.000Z",
        }),
        promoted: recallEntry({
          key: "promoted",
          path: promotedLegacyPath,
          lastRecalledAt: "2026-08-29T11:00:00.000Z",
          promotedAt: "2026-08-31T10:00:00.000Z",
        }),
      },
    });

    const stats = await loadShortTermPromotionDreamingStats({
      workspaceDir,
      nowMs: Date.parse(NOW_ISO),
    });

    expect(stats.shortTermEntries.map((entry) => entry.path)).toEqual([
      sessionCorpusPath,
      `memory/${legacyPath}`,
    ]);
    expect(stats.signalEntries.map((entry) => entry.path)).toEqual([
      sessionCorpusPath,
      `memory/${legacyPath}`,
    ]);
    expect(stats.promotedEntries.map((entry) => entry.path)).toEqual([
      `memory/${promotedLegacyPath}`,
    ]);

    const stored = await shortTermTestState.readRecallStore(workspaceDir, NOW_ISO);
    expect(stored.entries.legacy?.path).toBe(legacyPath);
    expect(stored.entries.promoted?.path).toBe(promotedLegacyPath);
  });
});
