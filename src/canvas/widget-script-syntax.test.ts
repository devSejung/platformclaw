import { describe, expect, it } from "vitest";
import { findWidgetScriptSyntaxError } from "./widget-script-syntax.js";

describe("widget script syntax", () => {
  it("reports the original untrimmed source location and first failing script", () => {
    const source = [
      "",
      '<script type="application/json">not JavaScript</script>',
      "<section>",
      "  <script>const a='x",
      "'+b;</script>",
      "<script>const =</script></section>",
    ].join("\n");
    expect(findWidgetScriptSyntaxError(source)).toEqual({
      message: "Unterminated string constant",
      scriptIndex: 2,
      line: 4,
      column: 18,
      snippet: "<script>const a='x",
    });
  });

  it.each([
    "<p>No scripts</p>",
    '<script>const html = "<!--<script></script>-->";</script>',
    '<script>const html = "<!--<script></script>";</script>',
    '<script>const html = "<!--<script>-->";</script>',
    '<script>const html = "<!--<ScRiPt/></SCRIPT>-->";</script>',
    '<script>const value = "</scripture>";</script>',
    '<script type="&#109;odule">await Promise.resolve(); export {};</script>',
    '<script type="module" type="application/json">export {};</script>',
    '<script TYPE=" Text/JavaScript ">throw new Error("not executed");</script>',
    '<script data-label="src=ignored > type=application/json">const value=1;</SCRIPT>',
    '<script>const value=1;</script data-note="> <script>const =</script>">',
    "<script>#!/usr/bin/env node\nconst value=1;</script>",
    "<script/>const value=1;</script>",
    "1 < 2 <script>const value=1;</script>",
    "<!doctype html><script>const value=1;</script>",
    '<button onclick="const =">Handlers are not parsed before rendering</button>',
  ])("accepts browser script grammar without executing it: %s", (source) => {
    expect(findWidgetScriptSyntaxError(source)).toBeUndefined();
  });

  it.each(["", "type", "type='text/javascript'", "type=application/javascript"])(
    "rejects module-only await in a classic script: %s",
    (attributes) => {
      expect(
        findWidgetScriptSyntaxError(`<script ${attributes}>await Promise.resolve();</script>`),
      ).toMatchObject({ scriptIndex: 1 });
    },
  );

  it("does not use the wrapped-function grammar of code mode", () => {
    expect(findWidgetScriptSyntaxError("<script>return 1;</script>")).toBeDefined();
  });

  it.each([
    '<script type="application/json">const =</script>',
    '<script type="importmap">{"imports":{}}</script>',
    '<script SRC="script.js">const =</script>',
    "<script src>const =</script>",
    "<!-- <script>const =</script>",
    "<!-- <script>const =</script> -->",
    "<script-example>const =</script-example>",
    '<div title="İ <script>const =</script>">Text</div>',
    '<div title="<script>const =</script>',
    "<plaintext></plaintext><script>const =</script>",
  ])("ignores non-executable scripts and script-looking text: %s", (source) => {
    expect(findWidgetScriptSyntaxError(source)).toBeUndefined();
  });

  it.each(["style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"])(
    "does not validate raw text inside %s, and resumes after its real closing tag",
    (tag) => {
      const prefix = `<${tag}>ignored </${tag}x><script>const =</script></${tag.toUpperCase()} >`;
      expect(findWidgetScriptSyntaxError(prefix)).toBeUndefined();
      expect(findWidgetScriptSyntaxError(`<${tag}><script>const =</script>`)).toBeUndefined();
      expect(findWidgetScriptSyntaxError(`${prefix}\n<script>const =</script>`)).toMatchObject({
        scriptIndex: 1,
        line: 2,
        column: 14,
      });
    },
  );

  it.each(["</script/>", '</script foo="bar">', "</SCRIPT >", ""])(
    "parses through a browser script terminator or EOF: %s",
    (endTag) => {
      expect(findWidgetScriptSyntaxError(`<script>const =${endTag}`)).toMatchObject({
        scriptIndex: 1,
        line: 1,
        column: 14,
      });
      expect(findWidgetScriptSyntaxError(`<script>const value=1;${endTag}`)).toBeUndefined();
    },
  );

  it.each([
    '<script>const html = "<script></script>";</script>',
    '<script>const html = "<!--<scripture></script>";</script>',
    '<script>const html = "</SCRIPT>";</script>',
  ])("recognizes an HTML script ending inside JavaScript-looking text: %s", (source) => {
    expect(findWidgetScriptSyntaxError(source)?.message).toBe("Unterminated string constant");
  });

  it.each([
    "<svg><svg></svg><script><![CDATA[const value=1;]]></script></svg>",
    '<svg><script><![CDATA[const text="</script>";]]></script></svg>',
    "<svg><text><![CDATA[> <script>const =</script>]]></text></svg>",
    '<svg><foreignObject><script>const text="<![CDATA[";</script></foreignObject></svg>',
    "<svg><foreignObject/><script><![CDATA[const value=1;]]></script></svg>",
    '<SVG xmlns="http://www.w3.org/2000/svg"><script> \n<![CDATA[const value=1;]]> \n</script></SVG>',
  ])("respects foreign SVG CDATA and HTML integration points: %s", (source) => {
    expect(findWidgetScriptSyntaxError(source)).toBeUndefined();
  });

  it.each([
    { source: "<svg><script><![CDATA[const =]]></script></svg>", line: 1, column: 28 },
    { source: "<svg>\r\n<script>\n<![CDATA[\nconst =\n]]>\n</script></svg>", line: 4, column: 6 },
  ])("maps SVG CDATA diagnostics to the original source: $source", ({ source, line, column }) => {
    expect(findWidgetScriptSyntaxError(source)).toMatchObject({
      message: "Unexpected token",
      scriptIndex: 1,
      line,
      column,
    });
  });

  it.each([
    "<svg><title/></svg><script>const =</script>",
    "<svg><style/><script>const =</script></svg>",
    "<svg><text><![CDATA[text]]></text></svg><script>const =</script>",
    "<svg><foreignObject><script>const =</script></foreignObject></svg>",
    "<svg><foreignObject><script><![CDATA[const value=1;]]></script></foreignObject></svg>",
    "<svg/><script><![CDATA[const value=1;]]></script>",
  ])("does not hide errors after foreign-content boundaries: %s", (source) => {
    expect(findWidgetScriptSyntaxError(source)).toBeDefined();
  });

  it.each(["text&#47;javascript", "text&sol;javascript", "&#109;odule"])(
    "decodes executable script type attributes: %s",
    (type) => {
      expect(findWidgetScriptSyntaxError(`<script type="${type}">const =</script>`)).toMatchObject({
        message: "Unexpected token",
        scriptIndex: 1,
      });
    },
  );

  it("keeps bounded diagnostics on whole Unicode code points", () => {
    const prefix = `<script>${"a".repeat(151)}`;
    expect(findWidgetScriptSyntaxError(`${prefix}😀 const =</script>`)?.snippet).toBe(prefix);
    const identifier = `${"a".repeat(187)}\u{1D400}`;
    expect(
      findWidgetScriptSyntaxError(`<script>let ${identifier}=1;let ${identifier}=2;</script>`)
        ?.message,
    ).toBe(`Identifier '${"a".repeat(187)}`);
    expect(
      findWidgetScriptSyntaxError(`<script>const = ${"x".repeat(1_000)}</script>`)?.snippet,
    ).toHaveLength(160);
  });
});
