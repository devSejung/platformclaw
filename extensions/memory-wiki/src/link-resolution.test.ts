import { formatWikiDocumentLink, parseMemoryWikiReferenceSpans } from "@openclaw/markdown-core";
import { describe, expect, it } from "vitest";
import { createWikiLinkTargetIndex, resolveWikiLinkTarget } from "./link-resolution.js";
import { toWikiPageSummary } from "./markdown.js";

describe("Wiki document target precedence", () => {
  it("prefers exact paths, then normalized paths, then IDs and titles without guessing within a tier", () => {
    const page = (relativePath: string, title: string, id: string) =>
      toWikiPageSummary({
        relativePath,
        absolutePath: relativePath,
        raw: `---\ntitle: ${JSON.stringify(title)}\nid: ${JSON.stringify(id)}\n---\nBody`,
      })!;
    const first = page("concepts/Target.md", "Duplicate", "first");
    const second = page("concepts/target.md", "Duplicate", "second");
    const collision = page("concepts/other.md", "concepts/Target.md", "other");
    const unsafe = page("concepts/a#] |%23.md", "Special", "special");
    const index = createWikiLinkTargetIndex([first, second, collision, unsafe]);
    expect(resolveWikiLinkTarget(index, "concepts/Target.md")).toEqual([first]);
    expect(resolveWikiLinkTarget(index, "CONCEPTS/TARGET")).toHaveLength(2);
    expect(resolveWikiLinkTarget(index, "FIRST")).toEqual([first]);
    expect(resolveWikiLinkTarget(index, "Duplicate")).toHaveLength(2);
    const target = parseMemoryWikiReferenceSpans(
      formatWikiDocumentLink(unsafe.relativePath),
      "syntheses/nested/source.md",
    )[0]!.target;
    expect(resolveWikiLinkTarget(index, target)).toEqual([unsafe]);
  });

  it("prefers imported paths, preserves canonical fallbacks and confines explicit root links", () => {
    const page = (relativePath: string, title: string) =>
      toWikiPageSummary({ absolutePath: relativePath, relativePath, raw: "# " + title })!;
    const importRoot = "concepts/imports/00000000-0000-4000-8000-000000000003/";
    const source = page(importRoot + "Guides/Source.md", "Source");
    const root = page("concepts/Target.md", "Root target");
    const scopedTarget = page(importRoot + "concepts/Target.md", "Imported target");
    const fallback = page("concepts/Fallback.md", "Vault fallback");
    const fallbackTitle = page(importRoot + "Title match.md", "concepts/Fallback");
    const scoped = page(importRoot + "concepts/Missing.md", "Imported target");
    const titleOnly = page(importRoot + "Other.md", "concepts/Title only");
    const index = createWikiLinkTargetIndex([
      source,
      root,
      scopedTarget,
      fallback,
      fallbackTitle,
      scoped,
      titleOnly,
    ]);
    const links = parseMemoryWikiReferenceSpans(
      "[Root](/concepts/Target.markdown#Heading) [[/concepts/Missing.md]] " +
        "[[/concepts/Title only]] [[concepts/Missing]] " +
        "[[concepts/Target.md]] [[CONCEPTS/TARGET.markdown]] [[concepts/Fallback]]",
      source.relativePath,
    );
    expect(
      links.map((link) => resolveWikiLinkTarget(index, link.target, source.relativePath)),
    ).toEqual([[root], [], [], [scoped], [scopedTarget], [scopedTarget], [fallback]]);
    expect(resolveWikiLinkTarget(index, "../../concepts/Target.md", source.relativePath)).toEqual(
      [],
    );
  });

  it("recovers only unambiguous legacy uploaded filenames without crossing into a newer import", () => {
    const page = (relativePath: string, title: string) =>
      toWikiPageSummary({ absolutePath: relativePath, relativePath, raw: "# " + title })!;
    const firstRoot = "concepts/00000000-0000-4000-8000-000000000001/";
    const secondRoot = "concepts/00000000-0000-4000-8000-000000000002/";
    const source = page(firstRoot + "Source.md", "Source");
    const target = page(secondRoot + "Filename.md", "A different document title");
    let index = createWikiLinkTargetIndex([source, target]);
    expect(resolveWikiLinkTarget(index, firstRoot + "Filename.md", source.relativePath)).toEqual([
      target,
    ]);
    expect(resolveWikiLinkTarget(index, "Filename", source.relativePath)).toEqual([target]);
    const other = page(
      "concepts/imports/00000000-0000-4000-8000-000000000003/Filename.md",
      "New import",
    );
    index = createWikiLinkTargetIndex([source, target, other]);
    expect(resolveWikiLinkTarget(index, firstRoot + "Filename.md", source.relativePath)).toEqual(
      [],
    );
    index = createWikiLinkTargetIndex([source, other]);
    expect(resolveWikiLinkTarget(index, firstRoot + "Filename.md", source.relativePath)).toEqual(
      [],
    );
    expect(resolveWikiLinkTarget(index, other.relativePath, source.relativePath)).toEqual([other]);
  });
});
