import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import memoryCorePlugin from "../../memory-core/index.js";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";
import { renderWikiMarkdown } from "./markdown.js";
import * as sourceSync from "./source-sync.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiGetTool, createWikiSearchTool } from "./tool.js";

const { createVault } = createMemoryWikiTestHarness();

const appConfig = {
  // This suite registers memory-core directly; runtime discovery would load unrelated plugins.
  plugins: { enabled: false },
  agents: { list: [{ id: "main", default: true }, { id: "secondary" }] },
} as OpenClawConfig;

async function writeBridgePage(params: {
  rootDir: string;
  slug: string;
  title: string;
  agentIds: string[];
  marker: string;
}): Promise<void> {
  await fs.writeFile(
    path.join(params.rootDir, "sources", `${params.slug}.md`),
    renderWikiMarkdown({
      frontmatter: {
        pageType: "source",
        id: `source.${params.slug}`,
        title: params.title,
        sourceType: "memory-bridge",
        sourcePath: `/tmp/${params.slug}/MEMORY.md`,
        bridgeRelativePath: "MEMORY.md",
        bridgeWorkspaceDir: `/tmp/${params.slug}`,
        bridgeAgentIds: params.agentIds,
      },
      body: `# ${params.title}\n\n${params.marker}\n`,
    }),
    "utf8",
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected tool details object");
  }
  return value as Record<string, unknown>;
}

function registerMemoryCoreToolFactories(): Map<string, OpenClawPluginToolFactory> {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  memoryCorePlugin.register(
    createTestPluginApi({
      id: "memory-core",
      config: appConfig,
      runtime: createPluginRuntimeMock(),
      registerTool(tool, options) {
        if (typeof tool !== "function") {
          return;
        }
        for (const name of options?.names ?? []) {
          factories.set(name, tool);
        }
      },
    }),
  );
  return factories;
}

function createMemoryCoreTool(params: {
  factories: Map<string, OpenClawPluginToolFactory>;
  name: "memory_search" | "memory_get";
  agentId: string;
  runId?: string;
  sandboxed: boolean;
}): AnyAgentTool {
  const factory = params.factories.get(params.name);
  if (!factory) {
    throw new Error(`Expected memory-core to register ${params.name}`);
  }
  const tool = factory({
    config: appConfig,
    runtimeConfig: appConfig,
    getRuntimeConfig: () => appConfig,
    agentId: params.agentId,
    runId: params.runId,
    sessionKey: `agent:${params.agentId}:child-session`,
    sandboxed: params.sandboxed,
  });
  if (!tool || Array.isArray(tool)) {
    throw new Error(`Expected one ${params.name} tool`);
  }
  return tool;
}

