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
});
