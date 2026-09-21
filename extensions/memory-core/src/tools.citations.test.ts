// Memory Core tests cover tools.citations plugin behavior.
import fs from "node:fs/promises";
import { clearMemoryPluginState } from "openclaw/plugin-sdk/memory-host-core";
import { readMemoryHostEvents } from "openclaw/plugin-sdk/memory-host-events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMemoryCloseMockCalls,
  getMemorySearchManagerMockCalls,
  getMemorySearchManagerMockParams,
  getReadAgentMemoryFileMockCalls,
  resetMemoryToolMockState,
  setMemoryBackend,
  setMemoryReadFileImpl,
  setMemorySearchImpl,
  setMemoryWorkspaceDir,
  type MemoryReadParams,
} from "./memory-tool-manager.test-mocks.js";
import {
  createMemoryCoreTestHarness,
  shortTermTestState as shortTermPromotionTesting,
} from "./test-helpers.js";
import { testing as memoryToolsTesting } from "./tools.js";
import {
  asOpenClawConfig,
  createAutoCitationsMemorySearchTool,
  createDefaultMemoryToolConfig,
  createMemoryGetToolOrThrow,
  createMemorySearchToolOrThrow,
  expectUnavailableMemorySearchDetails,
} from "./tools.test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

async function waitFor<T>(task: () => Promise<T>, timeoutMs = 1500): Promise<T> {
  let value: T | undefined;
  await vi.waitFor(
    async () => {
      value = await task();
    },
    { interval: 1, timeout: timeoutMs },
  );
  return value as T;
}

beforeEach(() => {
  clearMemoryPluginState();
  memoryToolsTesting.resetMemorySearchToolCooldowns();
  resetMemoryToolMockState({
    backend: "builtin",
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
    readFileImpl: async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: params.lines ?? 120,
    }),
  });
});

describe("memory search citations", () => {
  function expectFirstMemoryResult<T>(details: { results: T[] }): T {
    expect(details.results).toHaveLength(1);
    const [result] = details.results;
    if (!result) {
      throw new Error("Expected memory search result");
    }
    return result;
  }

  // The first tool call pays Vitest's cold lazy-runtime transform cost on Node 24 CI.
  it("appends source information when citations are enabled", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "on" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(firstResult.citation).toBe("MEMORY.md#L5-L7");
  }, 180_000);

  it("leaves snippet untouched when citations are off", async () => {
    setMemoryBackend("builtin");
    const cfg = asOpenClawConfig({
      memory: { citations: "off" },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).not.toMatch(/Source:/);
    expect(firstResult.citation).toBeUndefined();
  });

  it("clamps decorated snippets to qmd injected budget", async () => {
    setMemoryBackend("qmd");
    setMemorySearchImpl(async () => [
      {
        path: "MEMORY.md",
        startLine: 5,
        endLine: 7,
        score: 0.9,
        snippet: "abc😀tail",
        source: "memory" as const,
      },
    ]);
    const cfg = asOpenClawConfig({
      memory: { citations: "on", backend: "qmd", qmd: { limits: { maxInjectedChars: 4 } } },
      agents: { list: [{ id: "main", default: true }] },
    });
    const tool = createMemorySearchToolOrThrow({ config: cfg });
    const result = await tool.execute("call_citations_qmd", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toBe("abc");
  });

  it("honors auto mode for direct chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:dm:u123");
    const result = await tool.execute("auto_mode_direct", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).toMatch(/Source:/);
  });

  it("suppresses citations for auto mode in group chats", async () => {
    setMemoryBackend("builtin");
    const tool = createAutoCitationsMemorySearchTool("agent:main:discord:group:c123");
    const result = await tool.execute("auto_mode_group", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string }> };
    const firstResult = expectFirstMemoryResult(details);
    expect(firstResult.snippet).not.toMatch(/Source:/);
  });
});

