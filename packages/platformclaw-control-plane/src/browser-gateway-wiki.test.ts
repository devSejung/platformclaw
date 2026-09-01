import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

const emptyCounts = { entity: 0, concept: 0, source: 0, synthesis: 0, report: 0 };

function dreamingEntry(path: string) {
  return {
    key: `${path}:1`,
    path,
    startLine: 1,
    endLine: 2,
    snippet: "Remember this",
    recallCount: 1,
    dailyCount: 1,
    groundedCount: 1,
    totalSignalCount: 3,
    lightHits: 1,
    remHits: 1,
    phaseHitCount: 2,
  };
}

function dreamingStatus(
  agentId: string,
  entries: {
    shortTermEntries: ReturnType<typeof dreamingEntry>[];
    signalEntries: ReturnType<typeof dreamingEntry>[];
    promotedEntries: ReturnType<typeof dreamingEntry>[];
  },
) {
  return {
    agentId,
    provider: "local",
    embedding: { ok: true },
    dreaming: {
      enabled: true,
      timezone: "Asia/Seoul",
      verboseLogging: false,
      storageMode: "separate",
      separateReports: true,
      shortTermCount: entries.shortTermEntries.length,
      recallSignalCount: 1,
      dailySignalCount: 1,
      groundedSignalCount: 1,
      totalSignalCount: 3,
      phaseSignalCount: 2,
      lightPhaseHitCount: 1,
      remPhaseHitCount: 1,
      promotedTotal: entries.promotedEntries.length,
      promotedToday: entries.promotedEntries.length,
      ...entries,
      phases: {
        light: { enabled: true, schedule: "0 3 * * *" },
        deep: { enabled: true, threshold: 2 },
        rem: { enabled: true, lookbackDays: 7 },
      },
    },
  };
}

