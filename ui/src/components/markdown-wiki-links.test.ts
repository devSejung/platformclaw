// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function htmlFragment(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

describe("Wiki markdown links", () => {
  it("keeps late links and headings in large Wiki documents while retaining bounded chat previews", () => {
    const source = `# Beginning\n\n${"Body ".repeat(30_000)}\n\n[Late link](other.md#late-section)\n\n###### Late section`;
    expect(source.length).toBeGreaterThan(140_000);
    const wiki = htmlFragment(toSanitizedMarkdownHtml(source, { wikiLinks: true }));
    expect(wiki.querySelector("a")?.dataset.wikiPath).toBe("other.md#late-section");
    expect(wiki.querySelector("h6")?.textContent).toBe("Late section");
    const regular = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(regular.querySelector("a, h1, h6")).toBeNull();
    expect(regular.textContent).not.toContain("Late section");
    const overLimit = `# Beginning\n\n${"Body ".repeat(220_000)}\n\n###### Beyond the Wiki limit`;
    const capped = htmlFragment(toSanitizedMarkdownHtml(overLimit, { wikiLinks: true }));
    expect(capped.querySelector("h1")?.textContent).toBe("Beginning");
    expect(capped.textContent).not.toContain("Beyond the Wiki limit");
    expect(capped.textContent).toContain("1048576");
  });
  it("retains all heading levels for Wiki navigation without changing the default renderer", () => {
    const source = "##### Details\n\n###### Deep section";
    const regular = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(regular.querySelector("h5, h6")).toBeNull();
    const wiki = htmlFragment(toSanitizedMarkdownHtml(source, { wikiLinks: true }));
    expect(wiki.querySelector("h5")?.textContent).toBe("Details");
    expect(wiki.querySelector("h6")?.textContent).toBe("Deep section");
  });
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
  it("preserves Wiki-relative paths without changing chat docs links or URL safety", () => {
    const source = [
      "[Root](/concepts/setup.md#start) [Relative](../other.md#details) [Local](#start)",
      "[Reference][root] [[/concepts/setup.md#start]]",
      "[Web](https://example.com/page) [Email](mailto:owner@example.com)",
      "[Bad](javascript:alert(1)) [Data](data:text/html,test) [Local file](/home/user/secret.md)",
      "",
      "[root]: /concepts/setup.md#start",
    ].join("\n");
    const ordinary = htmlFragment(toSanitizedMarkdownHtml(source));
    expect(ordinary.querySelector("a")?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/concepts/setup.md#start",
    );
    expect(ordinary.querySelector("[data-wiki-path]")).toBeNull();
    const wiki = htmlFragment(toSanitizedMarkdownHtml(source, { wikiLinks: true }));
    const links = [...wiki.querySelectorAll<HTMLAnchorElement>("a")];
    const named = (label: string) => links.find((link) => link.textContent === label)!;
    expect(named("Root").getAttribute("href")).toBe("/concepts/setup.md#start");
    expect(named("Reference").dataset.wikiPath).toBe("/concepts/setup.md#start");
    expect(named("Relative").dataset.wikiPath).toBe("../other.md#details");
    expect(named("Local").dataset.wikiPath).toBe("#start");
    expect(wiki.querySelector("[data-wiki-lookup]")?.getAttribute("href")).toBe(
      "/concepts/setup.md#start",
    );
    for (const [label, href] of [
      ["Web", "https://example.com/page"],
      ["Email", "mailto:owner@example.com"],
    ]) {
      expect(named(label!).getAttribute("href")).toBe(href);
      expect(named(label!).getAttribute("target")).toBe("_blank");
      expect(named(label!).dataset.wikiPath).toBeUndefined();
    }
    for (const label of ["Bad", "Data", "Local file"]) {
      expect(named(label).hasAttribute("href")).toBe(false);
      expect(named(label).dataset.wikiPath).toBeUndefined();
    }
  });
});
