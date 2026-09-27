// Memory Core tests cover supplemental corpus search behavior.
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemorySearchManagerMockCalls,
  resetMemoryToolMockState,
  setMemorySearchImpl,
} from "./memory-tool-manager.test-mocks.js";
import { createMemorySearchTool, testing as memoryToolsTesting } from "./tools.js";
import { asOpenClawConfig, createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

function collectWikiResultPaths(results: readonly { corpus: string; path: string }[]): string[] {
  const paths: string[] = [];
  for (const result of results) {
    if (result.corpus === "wiki") {
      paths.push(result.path);
    }
  }
  return paths;
}

beforeEach(() => {
  clearMemoryPluginState();
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState({
    searchImpl: async () => [
      {
        path: "MEMORY.md",
        startLine: 5,
        endLine: 7,
        score: 0.9,
        snippet: "@@ -5,3 @@\nAssistant: noted",
        source: "memory" as const,
      },
    ],
  });
});

describe("memory corpus search supplements", () => {
  it("forwards trusted run identity to supplemental search without a model argument", async () => {
    const search = vi.fn(async () => []);
    registerMemoryCorpusSupplement("knowledge", {
      includeByDefault: true,
      search,
      get: async () => null,
    });
    const tool = createMemorySearchTool({
      config: asOpenClawConfig({ agents: { list: [{ id: "main", default: true }] } }),
      runId: "host-run",
      agentId: "main",
    });
    expect(tool).not.toBeNull();
    await tool!.execute("call", { query: "spec" });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "host-run", agentId: "main" }),
    );
    expect(tool!.parameters.properties).not.toHaveProperty("runId");
  });
  it("bounds caller-requested search counts and long supplement excerpts", async () => {
    const search = vi.fn(async () =>
      Array.from({ length: 60 }, (_, index) => ({
        corpus: "knowledge",
        vaultId: "shared-a",
        path: `shared/a/${index}`,
        score: 1,
        snippet: "x".repeat(5_000),
        indexStatus: "failed" as const,
        indexError: "e".repeat(2_000),
      })),
    );
    registerMemoryCorpusSupplement("knowledge", {
      includeByDefault: true,
      search,
      get: async () => null,
    });
    const result = await createMemorySearchToolOrThrow().execute("bounds", {
      query: "x",
      vaultId: "shared-a",
      maxResults: 10_000,
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 50 }));
    const hits = (result.details as { results: Array<{ snippet: string; indexError: string }> })
      .results;
    expect(hits).toHaveLength(50);
    expect(hits.every((hit) => hit.snippet.length === 1_200 && hit.indexError.length === 500)).toBe(
      true,
    );
  });
  it("scopes a named vault before search and rejects results from another vault", async () => {
    const search = vi.fn(async () => [
      {
        corpus: "knowledge",
        vaultId: "vault-b",
        path: "shared/vault-b/doc",
        score: 1,
        snippet: "foreign",
      },
      {
        corpus: "knowledge",
        vaultId: "vault-a",
        vaultName: "Project A",
        vaultType: "shared" as const,
        documentId: "doc",
        title: "Spec",
        revision: 3,
        indexStatus: "failed" as const,
        indexError: "compile interrupted",
        nextRetryAt: 12345,
        path: "shared/vault-a/doc",
        score: 0.5,
        snippet: "authorized",
      },
    ]);
    registerMemoryCorpusSupplement("knowledge", {
      includeByDefault: true,
      search,
      get: async () => null,
    });
    const result = await createMemorySearchToolOrThrow().execute("vault", {
      query: "spec",
      vaultId: "vault-a",
    });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ vaultId: "vault-a" }));
    expect(getMemorySearchManagerMockCalls()).toBe(0);
    expect(result.details).toMatchObject({
      results: [
        {
          vaultId: "vault-a",
          vaultName: "Project A",
          vaultType: "shared",
          documentId: "doc",
          revision: 3,
          indexStatus: "failed",
          indexError: "compile interrupted",
          nextRetryAt: 12345,
        },
      ],
      warnings: [expect.stringContaining("last successful index")],
    });
  });

  it("includes personal vault identity and the indexed source version", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        source: "memory",
        sourceVersion: "indexed-source-hash",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "saved",
      },
    ]);
    const result = await createMemorySearchToolOrThrow().execute("personal", { query: "saved" });
    expect(result.details).toMatchObject({
      results: [
        {
          vaultId: "personal:main",
          vaultName: "Personal",
          vaultType: "personal",
          documentId: "memory:MEMORY.md",
          title: "MEMORY.md",
          sourceVersion: "indexed-source-hash",
        },
      ],
    });
  });

  it("searches registered wiki corpus supplements without calling memory search", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_wiki_only", { query: "alpha", corpus: "wiki" });

    expect(result.details).toStrictEqual({
      results: [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ],
      citations: "auto",
      corpusStatus: [{ pluginId: "memory-wiki", status: "ok" }],
      debug: undefined,
      fallback: undefined,
      mode: undefined,
      model: undefined,
      provider: undefined,
    });
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_search corpus=%s supplements",
    async (corpus) => {
      const search = vi.fn(async () => [
        {
          corpus: "wiki" as const,
          path: "entities/alpha.md",
          score: 4,
          snippet: "Alpha wiki entry",
        },
      ]);
      registerMemoryCorpusSupplement("memory-wiki", {
        search,
        get: async () => null,
      });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemorySearchTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_search tool");
      }

      await tool.execute(`call_search_${corpus}`, {
        query: "alpha",
        maxResults: 3,
        corpus,
      });

      expect(search).toHaveBeenCalledWith({
        query: "alpha",
        maxResults: 3,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
        corpus,
      });
    },
  );

  it("includes memory results in corpus=all even when wiki scores are numerically higher (#77337)", async () => {
    // Wiki uses integer point scores (up to ~100+); memory uses cosine similarity (0-1).
    // Raw-score sort would starve memory hits when maxResults <= number of wiki hits.
    setMemorySearchImpl(async () => [
      {
        path: "memory/note-a.md",
        startLine: 1,
        endLine: 2,
        score: 0.9,
        snippet: "Memory result A",
        source: "memory" as const,
      },
    ]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "w1.md",
          title: "W1",
          kind: "entity",
          score: 50,
          snippet: "wiki 1",
        },
        {
          corpus: "wiki",
          path: "w2.md",
          title: "W2",
          kind: "entity",
          score: 40,
          snippet: "wiki 2",
        },
        {
          corpus: "wiki",
          path: "w3.md",
          title: "W3",
          kind: "entity",
          score: 30,
          snippet: "wiki 3",
        },
        {
          corpus: "wiki",
          path: "w4.md",
          title: "W4",
          kind: "entity",
          score: 20,
          snippet: "wiki 4",
        },
        {
          corpus: "wiki",
          path: "w5.md",
          title: "W5",
          kind: "entity",
          score: 10,
          snippet: "wiki 5",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_starvation", {
      query: "note",
      corpus: "all",
      maxResults: 5,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };
    const corpora = details.results.map((r) => r.corpus);

    // Memory results must appear despite lower numeric scores, and the spare
    // memory quota should be backfilled by the remaining wiki result.
    expect(corpora).toContain("memory");
    expect(corpora).toContain("wiki");
    expect(details.results).toHaveLength(5);
    expect(collectWikiResultPaths(details.results)).toEqual(["w1.md", "w2.md", "w3.md", "w4.md"]);
  });

  it("preserves memory rank within balanced corpus results", async () => {
    setMemorySearchImpl(async () => [
      {
        path: "memory/z/foo.md",
        startLine: 1,
        endLine: 2,
        score: 1,
        snippet: "exact filename",
        source: "memory" as const,
      },
      {
        path: "memory/a/semantic.md",
        startLine: 1,
        endLine: 2,
        score: 2,
        snippet: "non-exact semantic match",
        source: "memory" as const,
      },
    ]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "w1.md",
          title: "W1",
          kind: "entity",
          score: 10,
          snippet: "wiki 1",
        },
        {
          corpus: "wiki",
          path: "w2.md",
          title: "W2",
          kind: "entity",
          score: 9,
          snippet: "wiki 2",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_ranked_stream", {
      query: "foo.md",
      corpus: "all",
      maxResults: 4,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => entry.path)).toEqual([
      "w1.md",
      "w2.md",
      "memory/z/foo.md",
      "memory/a/semantic.md",
    ]);
  });

  it("merges memory and wiki corpus search results for corpus=all", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 1.1,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_corpus", { query: "alpha", corpus: "all" });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["wiki", "entities/alpha.md"],
      ["memory", "MEMORY.md"],
    ]);
    expect(getMemorySearchManagerMockCalls()).toBe(1);
  });

  it("keeps successful corpus results when an independent supplement fails", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 1.1,
          snippet: "Alpha wiki entry",
        },
      ],
      get: async () => null,
    });
    registerMemoryCorpusSupplement("organization", {
      search: async () => {
        throw new Error("organization store unavailable");
      },
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_all_one_supplement_failed", {
      query: "alpha",
      corpus: "all",
    });
    const details = result.details as {
      results: Array<{ corpus: string; path: string }>;
      warnings: string[];
    };
    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["wiki", "entities/alpha.md"],
      ["memory", "MEMORY.md"],
    ]);
    expect(details.warnings).toEqual([
      'Memory corpus from plugin "organization" is temporarily unavailable.',
    ]);
  });

  it("includes only default supplements when corpus is omitted and reports each outcome", async () => {
    registerMemoryCorpusSupplement("memory-wiki", {
      includeByDefault: true,
      search: async () => [],
      get: async () => null,
    });
    registerMemoryCorpusSupplement("organization", {
      includeByDefault: true,
      status: () => ({ available: false, reason: "not-configured" }),
      search: async () => {
        throw new Error("must not call an unavailable corpus");
      },
      get: async () => null,
    });
    registerMemoryCorpusSupplement("opt-in", {
      search: async () => [
        {
          corpus: "opt-in",
          path: "hidden.md",
          score: 1,
          snippet: "explicit only",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_default_corpora", { query: "alpha" });
    const details = result.details as {
      results: Array<{ corpus: string; path: string }>;
      warnings: string[];
      corpusStatus: Array<{ pluginId: string; status: string }>;
    };

    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["memory", "MEMORY.md"],
    ]);
    expect(details.corpusStatus).toEqual([
      { pluginId: "memory-wiki", status: "empty" },
      { pluginId: "organization", status: "unavailable" },
    ]);
    expect(details.warnings).toEqual([
      'Memory corpus from plugin "organization" is not configured.',
    ]);
  });

  it("keeps explicit personal-memory searches narrow", async () => {
    const search = vi.fn(async () => []);
    registerMemoryCorpusSupplement("organization", {
      includeByDefault: true,
      search,
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_private_memory", {
      query: "alpha",
      corpus: "memory",
    });

    expect(search).not.toHaveBeenCalled();
    expect(result.details).not.toHaveProperty("corpusStatus");
  });

  it("keeps default supplement results when personal memory search fails", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("personal memory offline");
    });
    registerMemoryCorpusSupplement("organization", {
      includeByDefault: true,
      search: async () => [
        {
          corpus: "platformclaw-organization",
          path: "organization/team/dram-policy",
          score: 0.9,
          snippet: "Approved DRAM guidance",
        },
      ],
      get: async () => null,
    });

    const tool = createMemorySearchToolOrThrow();
    const result = await tool.execute("call_default_memory_failed", { query: "DRAM" });

    expect(result.details).toMatchObject({
      results: [
        {
          corpus: "platformclaw-organization",
          path: "organization/team/dram-policy",
        },
      ],
      corpusStatus: [
        { pluginId: "memory-core", status: "failed" },
        { pluginId: "organization", status: "ok" },
      ],
      warnings: ["Personal memory corpus is temporarily unavailable."],
    });
  });

  it("keeps completed memory and sibling results when a corpus=all supplement stalls", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return [
          {
            path: "MEMORY.md",
            startLine: 5,
            endLine: 7,
            score: 0.9,
            snippet: "@@ -5,3 @@\nAssistant: noted",
            source: "memory" as const,
          },
        ];
      });
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => await new Promise(() => {}),
        get: async () => null,
      });
      registerMemoryCorpusSupplement("organization", {
        search: async () => [
          {
            corpus: "platformclaw-organization",
            path: "organization/team/alpha",
            score: 0.8,
            snippet: "Approved organization guidance",
          },
        ],
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const stalledAllResultPromise = tool.execute("call_all_stalled_wiki", {
        query: "alpha",
        corpus: "all",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const stalledAllResult = await stalledAllResultPromise;
      expect(stalledAllResult.details).toMatchObject({
        results: [
          { corpus: "memory", path: "MEMORY.md" },
          { corpus: "platformclaw-organization", path: "organization/team/alpha" },
        ],
        corpusStatus: [
          { pluginId: "memory-wiki", status: "failed" },
          { pluginId: "organization", status: "ok" },
        ],
        warnings: ['Memory corpus from plugin "memory-wiki" is temporarily unavailable.'],
      });

      const memoryResult = await tool.execute("call_memory_after_stalled_wiki", {
        query: "alpha",
      });
      const details = memoryResult.details as { results: Array<{ corpus: string; path: string }> };
      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["memory", "MEMORY.md"],
      ]);
      expect(searchCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cooldowns primary memory when corpus=all memory search stalls", async () => {
    vi.useFakeTimers();
    try {
      let searchCalls = 0;
      setMemorySearchImpl(async () => {
        searchCalls += 1;
        return await new Promise(() => {});
      });
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [
          {
            corpus: "wiki",
            path: "entities/alpha.md",
            title: "Alpha",
            kind: "entity",
            score: 4,
            snippet: "Alpha wiki entry",
          },
        ],
        get: async () => null,
      });

      const tool = createMemorySearchToolOrThrow();
      const stalledAllResultPromise = tool.execute("call_all_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const stalledAllResult = await stalledAllResultPromise;
      expect(stalledAllResult.details).toMatchObject({
        results: [{ corpus: "wiki", path: "entities/alpha.md" }],
        corpusStatus: [
          { pluginId: "memory-core", status: "failed" },
          { pluginId: "memory-wiki", status: "ok" },
        ],
        warnings: ["Personal memory corpus is temporarily unavailable."],
      });

      const wikiOnlyResult = await tool.execute("call_all_after_stalled_memory", {
        query: "alpha",
        corpus: "all",
      });
      const details = wikiOnlyResult.details as {
        results: Array<{ corpus: string; path: string }>;
        corpusStatus: Array<{ pluginId: string; status: string }>;
      };
      expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
        ["wiki", "entities/alpha.md"],
      ]);
      expect(details.corpusStatus).toEqual([
        { pluginId: "memory-core", status: "unavailable" },
        { pluginId: "memory-wiki", status: "ok" },
      ]);
      expect(searchCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
