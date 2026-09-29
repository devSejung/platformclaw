import fs from "node:fs/promises";
import path from "node:path";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { createMemoryWikiDocument, getMemoryWikiDocument } from "./document-edit.js";
import { parseWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const harness = createMemoryWikiTestHarness();
afterEach(() => clearMemoryPluginState());

async function tools() {
  const { api, registerTool } = harness.createPluginApi();
  const rootDir = await harness.createTempDir("wiki-hub-tools-");
  api.config = { agents: { list: [{ id: "owner", default: true }] } };
  api.pluginConfig = { vault: { scope: "agent", path: rootDir } };
  plugin.register(api);
  const registered = new Map<string, AnyAgentTool>();
  for (const [factory, registration] of registerTool.mock.calls) {
    const tool = (factory as OpenClawPluginToolFactory)({ agentId: "owner", runId: "turn" });
    if (tool && !Array.isArray(tool)) {
      registered.set(registration.name, tool);
    }
  }
  return {
    rootDir,
    tool(name: string) {
      return registered.get(name)!;
    },
    async call(name: string, input: Record<string, unknown>) {
      const tool = registered.get(name)!;
      expect(Value.Check(tool.parameters, input)).toBe(true);
      return await tool.execute(`call-${name}`, input);
    },
  };
}

describe("registered Wiki Hub tool flow", () => {
  it("creates, searches, reads and updates Personal with current revision and preserved metadata", async () => {
    const test = await tools();
    expect(test.tool("wiki_apply").description).toContain("personal:owner");
    const created = await test.call("wiki_apply", {
      op: "create",
      vaultId: "personal:owner",
      title: "Calibration",
      body: "Training window specification",
    });
    const saved = created.details as { path: string; revision: string };
    const search = await test.call("wiki_search", { query: "Training" });
    expect(search.details).toMatchObject({
      results: [
        expect.objectContaining({
          vaultId: "personal:owner",
          path: saved.path,
          title: "Calibration",
        }),
      ],
    });
    const read = await test.call("wiki_get", { lookup: saved.path });
    expect(read.details).toMatchObject({
      revision: saved.revision,
      editMode: "body",
      content: "Training window specification",
    });
    await test.call("wiki_apply", {
      op: "update",
      vaultId: "personal:owner",
      lookup: saved.path,
      expectedRevision: saved.revision,
      body: "Training window revised",
    });
    const raw = await fs.readFile(path.join(test.rootDir, "owner", saved.path), "utf8");
    expect(parseWikiMarkdown(raw).frontmatter.title).toBe("Calibration");
    expect(parseWikiMarkdown(raw).body).toContain("Training window revised");
    const conflict = await test.call("wiki_apply", {
      op: "update",
      vaultId: "personal:owner",
      lookup: saved.path,
      expectedRevision: saved.revision,
      body: "Stale overwrite",
    });
    expect(JSON.stringify(conflict)).toContain("Reload");
    expect(await fs.readFile(path.join(test.rootDir, "owner", saved.path), "utf8")).toBe(raw);
  });

  it("dispatches an explicitly named Shared write and preserves safe owner outcomes", async () => {
    const test = await tools();
    const wiki = vi.fn(async () => ({
      text: "Saved Shared revision 8",
      details: { vaultId: "shared-one", revision: "8" },
    }));
    registerMemoryCorpusSupplement("wiki-owner", {
      includeByDefault: true,
      search: async () => [],
      get: async () => null,
      wiki,
    });
    await test.call("wiki_apply", {
      op: "update",
      vaultName: "DDRPHY",
      lookup: "shared/shared-one/doc",
      expectedRevision: "7",
      body: "Training",
    });
    expect(wiki).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "owner",
        runId: "turn",
        vaultName: "DDRPHY",
        operation: "apply",
        mutation: {
          op: "update",
          lookup: "shared/shared-one/doc",
          expectedRevision: "7",
          body: "Training",
        },
      }),
    );
    wiki.mockRejectedValueOnce(
      Object.assign(new Error("private SQL"), {
        memoryCorpusFailure: {
          error: "Permission denied",
          action: "Request Editor access from the Wiki owner.",
        },
      }),
    );
    const denied = await test.call("wiki_apply", { op: "refresh", vaultId: "shared-one" });
    expect(JSON.stringify(denied)).toContain("Request Editor access");
    expect(JSON.stringify(denied)).not.toContain("private SQL");
    expect(Value.Check(test.tool("wiki_apply").parameters, { op: "refresh" })).toBe(false);
  });

  it("pages only complete visible Shared lines and never skips a long-line tail", async () => {
    const test = await tools();
    const get = vi.fn(async () => ({
      corpus: "shared",
      path: "shared/project-one/doc-one",
      title: "Spec",
      content: "visible\n" + "x".repeat(4000),
      fromLine: 1,
      lineCount: 2,
      revision: "1",
      editMode: "body" as const,
      totalLines: 2,
      truncated: false,
    }));
    registerMemoryCorpusSupplement("shared", {
      includeByDefault: true,
      search: async () => [],
      get,
    });
    const first = await test.call("wiki_get", { lookup: "shared/project-one/doc-one" });
    expect(first.details).toMatchObject({
      content: "visible",
      lineCount: 1,
      truncated: true,
      nextFromLine: 2,
    });
    get.mockResolvedValueOnce({
      corpus: "shared",
      path: "shared/project-one/doc-one",
      title: "Spec",
      content: "x".repeat(4000),
      fromLine: 2,
      lineCount: 1,
      revision: "1",
      editMode: "body",
      totalLines: 2,
      truncated: false,
    });
    const next = await test.call("wiki_get", { lookup: "shared/project-one/doc-one", fromLine: 2 });
    expect(next.details).toMatchObject({ lineCount: 0, truncated: true, nextFromLine: undefined });
    expect(JSON.stringify(next)).toContain("Open the document in Wiki Hub");
    const longPath = `shared/${"p".repeat(500)}/doc`;
    get.mockResolvedValueOnce({
      corpus: "shared",
      path: longPath,
      title: "Spec",
      content: "y".repeat(2900) + "\n" + "z".repeat(500),
      fromLine: 1,
      lineCount: 2,
      revision: "1",
      editMode: "body",
      totalLines: 2,
      truncated: false,
    });
    const bounded = await test.call("wiki_get", { lookup: longPath });
    expect(bounded.details).toMatchObject({
      content: "y".repeat(2900),
      lineCount: 1,
      nextFromLine: 2,
    });
    expect(bounded.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("y".repeat(2900)),
    });
    expect((bounded.content[0] as { text: string }).text.length).toBeLessThanOrEqual(4000);
  });

  it("keeps default status metadata compact instead of injecting a vault catalog", async () => {
    const test = await tools();
    registerMemoryCorpusSupplement("catalog", {
      includeByDefault: true,
      search: async () => [],
      get: async () => null,
      wiki: async () => ({
        text: "Enabled Wiki status.",
        details: { wikis: Array.from({ length: 50 }, () => ({ vaultName: "x".repeat(240) })) },
      }),
    });
    const result = await test.call("wiki_status", {});
    expect(result.details).toEqual({ scope: "enabled", checkedOwners: 2 });
    expect(JSON.stringify(result).length).toBeLessThan(4500);
  });

  it("omits disabled Personal by default but permits an explicit authorized target", async () => {
    const test = await tools();
    await test.call("wiki_apply", {
      op: "create",
      vaultId: "personal:owner",
      title: "Private",
      body: "hiddenmarker",
    });
    registerMemoryCorpusSupplement("selection", {
      includeByDefault: true,
      search: async () => [],
      get: async () => null,
      scope: async () => ({ personalWikiEnabled: false }),
    });
    expect((await test.call("wiki_search", { query: "hiddenmarker" })).details).toMatchObject({
      results: [],
    });
    expect(
      (await test.call("wiki_search", { query: "hiddenmarker", vaultId: "personal:owner" }))
        .details,
    ).toMatchObject({ results: [expect.objectContaining({ vaultId: "personal:owner" })] });
  });
});

