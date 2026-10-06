// Memory Wiki plugin module implements the memory wiki overview.
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readMemoryWikiCompileFailure, type MemoryWikiCompileFailure } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { parseWikiMarkdown, type WikiPageKind } from "./markdown.js";
import { readQueryableWikiPages } from "./query.js";

const OVERVIEW_KIND_ORDER: WikiPageKind[] = ["synthesis", "entity", "concept", "source", "report"];
const PRIMARY_OVERVIEW_KINDS = new Set<WikiPageKind>(["synthesis", "entity", "concept"]);
const MAX_OVERVIEW_DOCUMENTS = 1_000;
const MAX_OVERVIEW_CLUSTER_ITEMS = 500;
const OVERVIEW_KIND_LABELS: Record<WikiPageKind, string> = {
  synthesis: "Syntheses",
  entity: "Entities",
  concept: "Concepts",
  source: "Sources",
  report: "Reports",
};

type MemoryWikiOverviewItem = {
  pagePath: string;
  title: string;
  kind: WikiPageKind;
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

type MemoryWikiOverviewCluster = {
  key: WikiPageKind;
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: MemoryWikiOverviewItem[];
};

type MemoryWikiOverviewPageCounts = Record<WikiPageKind, number>;

type MemoryWikiOverviewStatus = {
  compileFailure?: MemoryWikiCompileFailure;
  totalItems: number;
  totalPages: number;
  pageCounts: MemoryWikiOverviewPageCounts;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  documents: MemoryWikiOverviewItem[];
  documentsTruncated: boolean;
  clusters: MemoryWikiOverviewCluster[];
};

function createEmptyOverviewPageCounts(): MemoryWikiOverviewPageCounts {
  return {
    synthesis: 0,
    entity: 0,
    concept: 0,
    source: 0,
    report: 0,
  };
}

function extractSnippet(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      !line ||
      line.startsWith("#") ||
      line.startsWith("```") ||
      line.startsWith("<!--") ||
      line.startsWith("- ") ||
      line.startsWith("* ")
    ) {
      continue;
    }
    return line.slice(0, 320);
  }
  return undefined;
}

function compareOverviewItems(left: MemoryWikiOverviewItem, right: MemoryWikiOverviewItem): number {
  const leftKey = left.updatedAt ?? "";
  const rightKey = right.updatedAt ?? "";
  if (rightKey !== leftKey) {
    return rightKey.localeCompare(leftKey);
  }
  if (right.claimCount !== left.claimCount) {
    return right.claimCount - left.claimCount;
  }
  return left.title.localeCompare(right.title) || left.pagePath.localeCompare(right.pagePath);
}

export async function listMemoryWikiOverview(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiOverviewStatus> {
  const pages = await readQueryableWikiPages(config.vault.path);
  const pageCounts = pages.reduce<MemoryWikiOverviewPageCounts>((counts, page) => {
    counts[page.kind] += 1;
    return counts;
  }, createEmptyOverviewPageCounts());
  const totalClaims = pages.reduce((sum, page) => sum + page.claims.length, 0);
  const totalQuestions = pages.reduce((sum, page) => sum + page.questions.length, 0);
  const totalContradictions = pages.reduce((sum, page) => sum + page.contradictions.length, 0);
  const allItems = pages
    .map((page) => {
      const parsed = parseWikiMarkdown(page.raw);
      const updatedAt = normalizeOptionalString(page.updatedAt);
      const sourceType = normalizeOptionalString(page.sourceType);
      const snippet = extractSnippet(parsed.body);
      return Object.assign(
        { pagePath: page.relativePath, title: page.title.slice(0, 240), kind: page.kind },
        page.id && page.id.length <= 1_024 ? { id: page.id } : {},
        updatedAt ? { updatedAt: updatedAt.slice(0, 256) } : {},
        sourceType ? { sourceType: sourceType.slice(0, 256) } : {},
        {
          claimCount: page.claims.length,
          questionCount: page.questions.length,
          contradictionCount: page.contradictions.length,
          claims: page.claims.slice(0, 3).map((claim) => claim.text.slice(0, 320)),
          questions: page.questions.slice(0, 3).map((question) => question.slice(0, 320)),
          contradictions: page.contradictions.slice(0, 3).map((item) => item.slice(0, 320)),
        },
        snippet ? { snippet } : {},
      ) satisfies MemoryWikiOverviewItem;
    })
    .toSorted(compareOverviewItems);
  const items = allItems.filter(
    (item) =>
      PRIMARY_OVERVIEW_KINDS.has(item.kind) ||
      item.claimCount > 0 ||
      item.questionCount > 0 ||
      item.contradictionCount > 0,
  );

  const clusters = OVERVIEW_KIND_ORDER.map((kind) => {
    const clusterItems = items.filter((item) => item.kind === kind);
    if (clusterItems.length === 0) {
      return null;
    }
    return Object.assign(
      {
        key: kind,
        label: OVERVIEW_KIND_LABELS[kind],
        itemCount: clusterItems.length,
        claimCount: clusterItems.reduce((sum, item) => sum + item.claimCount, 0),
        questionCount: clusterItems.reduce((sum, item) => sum + item.questionCount, 0),
        contradictionCount: clusterItems.reduce((sum, item) => sum + item.contradictionCount, 0),
      },
      clusterItems[0]?.updatedAt ? { updatedAt: clusterItems[0].updatedAt } : {},
      { items: clusterItems.slice(0, MAX_OVERVIEW_CLUSTER_ITEMS) },
    ) satisfies MemoryWikiOverviewCluster;
  }).filter((entry): entry is MemoryWikiOverviewCluster => entry !== null);

  const compileFailure = await readMemoryWikiCompileFailure(config);
  return {
    ...(compileFailure ? { compileFailure } : {}),
    totalItems: items.length,
    totalPages: pages.length,
    pageCounts,
    totalClaims,
    totalQuestions,
    totalContradictions,
    // The document catalog includes plain sources/reports and stays independent
    // of graph capacity and the annotated overview's presentation filter.
    documents: allItems.slice(0, MAX_OVERVIEW_DOCUMENTS),
    documentsTruncated: allItems.length > MAX_OVERVIEW_DOCUMENTS,
    clusters,
  };
}
