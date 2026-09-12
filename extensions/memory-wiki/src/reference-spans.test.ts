import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { memoryWikiPromotionRevision, parseMemoryWikiReferenceSpans } from "../reference-api.js";

describe("public Wiki reference grammar", () => {
  it("uses the renderer's first definition when duplicate targets mix private and public URLs", () => {
    const text = "[비공개][id]\n\n[id]: personal/first.md\n[id]: https://example.com";
    const spans = parseMemoryWikiReferenceSpans(text);
    expect(spans.map((span) => span.target)).toEqual(["personal/first.md", "personal/first.md"]);
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe("[비공개][id]");
  });
  it("captures private local URI tokens and chooses the complete enclosing local link", () => {
    const text =
      "[파일](file:///private/a.md) [위키](obsidian://open?vault=private) [see [[private|alias]]](other.md)";
    const spans = parseMemoryWikiReferenceSpans(text);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "[파일](file:///private/a.md)",
      "[위키](obsidian://open?vault=private)",
      "[see [[private|alias]]](other.md)",
    ]);
  });
  it("pins complete token offsets, resolves relative Markdown, and ignores code and external URLs", () => {
    const text =
      '한글\r\n[[concepts/a.md|비공개 별칭]] [자료](../sources/a(b).md "제목") `[[hidden]]`\n![사진](private.png) [웹](https://example.com/a) [웹](//example.com/a)\n```md\n[[hidden2]]\n```';
    const spans = parseMemoryWikiReferenceSpans(text, "concepts/source.md");
    expect(spans.map((span) => span.target)).toEqual([
      "concepts/a.md",
      "sources/a(b).md",
      "concepts/private.png",
    ]);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "[[concepts/a.md|비공개 별칭]]",
      '[자료](../sources/a(b).md "제목")',
      "![사진](private.png)",
    ]);
  });

  it("captures local reference-style links, their definitions, and complete embedded private aliases", () => {
    const text =
      "[비공개][ref] ![[secret.md|이름]] ![그림][img]\n\n[ref]: concepts/a.md\n[img]: images/private.png\n[외부][web]\n\n[web]: https://example.com";
    const spans = parseMemoryWikiReferenceSpans(text);
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "[비공개][ref]",
      "![[secret.md|이름]]",
      "![그림][img]",
      "[ref]: concepts/a.md",
      "[img]: images/private.png",
    ]);
    expect(spans.map((span) => span.target)).toEqual([
      "concepts/a.md",
      "secret.md",
      "images/private.png",
      "concepts/a.md",
      "images/private.png",
    ]);
  });

  it("ignores generated related blocks without shifting subsequent offsets", () => {
    const text =
      "## Related\r\n\r\n<!-- openclaw:wiki:related:start -->\r\n[[generated]]\r\n<!-- openclaw:wiki:related:end -->\r\n[[actual]]";
    const spans = parseMemoryWikiReferenceSpans(text, "", 32, { purpose: "graph" });
    expect(parseMemoryWikiReferenceSpans(text).map((span) => span.target)).toEqual([
      "generated",
      "actual",
    ]);
    expect(spans).toEqual([
      { start: text.indexOf("[[actual]]"), end: text.length, target: "actual" },
    ]);
  });

  it("rejects excess references rather than leaving private tokens unexamined", () => {
    expect(() =>
      parseMemoryWikiReferenceSpans(Array.from({ length: 33 }, (_, i) => `[[p${i}]]`).join(" ")),
    ).toThrow("32 reference limit");
  });

  it("preserves the original complete wiki.get revision byte contract", () => {
    const page = {
      claimId: "concept.stable",
      content: "한글\n본문\n",
      totalLines: 3,
      updatedAt: "2026-09-13T00:00:00Z",
    };
    const expected =
      Number.parseInt(
        createHash("sha256").update(JSON.stringify(page)).digest("hex").slice(0, 12),
        16,
      ) + 1;
    expect(memoryWikiPromotionRevision(page)).toBe(expected);
    expect(memoryWikiPromotionRevision({ ...page, updatedAt: undefined })).toBe(
      Number.parseInt(
        createHash("sha256")
          .update(JSON.stringify({ ...page, updatedAt: undefined }))
          .digest("hex")
          .slice(0, 12),
        16,
      ) + 1,
    );
  });
});
