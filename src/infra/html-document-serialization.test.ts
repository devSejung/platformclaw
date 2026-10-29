import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
import { serializeHtmlDocument } from "./html-document-serialization.js";

it("preserves literal entities without consuming a reused parsed document", () => {
  const { document } = parseHTML(
    '<main data-chart="&amp;copy; &quot;A&amp;B&quot;"><template><span data-chart="&amp;#169;"></span></template><script>const label = "&copy;";</script></main>',
  );
  const original = document.querySelector("main")?.getAttribute("data-chart");
  const first = serializeHtmlDocument(document);

  expect(document.querySelector("main")?.getAttribute("data-chart")).toBe(original);
  expect(serializeHtmlDocument(document)).toBe(first);
  const parsed = parseHTML(first).document;
  expect(parsed.querySelector("main")?.getAttribute("data-chart")).toBe('&copy; "A&B"');
  expect(
    parsed.querySelector("template")?.content.querySelector("span")?.getAttribute("data-chart"),
  ).toBe("&#169;");
  expect(parsed.querySelector("script")?.textContent).toBe('const label = "&copy;";');
});
