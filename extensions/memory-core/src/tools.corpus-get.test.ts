// Memory Core tests cover supplemental corpus get behavior.
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMemoryToolMockState,
  setMemoryReadFileImpl,
  type MemoryReadParams,
} from "./memory-tool-manager.test-mocks.js";
import { createMemoryGetTool } from "./tools.js";
import { asOpenClawConfig, createMemoryGetToolOrThrow } from "./tools.test-helpers.js";

beforeEach(() => {
  clearMemoryPluginState();
  resetMemoryToolMockState();
});

describe("memory corpus get supplements", () => {
  it("falls back to a wiki corpus supplement for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("path required");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_fallback", {
      path: "entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry",
      fromLine: 3,
      lineCount: 5,
    });
  });

  it.each([
    {
      name: "unavailable",
      status: () => ({ available: false as const, reason: "not-configured" as const }),
      message: "organization memory is not configured",
    },
    {
      name: "failed",
      status: () => ({ available: true as const }),
      message: "organization memory read failed",
    },
  ])("preserves memory_get failure semantics when a supplement is $name", async (scenario) => {
    const get = vi.fn(async () => {
      throw new Error(scenario.message);
    });
    registerMemoryCorpusSupplement("organization", {
      status: scenario.status,
      search: async () => [],
      get,
    });

    const tool = createMemoryGetToolOrThrow();
    await expect(
      tool.execute(`call_get_${scenario.name}`, {
        path: "organization/part/pmu-registers",
        corpus: "wiki",
      }),
    ).rejects.toThrow(scenario.message);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each(["wiki", "all"] as const)(
    "forwards effective agent context to memory_get corpus=%s supplements",
    async (corpus) => {
      if (corpus === "all") {
        setMemoryReadFileImpl(async () => {
          throw new Error("memory path missing");
        });
      }
      const get = vi.fn(async () => ({
        corpus: "wiki" as const,
        path: "entities/alpha.md",
        content: "Alpha wiki entry",
        fromLine: 2,
        lineCount: 4,
      }));
      registerMemoryCorpusSupplement("memory-wiki", {
        search: async () => [],
        get,
      });
      const config = asOpenClawConfig({
        agents: { list: [{ id: "marketing-agent", default: true }] },
      });
      const tool = createMemoryGetTool({
        config,
        agentId: " Marketing Agent ",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      });
      if (!tool) {
        throw new Error("expected memory_get tool");
      }

      await tool.execute(`call_get_${corpus}`, {
        path: "entities/alpha.md",
        from: 2,
        lines: 4,
        corpus,
      });

      expect(get).toHaveBeenCalledWith({
        lookup: "entities/alpha.md",
        fromLine: 2,
        lineCount: 4,
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
        corpus,
      });
    },
  );

  it("falls back to a wiki corpus supplement when memory_get corpus=all misses memory without throwing", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => ({
        corpus: "wiki",
        path: "memory/entities/alpha.md",
        title: "Alpha",
        kind: "entity",
        content: "Alpha wiki entry after empty miss",
        fromLine: 3,
        lineCount: 5,
      }),
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_empty_miss_fallback", {
      path: "memory/entities/alpha.md",
      from: 3,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      corpus: "wiki",
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      text: "Alpha wiki entry after empty miss",
      fromLine: 3,
      lineCount: 5,
    });
  });

  it("preserves an empty in-file range for memory_get corpus=all", async () => {
    setMemoryReadFileImpl(async (params: MemoryReadParams) => ({
      text: "",
      path: params.relPath,
      from: params.from ?? 1,
      lines: 0,
    }));
    const getSupplement = vi.fn(async () => ({
      corpus: "wiki" as const,
      path: "memory/entities/alpha.md",
      title: "Alpha",
      kind: "entity",
      content: "Alpha wiki entry",
      fromLine: 10,
      lineCount: 5,
    }));
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: getSupplement,
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_empty_range", {
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 5,
      corpus: "all",
    });

    expect(result.details).toEqual({
      text: "",
      path: "memory/entities/alpha.md",
      from: 10,
      lines: 0,
    });
    expect(getSupplement).not.toHaveBeenCalled();
  });

  it("returns the primary error when a corpus=all supplement fallback throws", async () => {
    setMemoryReadFileImpl(async () => {
      throw new Error("primary read failed");
    });
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [],
      get: async () => {
        throw new Error("supplement lookup failed");
      },
    });

    const tool = createMemoryGetToolOrThrow();
    const result = await tool.execute("call_get_all_supplement_throws", {
      path: "entities/alpha.md",
      corpus: "all",
    });

    expect(result.details).toEqual({
      path: "entities/alpha.md",
      text: "",
      disabled: true,
      error: "primary read failed",
    });
  });
});
