import { describe, expect, it } from "vitest";
import {
  formatWikiDocumentLink,
  normalizeWikiDocumentTarget,
  parseMemoryWikiReferenceSpans,
} from "./reference-spans.js";

describe("portable same-Wiki document links", () => {
  it("uses readable safe labels without inventing escaping for Wiki delimiters", () => {
    expect(formatWikiDocumentLink("concepts/a.md", "Calibration")).toBe(
      "[[concepts/a.md|Calibration]]",
    );
    for (const title of ["a]b", "a|b", "a\nb"]) {
      expect(formatWikiDocumentLink("concepts/a.md", title)).toBe("[[concepts/a.md]]");
    }
  });
  it.each([
    "concepts/a b.md",
    "concepts/a#b.md",
    "concepts/a]b|c.md",
    "concepts/a%23b.md",
    "concepts/한글.md",
  ])("round trips %s exactly from a nested source", (target) => {
    const link = formatWikiDocumentLink(target);
    const spans = parseMemoryWikiReferenceSpans(link, "syntheses/nested/source.md", 32, {
      purpose: "graph",
    });
    expect(spans).toEqual([{ start: 0, end: link.length, target }]);
    const first = spans[0];
    if (!first) {
      throw new Error("Expected the formatted link to produce one reference");
    }
    expect(normalizeWikiDocumentTarget(first.target)).toBe(normalizeWikiDocumentTarget(target));
  });
  it("keeps wikilinks Wiki-root relative, Markdown source relative, and ignores code/unreferenced definitions", () => {
    const body =
      "[[concepts/Target.md#Heading]] [Target](../../concepts/a%23b.md) `[[ignored]]`\n\n[unused]: absent.md";
    expect(
      parseMemoryWikiReferenceSpans(body, "syntheses/nested/source.md", 32, {
        purpose: "graph",
      }).map((span) => span.target),
    ).toEqual(["concepts/Target.md", "concepts/a#b.md"]);
    expect(parseMemoryWikiReferenceSpans("[[a%2523b.md]]")[0]?.target).toBe("a%23b.md");
  });
  it.each(["", "../outside", "/absolute", "x\\y", "x\ny", "x\u0000y", "x\u001fy"])(
    "rejects unsafe formatter target %s",
    (target) => {
      expect(() => formatWikiDocumentLink(target)).toThrow();
    },
  );
});
