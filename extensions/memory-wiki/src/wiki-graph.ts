// Memory Wiki plugin module builds the bounded, read-only document graph.
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  createWikiLinkTargetIndex,
  normalizeComparableWikiTarget,
  resolveWikiLinkTarget,
} from "./link-resolution.js";
import type { WikiPageKind } from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

const MAX_MEMORY_WIKI_GRAPH_NODES = 500;
const MAX_MEMORY_WIKI_GRAPH_EDGES = 2_000;

type MemoryWikiGraphEdge = {
  source: string;
  target: string;
  type: "membership" | "reference" | "related" | "candidate";
  kind?: string;
};

type MemoryWikiGraph = {
  nodes: Array<{
    id: string;
    title: string;
    kind: WikiPageKind | "index";
    updatedAt?: string;
  }>;
  edges: MemoryWikiGraphEdge[];
  stats: {
    totalPages: number;
    totalNodes: number;
    totalEdges: number;
    unresolvedLinks: number;
    truncated: boolean;
  };
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function listMemoryWikiGraph(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiGraph> {
  const pages = (await readQueryableWikiPages(config.vault.path)).toSorted((left, right) =>
    compareText(left.relativePath, right.relativePath),
  );
  const indexNodes = [
    { id: "index.md", title: "Wiki Index", kind: "index" as const },
    ...(["entities", "concepts", "sources", "syntheses", "reports"] as const).map((directory) => ({
      id: `${directory}/index.md`,
      title: `${directory[0]!.toUpperCase()}${directory.slice(1)}`,
      kind: "index" as const,
    })),
  ];
  const selectedPages = pages.slice(0, MAX_MEMORY_WIKI_GRAPH_NODES - indexNodes.length);
  const selectedIds = new Set([
    ...indexNodes.map((node) => node.id),
    ...selectedPages.map((page) => page.relativePath),
  ]);
  const targetIndex = createWikiLinkTargetIndex(pages);
  const edgeKeys = new Set<string>();
  const unresolvedLinkKeys = new Set<string>();
  let omittedEdge = false;

  for (const source of pages) {
    for (const target of source.linkTargets) {
      const matches = resolveWikiLinkTarget(targetIndex, target);
      if (matches.length === 0) {
        unresolvedLinkKeys.add(
          `${source.relativePath}\u0000${normalizeComparableWikiTarget(target)}`,
        );
        continue;
      }
      for (const match of matches) {
        if (!selectedIds.has(source.relativePath) || !selectedIds.has(match.relativePath)) {
          omittedEdge = true;
          continue;
        }
        edgeKeys.add(`reference\u0000${source.relativePath}\u0000${match.relativePath}\u0000`);
      }
    }
    for (const relationship of source.relationships) {
      // Stable ids survive page moves; paths and titles remain fallbacks for older pages.
      const lookup = relationship.targetId ?? relationship.targetPath ?? relationship.targetTitle;
      if (!lookup) {
        continue;
      }
      const matches = resolveWikiLinkTarget(targetIndex, lookup);
      if (matches.length !== 1) {
        unresolvedLinkKeys.add(
          `${source.relativePath}\u0000${normalizeComparableWikiTarget(lookup)}`,
        );
        continue;
      }
      const [match] = matches;
      if (!match || !selectedIds.has(source.relativePath) || !selectedIds.has(match.relativePath)) {
        omittedEdge = true;
        continue;
      }
      const type = relationship.status === "candidate" ? "candidate" : "related";
      edgeKeys.add(
        `${type}\u0000${source.relativePath}\u0000${match.relativePath}\u0000${relationship.kind ?? "related"}`,
      );
    }
  }

  for (const node of indexNodes.slice(1)) {
    edgeKeys.add(`membership\u0000index.md\u0000${node.id}\u0000`);
  }
  for (const page of selectedPages) {
    const directory = page.relativePath.split("/")[0];
    edgeKeys.add(`membership\u0000${directory}/index.md\u0000${page.relativePath}\u0000`);
  }

  const allEdges = [...edgeKeys]
    .map((key) => {
      const [type = "reference", source = "", target = "", kind = ""] = key.split("\u0000");
      const edge: MemoryWikiGraphEdge = {
        source,
        target,
        type: type as MemoryWikiGraphEdge["type"],
      };
      if (kind) {
        edge.kind = kind;
      }
      return edge;
    })
    .toSorted(
      (left, right) =>
        compareText(left.type, right.type) ||
        compareText(left.source, right.source) ||
        compareText(left.target, right.target) ||
        compareText(left.kind ?? "", right.kind ?? ""),
    );
  const edges = allEdges.slice(0, MAX_MEMORY_WIKI_GRAPH_EDGES);
  const nodes: MemoryWikiGraph["nodes"] = [...indexNodes];
  for (const page of selectedPages) {
    nodes.push({
      id: page.relativePath,
      title: page.title,
      kind: page.kind,
      ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
    });
  }

  return {
    nodes,
    edges,
    stats: {
      totalPages: pages.length + indexNodes.length,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      unresolvedLinks: unresolvedLinkKeys.size,
      truncated:
        pages.length > MAX_MEMORY_WIKI_GRAPH_NODES ||
        allEdges.length > MAX_MEMORY_WIKI_GRAPH_EDGES ||
        omittedEdge,
    },
  };
}
