import type { MemorySourceFilter, SearchResult } from "./memory-memories-view.ts";

/** Navigation intent only: results and document bytes must be fetched again. */
export type MemorySearchNavigationState = {
  kind: "draft" | "search";
  query: string;
  sourceFilter: MemorySourceFilter;
  selectedResult: string | null;
  scrollTop: number;
};

export function memorySearchResultIdentity(result: SearchResult): string {
  return JSON.stringify([
    result.source,
    result.path,
    result.vaultId,
    result.documentId,
    result.startLine,
    result.endLine,
  ]);
}
