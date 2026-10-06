import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadMemoryWikiSearchSnapshot, readMemoryWikiCompileFailure } from "./compiled-cache.js";
import { deleteMemoryWikiPage } from "./delete.js";
import {
  getMemoryWikiDocument,
  importMemoryWikiDocuments,
  MemoryWikiEditValidationError,
  saveMemoryWikiDocument,
} from "./document-edit.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { parseWikiMarkdown } from "./markdown.js";
import { resolveMemoryWikiPromotionReferences } from "./promotion-references.js";
import { readQueryableWikiPages, searchMemoryWiki } from "./query.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { listMemoryWikiGraph } from "./wiki-graph.js";

const { createVault, createPluginApi } = createMemoryWikiTestHarness();
const importId = "00000000-0000-4000-8000-000000000001";
const nextImportId = "00000000-0000-4000-8000-000000000002";
const rootPath = "concepts/imports/" + importId;
const hash = (content: string) => createHash("sha256").update(content).digest("hex");

async function personalVault() {
  const vault = await createVault({
    initialize: true,
    config: { render: { createDashboards: false }, search: { backend: "local", corpus: "wiki" } },
  });
  return {
    ...vault,
    config: {
      ...vault.config,
      agentId: "main",
      vault: { ...vault.config.vault, scope: "agent" as const },
    },
  };
}

