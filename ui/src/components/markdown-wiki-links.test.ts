// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("Wiki markdown links", () => {
  it("links Wiki targets only in Wiki mode and leaves inline and fenced code intact", () => {
    const source = [
      "Open [[Runbook|the runbook]] and [relative](concepts/relative.md).",
      "",
      "`[[inline-code]]`",
      "",
      "```markdown",
      "[[fenced-code]]",
      "```",
    ].join("\n");
    const regular = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(regular.querySelector("[data-wiki-lookup]")).toBeNull();

    const wiki = htmlFragment(toSanitizedMarkdownHtml(source, { wikiLinks: true }));
    const wikiLink = wiki.querySelector<HTMLAnchorElement>("[data-wiki-lookup]");
    expect(wikiLink?.dataset.wikiLookup).toBe("Runbook");
    expect(wikiLink?.textContent).toBe("the runbook");
    expect(wiki.querySelector("a[href='concepts/relative.md']")).not.toBeNull();
    expect(wiki.querySelector("code")?.textContent).toBe("[[inline-code]]");
    expect(wiki.querySelector("pre")?.textContent).toContain("[[fenced-code]]");
    expect(wiki.querySelector("code [data-wiki-lookup]")).toBeNull();
  });
});
