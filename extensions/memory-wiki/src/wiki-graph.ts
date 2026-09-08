// Memory Wiki plugin module builds the bounded, read-only document graph.
import type { ResolvedMemoryWikiConfig } from "./config.js";
import {
  createWikiLinkTargetIndex,
  normalizeComparableWikiTarget,
  resolveWikiLinkTarget,
} from "./link-resolution.js";
import type { WikiPageKind } from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

export const MAX_MEMORY_WIKI_GRAPH_NODES = 500;
export const MAX_MEMORY_WIKI_GRAPH_EDGES = 2_000;

export type MemoryWikiGraphEdge = {
  source: string;
  target: string;
  type: "link";
};

export type MemoryWikiGraph = {
  nodes: Array<{
    id: string;
    title: string;
    kind: WikiPageKind;
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
  const selectedPages = pages.slice(0, MAX_MEMORY_WIKI_GRAPH_NODES);
  const selectedIds = new Set(selectedPages.map((page) => page.relativePath));
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
        edgeKeys.add(`${source.relativePath}\u0000${match.relativePath}`);
      }
    }
  }

  const allEdges = [...edgeKeys]
    .map((key) => {
      const [source = "", target = ""] = key.split("\u0000");
      return { source, target, type: "link" as const };
    })
    .toSorted(
      (left, right) =>
        compareText(left.source, right.source) || compareText(left.target, right.target),
    );
  const edges = allEdges.slice(0, MAX_MEMORY_WIKI_GRAPH_EDGES);
  const nodes = selectedPages.map((page) => ({
    id: page.relativePath,
    title: page.title,
    kind: page.kind,
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
  }));

  return {
    nodes,
    edges,
    stats: {
      totalPages: pages.length,
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