describe("personal Markdown batch import", () => {
  it("imports folders through the gateway and preserves source, links, indexes and search", async () => {
    const { rootDir, config } = await personalVault();
    const { api, registerGatewayMethod } = createPluginApi();
    registerMemoryWikiGatewayMethods({ api, config, resolveConfig: () => config });
    const registration = registerGatewayMethod.mock.calls.find(
      ([method]) => method === "wiki.document.import",
    );
    expect(registration?.[2]).toEqual({ scope: "operator.write" });
    const handler = registration![1] as (context: {
      params: Record<string, unknown>;
      respond: ReturnType<typeof vi.fn>;
    }) => Promise<void>;
    const documents = [
      {
        relativePath: "index.md",
        content:
          "# Import entry\n\n[[Guides/Timing]] [Timing](Guides/Timing.markdown#limits) " +
          "[Training][train] [[Cafe%CC%81%20notes]]\n\n[train]: Guides/Training.MD#step\n",
      },
      {
        relativePath: "Guides/Timing.markdown",
        content:
          "---\nid: timing-id\ntitle: Detailed timings\n---\n# Timings\n\n" +
          "[[Training]] [[./Training.md]] [Entry](../index.md) [[Missing]] " +
          "[[Guides/Training]]\n",
      },
      {
        relativePath: "Guides/Training.MD",
        content: "# A title different from the filename\n\nBatch search sentinel.\n",
      },
      { relativePath: "Cafe\u0301 notes.md", content: "# Coffee\n\nPreserve Unicode paths.\n" },
    ];
    const respond = vi.fn();
    await handler({ params: { agentId: "main", importId, documents }, respond });
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, result] = respond.mock.calls[0]!;
    expect(ok).toBe(true);
    expect(result).toMatchObject({
      importId,
      rootPath,
      indexesRefreshed: true,
      documents: documents.map((document) => ({
        relativePath: document.relativePath,
        status: "saved",
        revision: hash(document.content),
      })),
    });
    for (const document of documents) {
      const canonical = document.relativePath
        .normalize("NFC")
        .replace(/\.(?:md|markdown)$/iu, ".md");
      expect(await fs.readFile(path.join(rootDir, rootPath, canonical), "utf8")).toBe(
        document.content,
      );
    }
    const entry = await getMemoryWikiDocument({ config, lookup: rootPath + "/index.md" });
    expect(entry?.editMode).toBe("body");
    expect(entry?.sourceContent).toBe(documents[0]!.content);
    expect(entry?.links.map((link) => link.documentId)).toEqual([
      rootPath + "/Guides/Timing.md",
      rootPath + "/Guides/Timing.md",
      rootPath + "/Guides/Training.md",
      rootPath + "/Café notes.md",
    ]);
    const timing = await getMemoryWikiDocument({ config, lookup: rootPath + "/Guides/Timing.md" });
    expect(timing?.links.map((link) => link.documentId)).toEqual([
      rootPath + "/Guides/Training.md",
      rootPath + "/Guides/Training.md",
      rootPath + "/index.md",
      null,
      rootPath + "/Guides/Training.md",
    ]);
    const graph = await listMemoryWikiGraph(config);
    expect(graph.nodes.some((node) => node.id === rootPath + "/index.md")).toBe(true);
    expect(graph.edges).toContainEqual({
      type: "reference",
      source: rootPath + "/Guides/Timing.md",
      target: rootPath + "/index.md",
    });
    expect(graph.stats.unresolvedLinks).toBe(1);
    expect(
      (await loadMemoryWikiSearchSnapshot(config))?.searchPages?.map((page) => page.relativePath),
    ).toContain(rootPath + "/index.md");
    expect(
      (await searchMemoryWiki({ config, query: "Batch search sentinel" })).map((hit) => hit.path),
    ).toContain(rootPath + "/Guides/Training.md");
  });

  it("keeps shorthand links in their import and leaves duplicate names or IDs unresolved", async () => {
    const { config } = await personalVault();
    const documents = [
      {
        relativePath: "Source.md",
        content: "# Source\n\n[[Target]] [[same-id]] [[Shared title]] [[Outside only]]",
      },
      { relativePath: "Target.md", content: "---\nid: same-id\ntitle: Shared title\n---\nTarget" },
    ];
    await importMemoryWikiDocuments({
      config,
      importId,
      documents: [...documents, { relativePath: "Outside only.md", content: "First import only" }],
    });
    await importMemoryWikiDocuments({ config, importId: nextImportId, documents });
    const nextRoot = "concepts/imports/" + nextImportId;
    const second = await getMemoryWikiDocument({ config, lookup: nextRoot + "/Source.md" });
    expect(second?.links.map((link) => link.documentId)).toEqual([
      nextRoot + "/Target.md",
      nextRoot + "/Target.md",
      nextRoot + "/Target.md",
      null,
    ]);
    const proposedText = "[[Target]] [[Outside only]]";
    const publication = await resolveMemoryWikiPromotionReferences({
      config,
      lookup: nextRoot + "/Source.md",
      proposedText,
    });
    if (!publication || !("references" in publication)) {
      throw new Error("Imported source references must be available.");
    }
    expect(publication.references[0]).toMatchObject({ claimId: "same-id", kind: "personal" });
    expect(publication.references[1]).toEqual({
      start: proposedText.indexOf("[[Outside"),
      end: proposedText.length,
    });
    await importMemoryWikiDocuments({
      config,
      importId: nextImportId,
      documents: [
        {
          relativePath: "Nested/Target.md",
          content: "---\nid: same-id\ntitle: Shared title\n---\nAnother target",
        },
      ],
    });
    const ambiguous = await getMemoryWikiDocument({ config, lookup: nextRoot + "/Source.md" });
    // Root-relative file paths remain exact; duplicate shorthand ID/title references do not guess.
    expect(ambiguous?.links.map((link) => link.documentId)).toEqual([
      nextRoot + "/Target.md",
      null,
      null,
      null,
    ]);
  });

  it("resolves explicit root links only to vault paths through the saved reader and graph", async () => {
    const { rootDir, config } = await personalVault();
    await fs.writeFile(path.join(rootDir, "concepts", "Root.md"), "# Vault root target\n");
    await fs.writeFile(path.join(rootDir, "concepts", "Fallback.md"), "# Vault path fallback\n");
    await importMemoryWikiDocuments({
      config,
      importId,
      documents: [
        {
          relativePath: "Guides/Source.md",
          content:
            "# Source\n\n[Root](/concepts/Root.md#Heading) [[/concepts/Root]] " +
            "[Missing](/concepts/Missing.md) [[/concepts/Missing-wiki.md]] [[concepts/Missing]] " +
            "[[concepts/Root.md]] [[CONCEPTS/ROOT.markdown]] [[concepts/Fallback]]",
        },
        { relativePath: "concepts/Root.md", content: "# Imported root target\n" },
        { relativePath: "concepts/Missing.md", content: "# Scoped document\n" },
        { relativePath: "concepts/Missing-wiki.md", content: "# Scoped Wiki target\n" },
      ],
    });
    const source = await getMemoryWikiDocument({ config, lookup: rootPath + "/Guides/Source.md" });
    expect(source?.links.map((link) => link.documentId)).toEqual([
      "concepts/Root.md",
      "concepts/Root.md",
      null,
      null,
      rootPath + "/concepts/Missing.md",
      rootPath + "/concepts/Root.md",
      rootPath + "/concepts/Root.md",
      "concepts/Fallback.md",
    ]);
    const graph = await listMemoryWikiGraph(config);
    expect(graph.edges).toContainEqual({
      type: "reference",
      source: rootPath + "/Guides/Source.md",
      target: "concepts/Root.md",
    });
    expect(graph.edges).toContainEqual({
      type: "reference",
      source: rootPath + "/Guides/Source.md",
      target: rootPath + "/concepts/Root.md",
    });
    expect(graph.stats.unresolvedLinks).toBe(2);
  });

  it("resumes one namespace after partial failures without duplicating or overwriting saved files", async () => {
    const { rootDir, config } = await personalVault();
    const original = [
      { relativePath: "Edited.md", content: "Original" },
      { relativePath: "Untouched.md", content: "Keep" },
    ];
    await importMemoryWikiDocuments({ config, importId, documents: original });
    await fs.writeFile(path.join(rootDir, rootPath, "Edited.md"), "Concurrent edit");
    await fs.mkdir(path.join(rootDir, rootPath, "Blocked.md"));
    const documents = [
      ...original,
      { relativePath: "Blocked.md", content: "Cannot replace a directory" },
      { relativePath: "New.md", content: "Resume me" },
    ];
    const resumed = await importMemoryWikiDocuments({ config, importId, documents });
    expect(resumed.documents.map((document) => document.status)).toEqual([
      "failed",
      "unchanged",
      "failed",
      "saved",
    ]);
    expect(resumed.documents[0]).toMatchObject({ error: "conflict" });
    expect(resumed.documents[2]).toMatchObject({ error: "unavailable" });
    expect(resumed.indexesRefreshed).toBe(true);
    expect(await fs.readFile(path.join(rootDir, rootPath, "Edited.md"), "utf8")).toBe(
      "Concurrent edit",
    );
    expect(
      (await readQueryableWikiPages(rootDir)).filter((page) =>
        page.relativePath.startsWith(rootPath),
      ),
    ).toHaveLength(3);
    const caseCollision = await importMemoryWikiDocuments({
      config,
      importId,
      documents: [{ relativePath: "untouched.md", content: "Keep" }],
    });
    expect(caseCollision.documents[0]).toMatchObject({ status: "failed", error: "conflict" });
    const retry = await importMemoryWikiDocuments({
      config,
      importId,
      documents: [documents[1]!, documents[3]!],
    });
    expect(retry.documents.map((document) => document.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("preserves committed sources and the last search snapshot when compilation fails", async () => {
    const { rootDir, config } = await personalVault();
    await importMemoryWikiDocuments({
      config,
      importId,
      documents: [{ relativePath: "Before.md", content: "Before failure" }],
    });
    await fs.writeFile(path.join(rootDir, "concepts/broken.md"), "---\na: [\n---\nBroken");
    const documents = [{ relativePath: "After.md", content: "Committed despite index failure" }];
    const result = await importMemoryWikiDocuments({ config, importId, documents });
    expect(result).toMatchObject({ indexesRefreshed: false, documents: [{ status: "saved" }] });
    expect(await fs.readFile(path.join(rootDir, rootPath, "After.md"), "utf8")).toBe(
      documents[0]!.content,
    );
    expect(await readMemoryWikiCompileFailure(config)).not.toBeNull();
    expect(
      (await loadMemoryWikiSearchSnapshot(config))?.searchPages?.map((page) => page.relativePath),
    ).not.toContain(rootPath + "/After.md");
    await fs.writeFile(path.join(rootDir, "concepts/broken.md"), "# Repaired\n");
    expect(await importMemoryWikiDocuments({ config, importId, documents })).toMatchObject({
      indexesRefreshed: true,
      documents: [{ status: "unchanged" }],
    });
    expect(await readMemoryWikiCompileFailure(config)).toBeNull();
    expect(
      (await searchMemoryWiki({ config, query: "Committed despite index failure" })).map(
        (hit) => hit.path,
      ),
    ).toContain(rootPath + "/After.md");
  });

  it("rejects unsafe or ambiguous paths, oversized sources and excess batches before writing any document", async () => {
    const { rootDir, config } = await personalVault();
    const valid = { relativePath: "Valid.md", content: "Never partially saved" };
    for (const documents of [
      [valid, { relativePath: "../escape.md", content: "Bad" }],
      [valid, { relativePath: "folder\\escape.md", content: "Bad" }],
      [valid, { relativePath: "/root.md", content: "Bad" }],
      [valid, { relativePath: "CON.md", content: "Bad" }],
      [valid, { relativePath: "control\u0000.md", content: "Bad" }],
      [valid, { relativePath: "control\u001f.md", content: "Bad" }],
      [valid, { relativePath: "control\u007f.md", content: "Bad" }],
      [valid, { relativePath: "valid.markdown", content: "Duplicate normalized path" }],
      [
        { relativePath: "Café.md", content: "One" },
        { relativePath: "Cafe\u0301.md", content: "Two" },
      ],
      [valid, { relativePath: "Huge.md", content: "x".repeat(1024 * 1024 + 1) }],
      Array.from({ length: 101 }, (_, index) => ({
        relativePath: index + ".md",
        content: "Bounded",
      })),
    ]) {
      await expect(
        importMemoryWikiDocuments({ config, importId, documents }),
      ).rejects.toBeInstanceOf(MemoryWikiEditValidationError);
    }
    expect(await readQueryableWikiPages(rootDir)).toHaveLength(0);
    await expect(
      importMemoryWikiDocuments({
        config: { ...config, vault: { ...config.vault, scope: "global" } },
        importId,
        documents: [valid],
      }),
    ).rejects.toBeInstanceOf(MemoryWikiEditValidationError);
  });

  it("reports invalid frontmatter per file while saving valid siblings without rewriting source", async () => {
    const { rootDir, config } = await personalVault();
    const documents = [
      { relativePath: "Malformed.md", content: "---\na: [\n---\nBroken" },
      { relativePath: "Valid.md", content: "---\ntitle: Exact source\n---\n\nKeep these bytes.\n" },
      { relativePath: "Nonmap.md", content: "---\n- sequence\n---\nNonmapping metadata" },
      { relativePath: "Plain.md", content: "Ordinary Markdown without metadata" },
    ];
    const result = await importMemoryWikiDocuments({ config, importId, documents });
    expect(result.documents.map((document) => document.status)).toEqual([
      "failed",
      "saved",
      "failed",
      "saved",
    ]);
    expect(result.documents[0]).toMatchObject({ error: "invalid" });
    expect(result.documents[2]).toMatchObject({ error: "invalid" });
    expect(result.indexesRefreshed).toBe(true);
    for (const document of [documents[1]!, documents[3]!]) {
      expect(await fs.readFile(path.join(rootDir, rootPath, document.relativePath), "utf8")).toBe(
        document.content,
      );
    }
    expect((await readQueryableWikiPages(rootDir)).map((page) => page.relativePath)).toEqual([
      rootPath + "/Plain.md",
      rootPath + "/Valid.md",
    ]);
  });

  it("preserves complete imported metadata through bounded reads and body edits", async () => {
    const { rootDir, config } = await personalVault();
    const title = "Title".repeat(3400);
    const sourceType = "external".repeat(50);
    const updatedAt = "timestamp".repeat(40);
    const content =
      `---\r\ntitle: ${title}\r\nsourceType: ${sourceType}\r\nupdatedAt: ${updatedAt}\r\n---\r\n` +
      "# Metadata source\r\n\r\nPreserve these source bytes.\r\n";
    const pagePath = rootPath + "/Metadata.md";
    const result = await importMemoryWikiDocuments({
      config,
      importId,
      documents: [{ relativePath: "Metadata.md", content }],
    });
    expect(result).toMatchObject({
      indexesRefreshed: true,
      documents: [
        { path: pagePath, status: "saved", title: title.slice(0, 240), revision: hash(content) },
      ],
    });
    expect(await getMemoryWikiDocument({ config, lookup: pagePath })).toMatchObject({
      path: pagePath,
      title: title.slice(0, 240),
      sourceType: sourceType.slice(0, 256),
      updatedAt: updatedAt.slice(0, 256),
      sourceContent: content,
      revision: hash(content),
    });
    expect(await fs.readFile(path.join(rootDir, pagePath), "utf8")).toBe(content);

    // Omitted title preserves authored metadata instead of applying its display projection.
    const editedBody = "# Updated source\n\nA body edit keeps the complete original metadata.";
    const saved = await saveMemoryWikiDocument({
      config,
      path: pagePath,
      editMode: "body",
      content: editedBody,
      expectedRevision: hash(content),
    });
    expect(saved.saved).toBe(true);
    const edited = parseWikiMarkdown(await fs.readFile(path.join(rootDir, pagePath), "utf8"));
    expect(edited.frontmatter).toMatchObject({ title, sourceType, updatedAt: expect.any(String) });
    expect(edited.frontmatter.updatedAt).not.toBe(updatedAt);
    expect(edited.body.trim()).toBe(editedBody);
  });

  it("can delete an imported source larger than the editor limit without touching another personal vault", async () => {
    const { rootDir, config } = await personalVault();
    const other = await personalVault();
    const content = "# Large import\n" + "source ".repeat(40000);
    const documents = [{ relativePath: "Large.md", content }];
    const first = await importMemoryWikiDocuments({ config, importId, documents });
    await importMemoryWikiDocuments({ config: other.config, importId, documents });
    const document = await getMemoryWikiDocument({ config, lookup: rootPath + "/Large.md" });
    expect(document).toMatchObject({ editMode: null, readOnlyReason: "page-too-large" });
    const saved = first.documents[0]!;
    if (saved.status === "failed") {
      throw new Error("Expected a saved source");
    }
    expect(
      await deleteMemoryWikiPage({
        config,
        path: saved.path,
        expectedContentHash: saved.revision,
      }),
    ).toMatchObject({ deleted: true, indexesRefreshed: true });
    await expect(fs.access(path.join(rootDir, saved.path))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(path.join(other.rootDir, saved.path), "utf8")).toBe(content);
  });
});
