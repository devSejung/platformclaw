// Memory Wiki tests cover tool plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import {
  createWikiApplyTool,
  createWikiGetTool,
  createWikiLintTool,
  createWikiSearchTool,
} from "./tool.js";

function asSchemaObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON schema object");
  }
  return value as Record<string, unknown>;
}

describe("memory-wiki tools", () => {
  const harness = createMemoryWikiTestHarness();

  it("exposes only bounded common mutations with an explicit Wiki target", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    expect(
      Value.Check(tool.parameters, {
        op: "create",
        vaultId: "personal:main",
        title: "Spec",
        body: "source",
      }),
    ).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        op: "update",
        vaultId: "shared-one",
        lookup: "shared/shared-one/doc",
        expectedRevision: "7",
        body: "new",
      }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { op: "refresh" })).toBe(false);
    expect(Value.Check(tool.parameters, { op: "metadata", vaultId: "personal:main" })).toBe(false);
    expect(Value.Check(tool.parameters, { op: "create", vaultId: "one", vaultName: "two" })).toBe(
      false,
    );
    expect(
      Value.Check(tool.parameters, { op: "create", vaultId: "one", body: "x".repeat(262145) }),
    ).toBe(false);
    const properties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    expect(Object.keys(properties).toSorted()).toEqual([
      "body",
      "expectedRevision",
      "lookup",
      "op",
      "title",
      "vaultId",
      "vaultName",
    ]);
  });

  it("keeps backend selection out of the agent retrieval schemas", () => {
    const config = {} as ResolvedMemoryWikiConfig;
    const search = asSchemaObject(
      asSchemaObject(createWikiSearchTool(config).parameters).properties,
    );
    const get = asSchemaObject(asSchemaObject(createWikiGetTool(config).parameters).properties);
    expect(Object.keys(search).toSorted()).toEqual([
      "maxResults",
      "mode",
      "query",
      "vaultId",
      "vaultName",
    ]);
    expect(search.vaultId).toMatchObject({ maxLength: 256 });
    expect(search.maxResults).toMatchObject({ maximum: 50 });
    expect(Object.keys(get).toSorted()).toEqual(["fromLine", "lineCount", "lookup"]);
  });

  it("returns tool-safe relative report paths from wiki_lint", async () => {
    const { rootDir, config } = await harness.createVault({ initialize: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "syntheses", "bad.md"),
      [
        "---",
        "id: synth-bad",
        "pageType: synthesis",
        "title: Bad Page",
        "---",
        "",
        "This links to [[Missing Page]].",
      ].join("\n"),
      "utf8",
    );

    const tool = createWikiLintTool(config);
    const result = await tool.execute("lint-call", { vaultId: "personal:main" });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const details = asSchemaObject(result.details);

    expect(text).toContain("issues");
    expect(text).not.toContain(rootDir);
    expect(details.reportPath).toBe("reports/lint.md");
    expect(details).not.toHaveProperty("vaultRoot");
    expect(JSON.stringify(details)).not.toContain(rootDir);
    expect(details.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "broken-wikilink" })]),
    );

    const lintResult = await lintMemoryWikiVault(config);
    expect(path.isAbsolute(lintResult.reportPath)).toBe(true);
    expect(lintResult.reportPath).toContain(rootDir);
  });
});
