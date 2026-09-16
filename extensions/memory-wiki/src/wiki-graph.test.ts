// Memory Wiki tests cover deterministic explicit document graph projection.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderWikiMarkdown,
  WIKI_RELATED_END_MARKER,
  WIKI_RELATED_START_MARKER,
} from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { listMemoryWikiGraph } from "./wiki-graph.js";

const { createVault } = createMemoryWikiTestHarness();

async function writePage(params: {
  rootDir: string;
  relativePath: string;
  title: string;
  body?: string;
  updatedAt?: string;
}) {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(
    absolutePath,
    renderWikiMarkdown({
      frontmatter: {
        pageType: params.relativePath.split("/")[0]?.replace(/s$/, ""),
        title: params.title,
        ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
      },
      body: `# ${params.title}\n\n${params.body ?? ""}`,
    }),
    "utf8",
  );
}

describe("listMemoryWikiGraph", () => {
  it("separates index membership, authored references, confirmed relations, and candidates", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await writePage({ rootDir, relativePath: "concepts/target.md", title: "Target" });
    const sourcePath = path.join(rootDir, "syntheses", "source.md");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      renderWikiMarkdown({
        frontmatter: {
          pageType: "synthesis",
          title: "Source",
          relationships: [
            {
              targetPath: "concepts/target.md",
              kind: "enrichment",
              status: "confirmed",
            },
            {
              targetPath: "concepts/target.md",
              kind: "conflict",
              status: "candidate",
            },
          ],
        },
        body: "# Source\n\nAuthored [[concepts/target.md]].",
      }),
      "utf8",
    );

    const graph = await listMemoryWikiGraph(config);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        {
          source: "syntheses/index.md",
          target: "syntheses/source.md",
          type: "membership",
        },
        {
          source: "syntheses/source.md",
          target: "concepts/target.md",
          type: "reference",
        },
        {
          source: "syntheses/source.md",
          target: "concepts/target.md",
          type: "related",
          kind: "enrichment",
        },
        {
          source: "syntheses/source.md",
          target: "concepts/target.md",
          type: "candidate",
          kind: "conflict",
        },
      ]),
    );
  });

  it("uses rendered first-definition references and excludes unused definition-only targets", async () => {
    const { rootDir, config } = await createVault({ initialize: true });
    await writePage({ rootDir, relativePath: "concepts/first.md", title: "First" });
    await writePage({ rootDir, relativePath: "concepts/unused.md", title: "Unused" });
    await writePage({
      rootDir,
      relativePath: "concepts/source.md",
      title: "Source",
      body: "[Confirmed][id]\n\n[id]: first.md\n[id]: unused.md\n[unused]: unused.md",
    });
    expect(
      (await listMemoryWikiGraph(config)).edges.filter((edge) => edge.type === "reference"),
    ).toEqual([{ source: "concepts/source.md", target: "concepts/first.md", type: "reference" }]);
  });
  it("deduplicates and sorts explicit links while counting unresolved targets", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-graph-",
      initialize: true,
    });
    await writePage({
      rootDir,
      relativePath: "entities/gamma.md",
      title: "Gamma",
    });
    await writePage({
      rootDir,
      relativePath: "concepts/beta.md",
      title: "Beta",
      body: "Back to [[Alpha]].",
    });
    await writePage({
      rootDir,
      relativePath: "concepts/alpha.md",
      title: "Alpha",
      updatedAt: "2026-09-08T01:02:03.000Z",
      body: [
        "See [[Beta]], [[Beta]], and [Gamma](../entities/gamma.md).",
        "Broken [[Missing]] and again [[Missing]].",
        "```md",
        "[[CodeOnly]]",
        "```",
        "",
        "## Related",
        WIKI_RELATED_START_MARKER,
        "- [[GeneratedOnly]]",
        WIKI_RELATED_END_MARKER,
      ].join("\n"),
    });

    const first = await listMemoryWikiGraph(config);
    const second = await listMemoryWikiGraph(config);

    expect(second).toEqual(first);
    expect(first.nodes.filter((node) => node.kind !== "index")).toEqual([
      {
        id: "concepts/alpha.md",
        title: "Alpha",
        kind: "concept",
        updatedAt: "2026-09-08T01:02:03.000Z",
      },
      { id: "concepts/beta.md", title: "Beta", kind: "concept" },
      { id: "entities/gamma.md", title: "Gamma", kind: "entity" },
    ]);
    expect(first.edges.filter((edge) => edge.type === "reference")).toEqual([
      { source: "concepts/alpha.md", target: "concepts/beta.md", type: "reference" },
      { source: "concepts/alpha.md", target: "entities/gamma.md", type: "reference" },
      { source: "concepts/beta.md", target: "concepts/alpha.md", type: "reference" },
    ]);
    expect(first.stats).toEqual({
      totalPages: 9,
      totalNodes: 9,
      totalEdges: 11,
      unresolvedLinks: 1,
      truncated: false,
    });
  });

  it("caps nodes at 500 and reports omitted documents as truncated", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-graph-node-cap-",
      initialize: true,
    });
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writePage({
          rootDir,
          relativePath: `concepts/page-${index.toString().padStart(3, "0")}.md`,
          title: `Page ${index}`,
        }),
      ),
    );

    const graph = await listMemoryWikiGraph(config);

    expect(graph.nodes).toHaveLength(500);
    const documents = graph.nodes.filter((node) => node.kind !== "index");
    expect(documents.at(0)?.id).toBe("concepts/page-000.md");
    expect(documents.at(-1)?.id).toBe("concepts/page-493.md");
    expect(graph.stats).toMatchObject({
      totalPages: 507,
      totalNodes: 500,
      truncated: true,
    });
  });

  it("caps edges at 2,000 in deterministic order and reports truncation", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-graph-edge-cap-",
      initialize: true,
    });
    const pageNames = Array.from(
      { length: 46 },
      (_, index) => `page-${index.toString().padStart(2, "0")}`,
    );
    const body = pageNames.map((name) => `[[${name}]]`).join("\n");
    await Promise.all(
      pageNames.map((name) =>
        writePage({
          rootDir,
          relativePath: `concepts/${name}.md`,
          title: name,
          body,
        }),
      ),
    );

    const first = await listMemoryWikiGraph(config);
    const second = await listMemoryWikiGraph(config);

    expect(second).toEqual(first);
    expect(first.edges).toHaveLength(2_000);
    expect(first.edges.some((edge) => edge.type === "membership")).toBe(true);
    expect(first.edges.some((edge) => edge.type === "reference")).toBe(true);
    expect(first.stats).toEqual({
      totalPages: 52,
      totalNodes: 52,
      totalEdges: 2_000,
      unresolvedLinks: 0,
      truncated: true,
    });
  });
});