describe("memory-wiki corpus supplement visibility", () => {
  it("validates the registered search-to-read conversation, name choices, and safe owner failures", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const hit = {
      corpus: "knowledge",
      path: "shared/project-a/spec",
      vaultId: "project-a",
      vaultName: "DDRPHY",
      vaultType: "shared" as const,
      documentId: "spec",
      title: "Training",
      revision: 3,
      score: 1,
      snippet: "training",
    };
    let revoked = false;
    let unavailable = false;
    const search = vi.fn(async ({ vaultName }: { vaultName?: string }) => {
      if (unavailable) {
        throw Object.assign(new Error("SQL private/internal must not escape"), {
          memoryCorpusFailure: {
            error: "Vault connections are unavailable for this turn.",
            action:
              "Retry in your next message; enable hooks.allowPromptInjection if this persists.",
          },
        });
      }
      if (vaultName === "Duplicate") {
        throw Object.assign(new Error("name ambiguity"), {
          memoryCorpusFailure: {
            error: "More than one accessible vault has this name.",
            action: "Ask the user to select a vaultId.",
            code: "vault-name-ambiguous",
            vaultChoices: [
              { vaultId: "project-a", vaultName: "Duplicate", vaultType: "shared" },
              { vaultId: "project-b", vaultName: "Duplicate", vaultType: "shared" },
            ],
          },
        });
      }
      return [hit];
    });
    const get = vi.fn(async ({ lookup }: { lookup: string }) => {
      if (lookup !== hit.path) {
        return null;
      }
      if (revoked) {
        throw Object.assign(new Error("private ACL row"), {
          memoryCorpusFailure: {
            error: "Document access is unavailable.",
            action: "Ask a Vault owner to review your access.",
          },
        });
      }
      return { ...hit, content: "Authorized training details", fromLine: 1, lineCount: 1 };
    });
    clearMemoryPluginState();
    try {
      await fs.writeFile(
        path.join(rootDir, "concepts", "collision.md"),
        renderWikiMarkdown({
          frontmatter: { pageType: "concept", id: hit.path, title: "Personal collision" },
          body: "Personal same-path candidate must not replace a failed Shared owner.",
        }),
        "utf8",
      );
      const wikiGet = createWikiGetTool(config, appConfig, { agentId: "main" });
      const collision = await wikiGet.execute("prove-collision", { lookup: hit.path });
      expect(JSON.stringify(collision.content)).toContain("Personal same-path candidate");
      registerMemoryCorpusSupplement("knowledge", { includeByDefault: true, search, get });
      // An older provider that ignores selectors must not broaden a named search.
      registerMemoryCorpusSupplement("unscoped", {
        includeByDefault: true,
        search: async () => [
          { ...hit, vaultId: "foreign", vaultName: "Other", path: "shared/foreign/spec" },
        ],
        get: async () => null,
      });
      const factories = registerMemoryCoreToolFactories();
      const memorySearch = createMemoryCoreTool({
        factories,
        name: "memory_search",
        agentId: "main",
        runId: "contract-run",
        sandboxed: false,
      });
      const memoryGet = createMemoryCoreTool({
        factories,
        name: "memory_get",
        agentId: "main",
        sandboxed: false,
      });
      const wikiSearch = createWikiSearchTool(config, appConfig, {
        agentId: "main",
        runId: "contract-run",
      });
      const invoke = async (tool: AnyAgentTool, input: Record<string, unknown>) => {
        expect(Value.Check(tool.parameters, input), `${tool.name}: ${JSON.stringify(input)}`).toBe(
          true,
        );
        return await tool.execute("validated-call", input);
      };
      expect(Value.Check(memoryGet.parameters, { path: hit.path, lines: 200 })).toBe(true);
      expect(Value.Check(memoryGet.parameters, { path: hit.path, lines: 201 })).toBe(false);
      expect(Value.Check(wikiGet.parameters, { lookup: hit.path, lineCount: 200 })).toBe(true);
      expect(Value.Check(wikiGet.parameters, { lookup: hit.path, lineCount: 201 })).toBe(false);
      for (const tool of [memorySearch, wikiSearch]) {
        expect(Value.Check(tool.parameters, { query: "training", vaultId: "project-a" })).toBe(
          true,
        );
        expect(Value.Check(tool.parameters, { query: "training", vaultName: "DDRPHY" })).toBe(true);
        expect(
          Value.Check(tool.parameters, {
            query: "training",
            vaultId: "project-a",
            vaultName: "DDRPHY",
          }),
        ).toBe(false);
        expect(Value.Check(tool.parameters, { query: "training", maxResults: 51 })).toBe(false);
        expect(Value.Check(tool.parameters, { query: "training", runId: "forged" })).toBe(false);
        const named = await invoke(tool, { query: "training", vaultName: " ddrphy " });
        expect(named.details).toMatchObject({
          results: [expect.objectContaining({ vaultId: "project-a" })],
        });
        const ambiguous = await invoke(tool, { query: "training", vaultName: "Duplicate" });
        expect(JSON.stringify(ambiguous.content)).toContain("Ask the user to select a vaultId");
        expect(JSON.stringify(ambiguous.content)).toContain("project-b");
        const selected = await invoke(tool, { query: "training", vaultId: "project-a" });
        expect(selected.details).toMatchObject({
          results: [expect.objectContaining({ path: hit.path })],
        });
      }
      const read = await invoke(memoryGet, { path: hit.path });
      expect(read.details).toMatchObject({
        text: "Authorized training details",
        vaultId: "project-a",
      });
      expect(get).toHaveBeenCalledWith(
        expect.objectContaining({ lookup: hit.path, agentId: "main" }),
      );
      revoked = true;
      const denied = await invoke(memoryGet, { path: hit.path });
      expect(denied.details).toMatchObject({
        disabled: true,
        text: "",
        error: "The document owner could not provide this path. Follow the reported action.",
      });
      expect(JSON.stringify(denied.content)).toContain("Ask a Vault owner");
      expect(JSON.stringify(denied)).not.toContain("private ACL row");
      const deniedWiki = await invoke(wikiGet, { lookup: hit.path });
      expect(deniedWiki.details).toMatchObject({ found: false, disabled: true });
      expect(JSON.stringify(deniedWiki.content)).toContain("Ask a Vault owner");
      expect(JSON.stringify(deniedWiki)).not.toContain("Personal same-path candidate");
      unavailable = true;
      for (const tool of [memorySearch, wikiSearch]) {
        const failed = await invoke(tool, { query: "training", vaultName: "DDRPHY" });
        expect(JSON.stringify(failed.content)).toContain("hooks.allowPromptInjection");
        expect(JSON.stringify(failed)).not.toContain("SQL private/internal");
      }
    } finally {
      clearMemoryPluginState();
    }
  });
  it("carries trusted run identity into the shared search registry", async () => {
    const { config } = await createVault({ initialize: true });
    const search = vi.fn(async () => []);
    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("knowledge", {
        includeByDefault: true,
        search,
        get: async () => null,
      });
      const tool = createWikiSearchTool(config, appConfig, { agentId: "main", runId: "host-run" });
      await tool.execute("call", { query: "spec", vaultId: "shared-one" });
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "host-run", agentId: "main" }),
      );
      expect(tool.parameters).toHaveProperty("properties");
      expect(tool.parameters).not.toHaveProperty("properties.runId");
      const memoryTool = createMemoryCoreTool({
        factories: registerMemoryCoreToolFactories(),
        name: "memory_search",
        agentId: "main",
        runId: "registered-host-run",
        sandboxed: false,
      });
      await memoryTool.execute("registered-call", { query: "spec", vaultId: "shared-one" });
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runId: "registered-host-run",
          agentId: "main",
        }),
      );
    } finally {
      clearMemoryPluginState();
    }
  });
  it("searches and reauthorizes organization pages while respecting an explicit personal vault", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await fs.writeFile(
      path.join(rootDir, "concepts", "personal.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.personal",
          title: "Personal PMU notes",
        },
        body: "# Personal PMU notes\n\nPMU register guidance\n",
      }),
      "utf8",
    );
    let authorized = true;
    const search = vi.fn(async () =>
      authorized
        ? [
            {
              corpus: "platformclaw-organization",
              vaultId: "managed:part:pmu",
              vaultName: "PMU",
              vaultType: "managed" as const,
              documentId: "pmu-registers",
              revision: 1,
              path: "organization/part/pmu-registers",
              title: "PMU register map",
              kind: "part",
              score: 0.9,
              snippet: "Approved PMU register guidance",
              source: "organization",
              provenanceLabel: "PMU",
            },
          ]
        : [],
    );
    const get = vi.fn(async () =>
      authorized
        ? {
            corpus: "platformclaw-organization",
            path: "organization/part/pmu-registers",
            title: "PMU register map",
            kind: "part",
            content: "Approved PMU register guidance",
            fromLine: 1,
            lineCount: 1,
            provenanceLabel: "PMU",
          }
        : null,
    );
    const caller = {
      agentId: "main",
      agentSessionKey: "agent:main:child-session",
      sandboxed: true,
    };

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("platformclaw-org-memory", {
        includeByDefault: true,
        status: () => ({ available: true }),
        search,
        get,
      });
      const searchTool = createWikiSearchTool(config, appConfig, caller);
      const searchResult = await searchTool.execute("wiki-search-org", {
        query: "PMU register guidance",
      });
      expect(asRecord(searchResult.details).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "concepts/personal.md", corpus: "wiki" }),
          expect.objectContaining({
            path: "organization/part/pmu-registers",
            corpus: "platformclaw-organization",
            provenanceLabel: "PMU",
          }),
        ]),
      );
      expect(search).toHaveBeenCalledWith({
        query: "PMU register guidance",
        maxResults: 10,
        ...caller,
      });

      const getTool = createWikiGetTool(config, appConfig, caller);
      const firstGet = await getTool.execute("wiki-get-org", {
        lookup: "organization/part/pmu-registers",
      });
      expect(asRecord(firstGet.details)).toMatchObject({
        found: true,
        path: "organization/part/pmu-registers",
        content: "Approved PMU register guidance",
      });
      expect(get).toHaveBeenLastCalledWith({
        lookup: "organization/part/pmu-registers",
        fromLine: 1,
        lineCount: 200,
        ...caller,
      });

      authorized = false;
      const revokedGet = await getTool.execute("wiki-get-org-revoked", {
        lookup: "organization/part/pmu-registers",
      });
      expect(asRecord(revokedGet.details)).toMatchObject({ found: false });
      expect(get).toHaveBeenCalledTimes(2);

      await searchTool.execute("wiki-search-personal-only", {
        query: "PMU register guidance",
        vaultId: "personal:main",
      });
      await getTool.execute("wiki-get-personal-only", {
        lookup: "concepts/personal.md",
      });
      expect(search).toHaveBeenCalledTimes(2);
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ vaultId: "personal:main" }),
      );
      expect(get).toHaveBeenCalledTimes(3);
    } finally {
      clearMemoryPluginState();
    }
  });

  it("reads a Shared document through its owner when Personal source sync fails", async () => {
    const { config } = await createVault({ initialize: true });
    const sync = vi
      .spyOn(sourceSync, "syncMemoryWikiImportedSources")
      .mockRejectedValue(new Error("Personal source sync offline"));
    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("shared-documents", {
        includeByDefault: true,
        search: async () => [],
        get: async ({ lookup }) =>
          lookup === "shared/project/spec"
            ? {
                corpus: "shared-documents",
                vaultId: "project",
                vaultName: "Project",
                vaultType: "shared",
                documentId: "spec",
                revision: 3,
                path: lookup,
                title: "Spec",
                kind: "shared",
                content: "Shared document remains available.",
                fromLine: 1,
                lineCount: 1,
              }
            : null,
      });
      const tool = createWikiGetTool(config, appConfig, { agentId: "main" });
      await expect(tool.execute("personal", { lookup: "sources/personal.md" })).rejects.toThrow(
        "Personal source sync offline",
      );
      sync.mockClear();
      const result = await tool.execute("shared", { lookup: "shared/project/spec" });
      expect(asRecord(result.details)).toMatchObject({
        found: true,
        vaultId: "project",
        revision: 3,
        content: "Shared document remains available.",
      });
      expect(sync).not.toHaveBeenCalled();
    } finally {
      sync.mockRestore();
      clearMemoryPluginState();
    }
  });

  it.each([
    {
      name: "unavailable",
      status: () => ({ available: false as const, reason: "not-configured" as const }),
      expectedStatus: "unavailable",
      expectedWarning: "not configured",
    },
    {
      name: "failed",
      status: () => ({ available: true as const }),
      expectedStatus: "failed",
      expectedWarning: "temporarily unavailable",
    },
  ])("keeps personal Wiki usable when organization memory is $name", async (scenario) => {
    const { rootDir, config } = await createVault({ initialize: true });
    await fs.writeFile(
      path.join(rootDir, "concepts", "personal.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.personal",
          title: "Personal fallback",
        },
        body: "# Personal fallback\n\nLOCAL_ONLY_MARKER\n",
      }),
      "utf8",
    );
    const search = vi.fn(async () => {
      throw new Error("organization search offline");
    });
    const get = vi.fn(async () => {
      throw new Error("organization get offline");
    });

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("platformclaw-org-memory", {
        includeByDefault: true,
        status: scenario.status,
        search,
        get,
      });
      const searchResult = await createWikiSearchTool(config, appConfig, {
        agentId: "main",
      }).execute("wiki-search-personal", { query: "LOCAL_ONLY_MARKER" });
      expect(asRecord(searchResult.details)).toMatchObject({
        results: [expect.objectContaining({ path: "concepts/personal.md" })],
        warnings: [expect.stringContaining(scenario.expectedWarning)],
        corpusStatus: [{ pluginId: "platformclaw-org-memory", status: scenario.expectedStatus }],
      });
      expect(search).toHaveBeenCalledTimes(scenario.name === "failed" ? 1 : 0);

      const getResult = await createWikiGetTool(config, appConfig, {
        agentId: "main",
      }).execute("wiki-get-org-unavailable", {
        lookup: "organization/part/missing",
      });
      expect(asRecord(getResult.details)).toMatchObject({
        found: false,
        warnings: [expect.stringContaining(scenario.expectedWarning)],
        corpusStatus: [{ pluginId: "platformclaw-org-memory", status: scenario.expectedStatus }],
      });
      expect(get).toHaveBeenCalledTimes(scenario.name === "failed" ? 1 : 0);
    } finally {
      clearMemoryPluginState();
    }
  });

  it("queries organization memory once when memory_search includes the Wiki supplement", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await fs.writeFile(
      path.join(rootDir, "concepts", "personal.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "concept",
          id: "concept.personal",
          title: "Personal PMU notes",
        },
        body: "# Personal PMU notes\n\nPMU register guidance\n",
      }),
      "utf8",
    );
    const organizationSearch = vi.fn(async () => [
      {
        corpus: "platformclaw-organization",
        path: "organization/part/pmu-registers",
        title: "PMU register map",
        kind: "part",
        score: 0.9,
        snippet: "Approved PMU register guidance",
      },
    ]);

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement(
        "memory-wiki",
        createWikiCorpusSupplement({
          getAppConfig: () => appConfig,
          resolveConfig: (agentId, currentAppConfig) =>
            resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
        }),
      );
      registerMemoryCorpusSupplement("platformclaw-org-memory", {
        includeByDefault: true,
        search: organizationSearch,
        get: async () => null,
      });
      const tool = createMemoryCoreTool({
        factories: registerMemoryCoreToolFactories(),
        name: "memory_search",
        agentId: "main",
        sandboxed: true,
      });

      const result = await tool.execute("memory-search-wiki-org", {
        query: "PMU register guidance",
        corpus: "wiki",
      });

      expect(asRecord(result.details).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ corpus: "wiki", path: "concepts/personal.md" }),
          expect.objectContaining({
            corpus: "platformclaw-organization",
            path: "organization/part/pmu-registers",
          }),
        ]),
      );
      expect(organizationSearch).toHaveBeenCalledTimes(1);
    } finally {
      clearMemoryPluginState();
    }
  });

  it("enforces bridge ownership through direct and registered corpus fallbacks", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      config: { vault: { scope: "global" } },
    });
    await writeBridgePage({
      rootDir,
      slug: "secondary-private",
      title: "Secondary Private",
      agentIds: ["secondary"],
      marker: "REDACTED-FOREIGN-MARKER",
    });
    await writeBridgePage({
      rootDir,
      slug: "main-private",
      title: "Main Private",
      agentIds: ["main"],
      marker: "REDACTED-OWN-MARKER",
    });
    await writeBridgePage({
      rootDir,
      slug: "unowned-private",
      title: "Unowned Private",
      agentIds: [],
      marker: "REDACTED-UNOWNED-MARKER",
    });
    const supplement = createWikiCorpusSupplement({
      getAppConfig: () => appConfig,
      resolveConfig: (agentId, currentAppConfig) =>
        resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
    });
    const caller = {
      agentId: "main",
      agentSessionKey: "agent:main:child-session",
      query: "REDACTED-FOREIGN-MARKER",
    };

    expect(await supplement.search({ ...caller, sandboxed: true })).toEqual([]);
    expect(
      await supplement.get({
        ...caller,
        sandboxed: true,
        lookup: "secondary-private",
      }),
    ).toBeNull();
    expect(
      (await supplement.search({ ...caller, sandboxed: false })).map((result) => result.path),
    ).toEqual(["sources/secondary-private.md"]);
    expect(
      (
        await supplement.get({
          ...caller,
          sandboxed: false,
          lookup: "secondary-private",
        })
      )?.content,
    ).toContain("REDACTED-FOREIGN-MARKER");

    clearMemoryPluginState();
    try {
      registerMemoryCorpusSupplement("memory-wiki", supplement);
      const factories = registerMemoryCoreToolFactories();
      const sandboxedGet = createMemoryCoreTool({
        factories,
        name: "memory_get",
        agentId: "main",
        sandboxed: true,
      });
      const sandboxedSearch = createMemoryCoreTool({
        factories,
        name: "memory_search",
        agentId: "main",
        sandboxed: true,
      });
      const openGet = createMemoryCoreTool({
        factories,
        name: "memory_get",
        agentId: "main",
        sandboxed: false,
      });
      const openSearch = createMemoryCoreTool({
        factories,
        name: "memory_search",
        agentId: "main",
        sandboxed: false,
      });

      const foreignGet = await sandboxedGet.execute("memory-get-foreign", {
        path: "sources/secondary-private.md",
        corpus: "wiki",
      });
      const unownedGet = await sandboxedGet.execute("memory-get-unowned", {
        path: "sources/unowned-private.md",
        corpus: "wiki",
      });
      const ownGet = await sandboxedGet.execute("memory-get-own", {
        path: "sources/main-private.md",
        corpus: "wiki",
      });
      const foreignSearch = await sandboxedSearch.execute("memory-search-foreign", {
        query: "REDACTED-FOREIGN-MARKER",
        corpus: "wiki",
      });
      const ownSearch = await sandboxedSearch.execute("memory-search-own", {
        query: "REDACTED-OWN-MARKER",
        corpus: "wiki",
      });
      const openForeignGet = await openGet.execute("memory-get-open-foreign", {
        path: "sources/secondary-private.md",
        corpus: "wiki",
      });
      const openForeignSearch = await openSearch.execute("memory-search-open-foreign", {
        query: "REDACTED-FOREIGN-MARKER",
        corpus: "wiki",
      });

      expect(asRecord(foreignGet.details)).toMatchObject({
        text: "",
        disabled: true,
        error: "wiki corpus result not found",
      });
      expect(asRecord(unownedGet.details)).toMatchObject({
        text: "",
        disabled: true,
        error: "wiki corpus result not found",
      });
      expect(asRecord(ownGet.details)).toMatchObject({
        path: "sources/main-private.md",
        text: expect.stringContaining("REDACTED-OWN-MARKER"),
      });
      expect(asRecord(foreignSearch.details).results).toEqual([]);
      expect(asRecord(ownSearch.details).results).toEqual([
        expect.objectContaining({ path: "sources/main-private.md" }),
      ]);
      expect(asRecord(openForeignGet.details)).toMatchObject({
        path: "sources/secondary-private.md",
        text: expect.stringContaining("REDACTED-FOREIGN-MARKER"),
      });
      expect(asRecord(openForeignSearch.details).results).toEqual([
        expect.objectContaining({ path: "sources/secondary-private.md" }),
      ]);
    } finally {
      clearMemoryPluginState();
    }
  }, 240_000);
});
