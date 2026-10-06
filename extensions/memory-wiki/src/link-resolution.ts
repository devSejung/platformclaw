// Memory Wiki plugin module owns explicit document-link resolution.
import path from "node:path";
import { normalizeWikiDocumentTarget } from "@openclaw/markdown-core";
import type { WikiPageSummary } from "./markdown.js";

type WikiLinkTargetIndex<T extends WikiPageSummary = WikiPageSummary> = {
  exactPaths: ReadonlyMap<string, readonly T[]>;
  paths: ReadonlyMap<string, readonly T[]>;
  ids: ReadonlyMap<string, readonly T[]>;
  titles: ReadonlyMap<string, readonly T[]>;
  filenames: ReadonlyMap<string, readonly T[]>;
};
export function normalizeComparableWikiTarget(target: string): string {
  return normalizeWikiDocumentTarget(target.normalize("NFC").replace(/\.markdown$/iu, ".md"));
}

export function createWikiLinkTargetIndex<T extends WikiPageSummary>(
  pages: readonly T[],
): WikiLinkTargetIndex<T> {
  const exactPaths = new Map<string, T[]>();
  const paths = new Map<string, T[]>();
  const ids = new Map<string, T[]>();
  const titles = new Map<string, T[]>();
  const filenames = new Map<string, T[]>();
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
    add(paths, normalizeComparableWikiTarget(page.relativePath), page);
    add(ids, normalizeComparableWikiTarget(page.id ?? ""), page);
    add(titles, normalizeComparableWikiTarget(page.title), page);
    add(filenames, normalizeComparableWikiTarget(path.posix.basename(page.relativePath)), page);
  }
  return { exactPaths, paths, ids, titles, filenames };
}
export function resolveWikiLinkTarget<T extends WikiPageSummary>(
  index: WikiLinkTargetIndex<T>,
  target: string,
  sourceRelativePath?: string,
): readonly T[] {
  const literal = target.trim();
  const rooted = literal.startsWith("/");
  const lookup = rooted ? path.posix.normalize(literal).slice(1) : literal;
  const normalized = normalizeComparableWikiTarget(lookup);
  // Match one authoritative tier; a title must not obscure an exact path, and
  // ambiguous matches reach the caller rather than selecting an arbitrary page.
  const exact = index.exactPaths.get(lookup) ?? index.paths.get(normalized);
  if (rooted) {
    // A leading slash explicitly names the vault root, never an imported path or title.
    return exact ?? [];
  }
  const importRoot = /^concepts\/imports\/[^/]+\//u.exec(sourceRelativePath ?? "")?.[0];
  if (importRoot) {
    // Non-rooted Wiki paths prefer their uploaded tree over colliding vault paths.
    // An explicit root marker is required to select the vault path in that case.
    const relative = literal.replaceAll("\\", "/");
    const relativeBase = /^\.{1,2}\//u.test(relative)
      ? path.posix.dirname(sourceRelativePath!)
      : importRoot;
    const scopedPath = path.posix.normalize(path.posix.join(relativeBase, relative));
    if (!scopedPath.startsWith(importRoot)) {
      return [];
    }
    const scopedPaths =
      index.exactPaths.get(scopedPath) ??
      index.paths.get(normalizeComparableWikiTarget(scopedPath));
    if (scopedPaths) {
      return scopedPaths;
    }
    // Existing full-path links remain usable when no imported path matches.
    if (exact) {
      return exact;
    }
    for (const tier of [index.ids, index.titles, index.filenames]) {
      const matches = tier
        .get(normalized)
        ?.filter((page) => page.relativePath.startsWith(importRoot));
      if (matches?.length) {
        return matches;
      }
    }
    return [];
  }
  if (exact) {
    return exact;
  }
  // Older single-file uploads put each filename in a separate UUID directory.
  // Recover only a unique legacy filename; never infer a path into a newer import.
  const legacyPath = /^concepts\/[a-f0-9-]{36}\/[^/]+\.md$/u;
  if (sourceRelativePath && legacyPath.test(sourceRelativePath)) {
    const sourceDirectory = `${path.posix.dirname(sourceRelativePath)}/`;
    if (target.startsWith(sourceDirectory) && !target.slice(sourceDirectory.length).includes("/")) {
      const matches = index.filenames.get(
        normalizeComparableWikiTarget(path.posix.basename(target)),
      );
      return matches?.length === 1 && legacyPath.test(matches[0]!.relativePath) ? matches : [];
    }
  }
  return (
    index.ids.get(normalized) ??
    index.titles.get(normalized) ??
    index.filenames.get(normalized) ??
    []
  );
}