describe("memory tools", () => {
  it("returns unavailable details when memory_search fails (e.g. embeddings 429)", async () => {
    setMemorySearchImpl(async () => {
      throw new Error("openai embeddings failed: 429 insufficient_quota");
    });

    const cfg = createDefaultMemoryToolConfig();
    const tool = createMemorySearchToolOrThrow({ config: cfg });

    const result = await tool.execute("call_1", { query: "hello" });
    expectUnavailableMemorySearchDetails(result.details, {
      error: "openai embeddings failed: 429 insufficient_quota",
      warning: "Memory search is unavailable because the embedding provider quota is exhausted.",
      action: "Top up or switch embedding provider, then retry memory_search.",
    });
  });

  it("uses default memory manager mode for shared memory_search", async () => {
    setMemoryBackend("qmd");
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        memory: { backend: "qmd", qmd: { command: "qmd" } },
        agents: { list: [{ id: "main", default: true }] },
      }),
    });

    await tool.execute("call_default_purpose", { query: "contact phrase" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({
        agentId: "main",
        purpose: undefined,
      }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(0);
  });

  it("uses one-shot CLI memory manager mode for explicit local CLI memory_search", async () => {
    setMemoryBackend("qmd");
    const tool = createMemorySearchToolOrThrow({
      config: asOpenClawConfig({
        memory: { backend: "qmd", qmd: { command: "qmd" } },
        agents: { list: [{ id: "main", default: true }] },
      }),
      oneShotCliRun: true,
    });

    await tool.execute("call_cli_purpose", { query: "contact phrase" });

    expect(getMemorySearchManagerMockParams()).toEqual([
      expect.objectContaining({
        agentId: "main",
        purpose: "cli",
      }),
    ]);
    expect(getMemoryCloseMockCalls()).toBe(1);
  });

  it("returns disabled details when memory_get fails", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      throw new Error("path required");
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_2", { path: "memory/NOPE.md" });
    expect(result.details).toEqual({
      path: "memory/NOPE.md",
      text: "",
      disabled: true,
      error: "path required",
    });
  });

  it("returns empty text without error when file does not exist (ENOENT)", async () => {
    setMemoryReadFileImpl(async (_params: MemoryReadParams) => {
      return { text: "", path: "memory/2026-02-19.md", from: 1, lines: 0 };
    });

    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_enoent", { path: "memory/2026-02-19.md" });
    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 0,
    });
  });

  it("uses the builtin direct memory file path for memory_get", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    const result = await tool.execute("call_builtin_fast_path", { path: "memory/2026-02-19.md" });

    expect(result.details).toEqual({
      text: "",
      path: "memory/2026-02-19.md",
      from: 1,
      lines: 120,
    });
    expect(getReadAgentMemoryFileMockCalls()).toBe(1);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("rejects fractional memory_get ranges before reading files", async () => {
    setMemoryBackend("builtin");
    const tool = createMemoryGetToolOrThrow();

    await expect(
      tool.execute("call_fractional_range", {
        path: "memory/2026-02-19.md",
        from: 1.5,
        lines: 2,
      }),
    ).rejects.toThrow("from must be a positive integer");
    expect(getReadAgentMemoryFileMockCalls()).toBe(0);
    expect(getMemorySearchManagerMockCalls()).toBe(0);
  });

  it("returns truncation metadata and a continuation notice for partial memory_get results", async () => {
    setMemoryBackend("builtin");
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      path: params.relPath,
      text: "alpha\nbeta\n\n[More content available. Use from=41 to continue.]",
      from: params.from ?? 1,
      lines: 40,
      truncated: true,
      nextFrom: 41,
    }));

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_partial", { path: "memory/partial.md" });

    expect(result.details).toEqual({
      path: "memory/partial.md",
      text: "alpha\nbeta\n\n[More content available. Use from=41 to continue.]",
      from: 1,
      lines: 40,
      truncated: true,
      nextFrom: 41,
    });
  });

  it("persists short-term recall events from memory_search tool hits", async () => {
    const workspaceDir = await createTempWorkspace("memory-tools-recall-");
    try {
      setMemoryBackend("builtin");
      setMemoryWorkspaceDir(workspaceDir);
      setMemorySearchImpl(async () => [
        {
          path: "memory/2026-04-03.md",
          startLine: 1,
          endLine: 2,
          score: 0.95,
          snippet: "Move backups to S3 Glacier.",
          source: "memory" as const,
        },
      ]);

      const tool = createMemorySearchToolOrThrow({
        config: asOpenClawConfig({
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "memory-core": {
                config: {
                  dreaming: {
                    enabled: true,
                  },
                },
              },
            },
          },
        }),
      });
      await tool.execute("call_recall_persist", { query: "glacier backup" });

      const entries = await waitFor(async () => {
        const store = await shortTermPromotionTesting.readRecallStore(
          workspaceDir,
          new Date().toISOString(),
        );
        const values = Object.values(store.entries);
        expect(values).toHaveLength(1);
        return values;
      });
      const entry = entries[0];
      expect(entry?.path).toBe("memory/2026-04-03.md");
      expect(entry?.recallCount).toBe(1);
      const events = await waitFor(async () => {
        const memoryEvents = await readMemoryHostEvents({ workspaceDir });
        expect(memoryEvents).toHaveLength(1);
        return memoryEvents;
      });
      const event = events[0];
      expect(event?.type).toBe("memory.recall.recorded");
      if (!event || event.type !== "memory.recall.recorded") {
        throw new Error("expected memory recall recorded event");
      }
      expect(event.query).toBe("glacier backup");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