describe("Personal source creation", () => {
  it("keeps duplicate raw filenames and source bytes, and stores explicit title overrides", async () => {
    const { config, rootDir } = await harness.createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "owner",
      vault: { ...config.vault, scope: "agent" as const },
    };
    const content = "plain source\r\n  original spacing\r\n";
    const first = await createMemoryWikiDocument({
      config: personal,
      filename: "Original.md",
      title: "Original",
      content,
    });
    const second = await createMemoryWikiDocument({
      config: personal,
      filename: "Original.md",
      title: "Original",
      content,
    });
    expect(first.path).not.toBe(second.path);
    for (const saved of [first, second]) {
      expect(path.basename(saved.path)).toBe("Original.md");
      expect(await fs.readFile(path.join(rootDir, saved.path), "utf8")).toBe(content);
      expect(await getMemoryWikiDocument({ config: personal, lookup: saved.path })).toMatchObject({
        title: "Original",
      });
    }
    const source = "---\nother: preserved\ntitle: Old\n---\n\n  Body stays exact\r\n";
    const override = await createMemoryWikiDocument({
      config: personal,
      filename: "Original.md",
      title: "Reviewed title",
      content: source,
    });
    const parsed = parseWikiMarkdown(await fs.readFile(path.join(rootDir, override.path), "utf8"));
    expect(parsed.frontmatter).toEqual({ other: "preserved", title: "Reviewed title" });
    expect(parsed.body).toBe(parseWikiMarkdown(source).body);
  });
});
