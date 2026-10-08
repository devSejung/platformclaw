import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  getMemoryWikiDocument,
  MemoryWikiEditConflictError,
  MemoryWikiEditValidationError,
  saveMemoryWikiDocument,
} from "./document-edit.js";
import { parseWikiMarkdown, renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import {
  readMemoryWikiSourceSyncState,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("personal Wiki document editing", () => {
  it("reports deletion capability independently of editing for authored reports and large pages", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    await fs.writeFile(
      path.join(rootDir, "reports/authored.md"),
      "---\npageType: report\ntitle: Authored\n---\n# Authored\nBody\n",
    );
    await fs.writeFile(
      path.join(rootDir, "concepts/large.md"),
      "# Large\n" + "a".repeat(260 * 1024),
    );
    expect(
      await getMemoryWikiDocument({ config: personal, lookup: "reports/authored.md" }),
    ).toMatchObject({ editMode: null, canDelete: true });
    expect(
      await getMemoryWikiDocument({ config: personal, lookup: "concepts/large.md" }),
    ).toMatchObject({ readOnlyReason: "page-too-large", canDelete: true });
    expect(await getMemoryWikiDocument({ config: personal, lookup: "index.md" })).toMatchObject({
      canDelete: false,
    });
    expect(await getMemoryWikiDocument({ config, lookup: "reports/authored.md" })).toMatchObject({
      canDelete: false,
    });
  });
  it("returns canonical per-reference navigation without guessing ambiguous titles", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await fs.writeFile(
      path.join(rootDir, "concepts/a.md"),
      "---\nid: first\ntitle: Duplicate\n---\nA",
    );
    await fs.writeFile(path.join(rootDir, "concepts/b.md"), "---\ntitle: Duplicate\n---\nB");
    const raw = "[[Duplicate]] [[FIRST]] [[concepts/a.md]] [B](b.md) [[missing]]";
    await fs.writeFile(path.join(rootDir, "concepts/source.md"), raw);
    const document = await getMemoryWikiDocument({ config, lookup: "concepts/source.md" });
    expect(document?.links).toEqual([
      { target: "Duplicate", documentId: null, logicalPath: "Duplicate", title: "Duplicate" },
      {
        target: "FIRST",
        documentId: "concepts/a.md",
        logicalPath: "concepts/a.md",
        title: "Duplicate",
      },
      {
        target: "concepts/a.md",
        documentId: "concepts/a.md",
        logicalPath: "concepts/a.md",
        title: "Duplicate",
      },
      {
        target: "concepts/b.md",
        documentId: "concepts/b.md",
        logicalPath: "concepts/b.md",
        title: "Duplicate",
      },
      { target: "missing", documentId: null, logicalPath: "missing", title: "missing" },
    ]);
    expect(document?.linksTruncated).toBe(false);
    expect(await fs.readFile(path.join(rootDir, "concepts/source.md"), "utf8")).toBe(raw);
  });
  it("loads shared vault documents read-only and rejects saves", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await fs.writeFile(path.join(rootDir, "concepts/alpha.md"), "# Shared alpha\n");
    const document = await getMemoryWikiDocument({ config, lookup: "concepts/alpha.md" });
    expect(document).toMatchObject({
      displayContent: "# Shared alpha",
      editMode: null,
      readOnlyReason: "shared-vault",
    });
    expect(document).not.toHaveProperty("editableContent");
    expect(document?.revision).toBe(createHash("sha256").update("# Shared alpha\n").digest("hex"));
    await expect(
      saveMemoryWikiDocument({
        config,
        path: "concepts/alpha.md",
        editMode: "body",
        content: "changed",
        expectedRevision: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(MemoryWikiEditValidationError);
  });

  it("saves only the body, preserves protected frontmatter, and rejects a stale revision", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    const pagePath = "concepts/alpha.md";
    await fs.writeFile(
      path.join(rootDir, pagePath),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.alpha", sourceIds: ["private.source"] },
        body: "# Alpha\n\nOld body",
      }),
    );
    const document = await getMemoryWikiDocument({ config: personal, lookup: pagePath });
    expect(document).toMatchObject({ editMode: "body", editableContent: "# Alpha\n\nOld body" });
    expect(document?.sourceContent).toBe(await fs.readFile(path.join(rootDir, pagePath), "utf8"));
    expect(document?.revision).toBe(
      createHash("sha256").update(document!.sourceContent).digest("hex"),
    );
    const saved = await saveMemoryWikiDocument({
      config: personal,
      path: pagePath,
      editMode: "body",
      content: "# Alpha\n\nNew **body**",
      title: "Reviewed Alpha",
      expectedRevision: document!.revision!,
    });
    expect(saved).toMatchObject({ saved: true, indexesRefreshed: true });
    const parsed = parseWikiMarkdown(await fs.readFile(path.join(rootDir, pagePath), "utf8"));
    expect(parsed.frontmatter).toMatchObject({
      id: "concept.alpha",
      title: "Reviewed Alpha",
      sourceIds: ["private.source"],
    });
    expect(parsed.body).toContain("New **body**");
    await expect(
      getMemoryWikiDocument({ config: personal, lookup: pagePath }),
    ).resolves.toMatchObject({ editableContent: "# Alpha\n\nNew **body**" });
    await expect(
      saveMemoryWikiDocument({
        config: personal,
        path: pagePath,
        editMode: "body",
        content: "# Alpha\n\nNew **body**",
        expectedRevision: document!.revision!,
      }),
    ).resolves.toMatchObject({ saved: false, revision: saved.revision });
    await expect(
      saveMemoryWikiDocument({
        config: personal,
        path: pagePath,
        editMode: "body",
        content: "stale overwrite",
        expectedRevision: document!.revision!,
      }),
    ).rejects.toBeInstanceOf(MemoryWikiEditConflictError);
    expect(await fs.readFile(path.join(rootDir, pagePath), "utf8")).toContain("New **body**");
  });

  it("does not unwrap a user-authored Markdown code block", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    await fs.writeFile(
      path.join(rootDir, "concepts/code.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "concept", id: "concept.code" },
        body: "# Code sample\n\n```markdown\n# This stays code\n```",
      }),
    );
    await expect(
      getMemoryWikiDocument({ config: personal, lookup: "concepts/code.md" }),
    ).resolves.toMatchObject({
      editMode: "body",
      displayContent: "# Code sample\n\n```markdown\n# This stays code\n```",
    });
  });

  it("unwraps only a trusted bridge Markdown payload and preserves edited Notes on sync", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    const sourcePath = path.join(rootDir, "bridge-source.md");
    await fs.writeFile(sourcePath, "# Source heading\n\n| A | B |\n| - | - |\n| 1 | 2 |");
    const pagePath = "sources/bridge.md";
    const buildRendered = (raw: string) =>
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          title: "Bridge",
          sourceType: "memory-bridge",
          sourcePath,
        },
        body: [
          "# Memory Bridge: source",
          "",
          "## Bridge Source",
          "- Workspace: `/private/workspace`",
          "",
          "## Content",
          renderMarkdownFence(raw, "markdown"),
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
        ].join("\n"),
      });
    const state = await readMemoryWikiSourceSyncState(rootDir);
    await writeImportedSourcePage({
      vaultRoot: rootDir,
      syncKey: sourcePath,
      sourcePath,
      sourceUpdatedAtMs: 1,
      sourceSize: 1,
      renderFingerprint: "one",
      pagePath,
      group: "bridge",
      state,
      buildRendered: (raw) => buildRendered(raw),
    });
    await writeMemoryWikiSourceSyncState(rootDir, state);
    const document = await getMemoryWikiDocument({ config: personal, lookup: pagePath });
    expect(document).toMatchObject({ editMode: "notes" });
    expect(document!.displayContent).toContain("# Source heading");
    expect(document!.displayContent).not.toContain("/private/workspace");
    await saveMemoryWikiDocument({
      config: personal,
      path: pagePath,
      editMode: "notes",
      content: "My **note**",
      expectedRevision: document!.revision!,
    });
    await fs.writeFile(sourcePath, "# Source heading\n\nUpdated");
    const refreshedState = await readMemoryWikiSourceSyncState(rootDir);
    await writeImportedSourcePage({
      vaultRoot: rootDir,
      syncKey: sourcePath,
      sourcePath,
      sourceUpdatedAtMs: 2,
      sourceSize: 2,
      renderFingerprint: "two",
      pagePath,
      group: "bridge",
      state: refreshedState,
      buildRendered: (raw) => buildRendered(raw),
    });
    const afterSync = await fs.readFile(path.join(rootDir, pagePath), "utf8");
    expect(afterSync).toContain("My **note**");
    expect(afterSync).toContain("Updated");
    expect(await fs.readFile(sourcePath, "utf8")).not.toContain("My **note**");
  });

  it("keeps reports read-only", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    const personal = {
      ...config,
      agentId: "main",
      vault: { ...config.vault, scope: "agent" as const },
    };
    await fs.writeFile(path.join(rootDir, "reports/custom.md"), "# Generated report\n");
    await expect(
      getMemoryWikiDocument({ config: personal, lookup: "reports/custom.md" }),
    ).resolves.toMatchObject({
      editMode: null,
      readOnlyReason: "generated-report",
    });
    await fs.writeFile(
      path.join(rootDir, "reports/with-notes.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "report", id: "report.with-notes" },
        body: [
          "# Report",
          "",
          "Generated result",
          "",
          "## Notes",
          "<!-- openclaw:human:start -->",
          "<!-- openclaw:human:end -->",
        ].join("\n"),
      }),
    );
    await expect(
      getMemoryWikiDocument({ config: personal, lookup: "reports/with-notes.md" }),
    ).resolves.toMatchObject({ editMode: "notes", editableContent: "" });
  });

  it.each([
    {
      path: "reports/custom.md",
      pageType: "report",
      visible: "Generated insight",
      body: [
        "# Report",
        "",
        "<!-- openclaw:wiki:generated:start -->",
        "Generated insight",
        "<!-- openclaw:wiki:generated:end -->",
      ].join("\n"),
    },
    {
      path: "reports/with-notes.md",
      pageType: "report",
      visible: "Keep this note",
      body: [
        "# Report with notes",
        "",
        "<!-- openclaw:wiki:lint:start -->",
        "Generated lint result",
        "<!-- openclaw:wiki:lint:end -->",
        "",
        "## Notes",
        "<!-- openclaw:human:start -->",
        "Keep this note",
        "<!-- openclaw:human:end -->",
      ].join("\n"),
    },
  ])(
    "hides managed markers from the $path preview while preserving downloadable source",
    async (fixture) => {
      const { rootDir, config } = await createVault({ initialize: true });
      const personal = {
        ...config,
        agentId: "main",
        vault: { ...config.vault, scope: "agent" as const },
      };
      await fs.mkdir(path.dirname(path.join(rootDir, fixture.path)), { recursive: true });
      await fs.writeFile(
        path.join(rootDir, fixture.path),
        renderWikiMarkdown({
          frontmatter: { pageType: fixture.pageType, title: fixture.path },
          body: fixture.body,
        }),
      );

      const document = await getMemoryWikiDocument({ config: personal, lookup: fixture.path });
      expect(document?.displayContent).not.toContain("<!-- openclaw:");
      expect(document?.sourceContent).toBe(
        await fs.readFile(path.join(rootDir, fixture.path), "utf8"),
      );
      expect(document?.displayContent).toContain(fixture.visible);
      expect(await fs.readFile(path.join(rootDir, fixture.path), "utf8")).toContain(
        "<!-- openclaw:",
      );
    },
  );
});
