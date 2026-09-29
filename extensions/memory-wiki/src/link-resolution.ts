// Memory Wiki plugin module owns explicit document-link resolution.
import { normalizeWikiDocumentTarget } from "@openclaw/markdown-core";
import type { WikiPageSummary } from "./markdown.js";

type WikiLinkTargetIndex<T extends WikiPageSummary = WikiPageSummary> = {
  exactPaths: ReadonlyMap<string, readonly T[]>;
  paths: ReadonlyMap<string, readonly T[]>;
  ids: ReadonlyMap<string, readonly T[]>;
  titles: ReadonlyMap<string, readonly T[]>;
};
export const normalizeComparableWikiTarget = normalizeWikiDocumentTarget;

export function createWikiLinkTargetIndex<T extends WikiPageSummary>(
  pages: readonly T[],
): WikiLinkTargetIndex<T> {
  const exactPaths = new Map<string, T[]>();
  const paths = new Map<string, T[]>();
  const ids = new Map<string, T[]>();
  const titles = new Map<string, T[]>();
  const add = (index: Map<string, T[]>, key: string, page: T) => {
    if (key) {
      const matches = index.get(key);
      if (matches) {
        matches.push(page);
      } else {
        index.set(key, [page]);
      }
    }
  };
  for (const page of pages.toSorted((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  )) {
    add(exactPaths, page.relativePath, page);
    add(paths, normalizeWikiDocumentTarget(page.relativePath), page);
    add(ids, normalizeWikiDocumentTarget(page.id ?? ""), page);
    add(titles, normalizeWikiDocumentTarget(page.title), page);
  }
  return { exactPaths, paths, ids, titles };
}
export function resolveWikiLinkTarget<T extends WikiPageSummary>(
  index: WikiLinkTargetIndex<T>,
  target: string,
): readonly T[] {
  const normalized = normalizeWikiDocumentTarget(target);
  // Match one authoritative tier; a title must not obscure an exact path, and
  // ambiguous matches reach the caller rather than selecting an arbitrary page.
  return (
    index.exactPaths.get(target.trim()) ??
    index.paths.get(normalized) ??
    index.ids.get(normalized) ??
    index.titles.get(normalized) ??
    []
  );
}
