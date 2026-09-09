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
    expect(first.nodes).toEqual([
      {
        id: "concepts/alpha.md",
        title: "Alpha",
        kind: "concept",
        updatedAt: "2026-09-08T01:02:03.000Z",
      },
      { id: "concepts/beta.md", title: "Beta", kind: "concept" },
      { id: "entities/gamma.md", title: "Gamma", kind: "entity" },
    ]);
    expect(first.edges).toEqual([
      { source: "concepts/alpha.md", target: "concepts/beta.md", type: "link" },
      { source: "concepts/alpha.md", target: "entities/gamma.md", type: "link" },
      { source: "concepts/beta.md", target: "concepts/alpha.md", type: "link" },
    ]);
    expect(first.stats).toEqual({
      totalPages: 3,
      totalNodes: 3,
      totalEdges: 3,
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
    expect(graph.nodes.at(0)?.id).toBe("concepts/page-000.md");
    expect(graph.nodes.at(-1)?.id).toBe("concepts/page-499.md");
    expect(graph.stats).toMatchObject({
      totalPages: 501,
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
    expect(first.edges.at(0)).toEqual({
      source: "concepts/page-00.md",
      target: "concepts/page-00.md",
      type: "link",
    });
    expect(first.edges.at(-1)).toEqual({
      source: "concepts/page-43.md",
      target: "concepts/page-21.md",
      type: "link",
    });
    expect(first.stats).toEqual({
      totalPages: 46,
      totalNodes: 46,
      totalEdges: 2_000,
      unresolvedLinks: 0,
      truncated: true,
    });
  });
});