describe("BrowserGatewayProxy personal memory wiki", () => {
  it("pins native Memory UI reads to the personal Agent", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce({
        agentId: binding.agentId,
        found: true,
        path: "DREAMS.md",
        content: "# Dreams",
      })
      .mockResolvedValueOnce({
        sourceType: "chatgpt",
        totalItems: 0,
        totalClusters: 0,
        clusters: [],
      })
      .mockResolvedValueOnce({
        totalItems: 0,
        totalPages: 0,
        pageCounts: emptyCounts,
        totalClaims: 0,
        totalQuestions: 0,
        totalContradictions: 0,
        clusters: [],
      });

    await proxy.request(token, "doctor.memory.dreamDiary", {});
    await proxy.request(token, "wiki.importInsights", {});
    await proxy.request(token, "wiki.overview", {});

    expect(request.mock.calls).toEqual([
      ["doctor.memory.dreamDiary", { agentId: binding.agentId }],
      ["wiki.importInsights", { agentId: binding.agentId }],
      ["wiki.overview", { agentId: binding.agentId }],
    ]);
  });

  it("projects dreaming status without server paths or diagnostic errors", async () => {
    const { binding, proxy, request, token } = await setup();
    const daily = dreamingEntry("memory/day.md");
    const corpus = dreamingEntry("memory/.dreams/session-corpus/2026-08-31.txt");
    const legacy = dreamingEntry("memory/2026-08-30-legacy.md");
    const upstream = dreamingStatus(binding.agentId, {
      shortTermEntries: [daily, corpus],
      signalEntries: [corpus, daily],
      promotedEntries: [legacy],
    });
    request.mockResolvedValueOnce({
      ...upstream,
      embedding: { ok: false, error: "failed at /srv/private/model.bin" },
      dreaming: {
        ...upstream.dreaming,
        storePath: "/srv/private/dreaming.json",
        storeError: "secret at /srv/private",
        phases: {
          light: { enabled: true, schedule: "0 3 * * *", error: "/srv/private" },
          deep: { enabled: true, threshold: 2 },
          rem: { enabled: true, lookbackDays: 7 },
        },
      },
    });

    const result = await proxy.request(token, "doctor.memory.status", {});
    expect(result).toMatchObject({
      agentId: binding.agentId,
      embedding: {
        ok: false,
        error:
          "Memory embeddings unavailable; ask a PlatformClaw administrator to check provider setup.",
      },
      dreaming: {
        enabled: true,
        shortTermEntries: [{ path: daily.path }, { path: corpus.path }],
        signalEntries: [{ path: corpus.path }, { path: daily.path }],
        promotedEntries: [{ path: legacy.path }],
      },
    });
    expect(JSON.stringify(result)).not.toContain("/srv/private");
    expect(request).toHaveBeenCalledWith("doctor.memory.status", { agentId: binding.agentId });
  });

  it("normalizes Windows separators in a valid dreaming session corpus path", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce(
      dreamingStatus(binding.agentId, {
        shortTermEntries: [dreamingEntry("memory\\.dreams\\session-corpus\\2026-08-31.txt")],
        signalEntries: [],
        promotedEntries: [],
      }),
    );

    await expect(proxy.request(token, "doctor.memory.status", {})).resolves.toMatchObject({
      dreaming: {
        shortTermEntries: [{ path: "memory/.dreams/session-corpus/2026-08-31.txt" }],
      },
    });
  });

  it("supports bounded personal Wiki search and page reads", async () => {
    const { binding, proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce([
        {
          corpus: "wiki",
          path: "concepts/안전 검토.md",
          title: "안전 검토",
          kind: "concept",
          score: 0.9,
          snippet: "검토 규칙",
          sourcePath: "/srv/private/source.md",
        },
      ])
      .mockResolvedValueOnce({
        corpus: "wiki",
        path: "concepts/안전 검토.md",
        title: "안전 검토",
        kind: "concept",
        content: "# 안전 검토",
        fromLine: 1,
        lineCount: 1,
        totalLines: 1,
      });

    await expect(
      proxy.request(token, "wiki.search", { query: "  검토  ", maxResults: 10 }),
    ).resolves.toEqual([
      {
        corpus: "wiki",
        path: "concepts/안전 검토.md",
        title: "안전 검토",
        kind: "concept",
        score: 0.9,
        snippet: "검토 규칙",
      },
    ]);
    await proxy.request(token, "wiki.get", {
      lookup: "concepts/안전 검토.md",
      fromLine: 1,
      lineCount: 5_000,
    });
    expect(request.mock.calls).toEqual([
      ["wiki.search", { agentId: binding.agentId, query: "검토", corpus: "wiki", maxResults: 10 }],
      [
        "wiki.get",
        {
          agentId: binding.agentId,
          lookup: "concepts/안전 검토.md",
          fromLine: 1,
          lineCount: 5_000,
        },
      ],
    ]);
  });

  it("projects only managed agent-scoped bridge status", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      vaultScope: "agent",
      vaultMode: "bridge",
      renderMode: "native",
      vaultPath: "/srv/private/wiki/agent",
      vaultExists: true,
      bridgePublicArtifactCount: 2,
      pageCounts: emptyCounts,
      sourceCounts: { native: 0, bridge: 2, bridgeEvents: 0, unsafeLocal: 0, other: 0 },
    });
    const result = await proxy.request(token, "wiki.status", {});
    expect(result).toMatchObject({
      agentId: binding.agentId,
      vaultScope: "agent",
      vaultMode: "bridge",
      renderMode: "native",
    });
    expect(JSON.stringify(result)).not.toContain("/srv/private");

    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      vaultScope: "agent",
      vaultMode: "isolated",
      renderMode: "native",
      vaultExists: true,
      bridgePublicArtifactCount: null,
      pageCounts: emptyCounts,
      sourceCounts: { native: 0, bridge: 0, bridgeEvents: 0, unsafeLocal: 0, other: 0 },
    });
    await expect(proxy.request(token, "wiki.status", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("denies cross-Agent, probe, oversized, and unsafe-result requests", async () => {
    const { binding, proxy, request, token } = await setup();
    await expect(
      proxy.request(token, "doctor.memory.status", { agentId: "other" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "doctor.memory.status", { probe: "yes" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "wiki.search", { query: "q", corpus: "memory" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "wiki.get", { lookup: "page", backend: "local" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "wiki.get", { lookup: "page", lineCount: 5_001 }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "wiki.search", { query: "q", maxResults: 51 }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });

    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      found: true,
      path: "/srv/private/DREAMS.md",
      content: "secret",
    });
    await expect(proxy.request(token, "doctor.memory.dreamDiary", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });

    request.mockResolvedValueOnce(
      dreamingStatus("other", {
        shortTermEntries: [],
        signalEntries: [],
        promotedEntries: [],
      }),
    );
    await expect(proxy.request(token, "doctor.memory.status", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it.each([
    "/srv/private/memory/2026-08-31.md",
    "C:/srv/private/memory/2026-08-31.md",
    "memory/../private/2026-08-31.md",
    "memory/2026-08-31.txt",
    "memory/.dreams/session-corpus/2026-8-31.txt",
    "memory/.dreams/session-corpus/2026-02-30.txt",
    "2026-08-31-legacy.md",
    "MEMORY.MD",
    "Memory/2026-08-31.md",
    "memory/2026-08-31.MD",
    "memory/.Dreams/session-corpus/2026-08-31.txt",
    "memory/.dreams/session-corpus/2026-08-31.TXT",
    "\\\\server\\share\\memory\\2026-08-31.md",
    "https://example.test/memory/2026-08-31.md",
    "memory/./2026-08-31.md",
    "memory//2026-08-31.md",
  ])("rejects unsafe or non-contract dreaming entry path %s", async (path) => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce(
      dreamingStatus(binding.agentId, {
        shortTermEntries: [dreamingEntry(path)],
        signalEntries: [],
        promotedEntries: [],
      }),
    );

    await expect(proxy.request(token, "doctor.memory.status", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("pins personal Dreaming maintenance actions and removes archive paths", async () => {
    const { binding, proxy, request, token } = await setup();
    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      action: "repairDreamingArtifacts",
      changed: true,
      archiveDir: "/srv/private/archive",
      archivedDreamsDiary: true,
      warnings: ["repaired"],
    });
    const result = await proxy.request(token, "doctor.memory.repairDreamingArtifacts", {});
    expect(result).toEqual({
      agentId: binding.agentId,
      action: "repairDreamingArtifacts",
      changed: true,
      archivedDreamsDiary: true,
    });
    expect(request).toHaveBeenCalledWith("doctor.memory.repairDreamingArtifacts", {
      agentId: binding.agentId,
    });

    request.mockResolvedValueOnce({
      agentId: binding.agentId,
      action: "reset",
      warnings: ["failed at /srv/private/dreams"],
    });
    await expect(
      proxy.request(token, "doctor.memory.repairDreamingArtifacts", {}),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });
});
