// Memory Wiki plugin module owns explicit document-link resolution.
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WikiPageSummary } from "./markdown.js";

export type WikiLinkTargetIndex = ReadonlyMap<string, readonly WikiPageSummary[]>;

export function normalizeComparableWikiTarget(value: string): string {
  return normalizeLowercaseStringOrEmpty(
    value
      .trim()
      .replace(/\\/g, "/")
      .replace(/\.md$/i, "")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, ""),
  );
}

export function buildWikiPageLookupKeys(page: WikiPageSummary): Set<string> {
  const keys = new Set<string>();
  keys.add(normalizeComparableWikiTarget(page.relativePath));
  keys.add(normalizeComparableWikiTarget(page.relativePath.replace(/\.md$/i, "")));
  keys.add(normalizeComparableWikiTarget(page.title));
  if (page.id) {
    keys.add(normalizeComparableWikiTarget(page.id));
  }
  return keys;
}

export function createWikiLinkTargetIndex(pages: readonly WikiPageSummary[]): WikiLinkTargetIndex {
  const mutable = new Map<string, WikiPageSummary[]>();
  for (const page of pages.toSorted((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  )) {
    for (const key of buildWikiPageLookupKeys(page)) {
      const matches = mutable.get(key);
      if (matches) {
        matches.push(page);
      } else {
        mutable.set(key, [page]);
      }
    }
  }
  return mutable;
}

export function resolveWikiLinkTarget(
  index: WikiLinkTargetIndex,
  target: string,
): readonly WikiPageSummary[] {
  return index.get(normalizeComparableWikiTarget(target)) ?? [];
}
