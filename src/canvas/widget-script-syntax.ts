import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getLineInfo, parse } from "acorn";
import { decodeHTMLAttribute } from "entities";

/** JavaScript MIME type essences from the HTML script processing contract. */
const JAVASCRIPT_MIME_ESSENCES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

function scriptSourceType(attributes: string): "script" | "module" | undefined {
  let type: string | undefined;
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const attribute of attributes.matchAll(pattern)) {
    const name = (attribute[1] ?? "").toLowerCase();
    if (name === "src") {
      return undefined;
    }
    if (name === "type") {
      type ??= decodeHTMLAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? "")
        .trim()
        .toLowerCase();
    }
  }
  if (type === "module") {
    return "module";
  }
  return !type || JAVASCRIPT_MIME_ESSENCES.has(type) ? "script" : undefined;
}

/** Quoted attribute values may contain brackets and script-looking text. */
function findTagEnd(html: string, start: number): number {
  let quote = "";
  for (let position = start; position < html.length; position++) {
    const char = html[position];
    if (quote) {
      if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return position;
    }
  }
  return html.length;
}

/** Double-escaped script data and foreign CDATA cannot close the current script. */
function findRawTextEnd(html: string, start: number, name: string, foreign: boolean): number {
  const tokens =
    name === "script"
      ? foreign
        ? /<!\[CDATA\[|\]\]>|<!--|-->|<\/?script(?=[\t\n\f\r />])/gi
        : /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi
      : new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
  tokens.lastIndex = start;
  let state: "data" | "escaped" | "double-escaped" | "cdata" = "data";
  for (const match of html.matchAll(tokens)) {
    const token = match[0].toLowerCase();
    if (state === "cdata") {
      if (token === "]]>") {
        state = "data";
      }
    } else if (token === "<![cdata[") {
      state = "cdata";
    } else if (token === "<!--" && state === "data") {
      state = "escaped";
    } else if (token === "-->") {
      state = "data";
    } else if (token.startsWith("</")) {
      if (state !== "double-escaped") {
        return match.index;
      }
      state = "escaped";
    } else if (token === "<script" && state === "escaped") {
      state = "double-escaped";
    }
  }
  return html.length;
}

function parseWidgetScript(body: string, sourceType: "script" | "module") {
  try {
    parse(body, { ecmaVersion: "latest", sourceType });
  } catch (error) {
    if (!(error instanceof SyntaxError) || !("pos" in error) || typeof error.pos !== "number") {
      throw error;
    }
    return {
      pos: error.pos,
      message: truncateUtf16Safe(error.message.replace(/ \(\d+:\d+\)$/u, ""), 200),
    };
  }
  return undefined;
}

/**
 * Validate inline scripts against their browser grammar before publishing a widget.
 * Scan the unmodified HTML so diagnostics still identify the caller's exact source.
 * SVG covers CDATA-wrapped scripts, opaque CDATA, self-closing foreign elements,
 * and foreignObject integration. Interleaved script CDATA, foreign character
 * references, and nested SVG inside foreignObject are intentionally not modeled;
 * these may return a tool error rather than publish code whose grammar is uncertain.
 */
export function findWidgetScriptSyntaxError(widgetCode: string) {
  const tags = /<\/?([a-z][^\t\n\f\r />]*)/iy;
  let position = 0;
  let scriptIndex = 0;
  let svgDepth = 0;
  let foreignObjectDepth = 0;
  while (position < widgetCode.length) {
    const start = widgetCode.indexOf("<", position);
    if (start < 0) {
      break;
    }
    position = start + 1;
    if (widgetCode.startsWith("<!--", start)) {
      const end = widgetCode.indexOf("-->", start + 4);
      position = end < 0 ? widgetCode.length : end + 3;
      continue;
    }
    const foreign = svgDepth > 0 && foreignObjectDepth === 0;
    if (foreign && widgetCode.startsWith("<![CDATA[", start)) {
      const end = widgetCode.indexOf("]]>", start + 9);
      position = end < 0 ? widgetCode.length : end + 3;
      continue;
    }
    tags.lastIndex = start;
    const tag = tags.exec(widgetCode);
    if (!tag) {
      if (widgetCode[position] === "!" || widgetCode[position] === "/") {
        position = findTagEnd(widgetCode, position + 1) + 1;
      }
      continue;
    }
    const attributesStart = tags.lastIndex;
    const tagEnd = findTagEnd(widgetCode, attributesStart);
    position = tagEnd + 1;
    if (tagEnd === widgetCode.length) {
      continue;
    }
    const name = (tag[1] ?? "").toLowerCase();
    const closing = widgetCode[start + 1] === "/";
    const selfClosing = widgetCode[tagEnd - 1] === "/";
    if (name === "svg") {
      svgDepth = closing ? Math.max(0, svgDepth - 1) : svgDepth + (selfClosing ? 0 : 1);
    } else if (name === "foreignobject" && svgDepth > 0) {
      foreignObjectDepth = closing
        ? Math.max(0, foreignObjectDepth - 1)
        : foreignObjectDepth + (selfClosing ? 0 : 1);
    }
    if (closing) {
      continue;
    }
    if (name === "plaintext") {
      break;
    }
    if (!/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/.test(name)) {
      continue;
    }
    // The slash closes foreign elements; HTML script/raw-text elements ignore it.
    if (foreign && selfClosing) {
      continue;
    }
    let bodyStart = position;
    const bodyEnd = findRawTextEnd(widgetCode, bodyStart, name, foreign);
    position = bodyEnd < widgetCode.length ? findTagEnd(widgetCode, bodyEnd + 2) + 1 : bodyEnd;
    if (name !== "script") {
      continue;
    }
    scriptIndex++;
    const sourceType = scriptSourceType(widgetCode.slice(attributesStart, tagEnd));
    if (!sourceType) {
      continue;
    }
    let body = widgetCode.slice(bodyStart, bodyEnd);
    const trimmed = body.trim();
    if (foreign && trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
      bodyStart += body.length - body.trimStart().length + "<![CDATA[".length;
      body = trimmed.slice("<![CDATA[".length, -"]]>".length);
    }
    const error = parseWidgetScript(body, sourceType);
    if (error) {
      const offset = bodyStart + error.pos;
      const { line, column } = getLineInfo(widgetCode, offset);
      const snippet = truncateUtf16Safe(
        (widgetCode.slice(offset - column).split(/[\r\n\u2028\u2029]/u, 1)[0] ?? "").trim(),
        160,
      );
      return { message: error.message, line, column, snippet, scriptIndex };
    }
  }
  return undefined;
}
