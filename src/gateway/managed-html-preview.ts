import { randomBytes } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { serializeHtmlDocument } from "../infra/html-document-serialization.js";
import { omitHtmlPreviewCssAssets } from "./managed-html-preview-css.js";

const MAX_HTML_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_MESSAGE_TYPE = "openclaw:html-attachment-preview";
const ASSET_NOTICE =
  "Some local or external assets cannot be shown in this isolated preview. Download the original HTML to inspect its references.";

class HtmlPreviewInputError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function previewContentSecurityPolicy(
  scriptNonce: string,
  strict: boolean,
  surface: "outer" | "child",
): string {
  return [
    ...(surface === "outer" ? ["sandbox allow-scripts"] : []),
    "default-src 'none'",
    `script-src ${strict ? `'nonce-${scriptNonce}'` : "'unsafe-inline'"}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "object-src 'none'",
    `frame-src ${surface === "outer" ? "about:" : "'none'"}`,
    "child-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    ...(surface === "outer" ? ["frame-ancestors 'self'"] : []),
  ].join("; ");
}

function isInlineImageReference(value: string): boolean {
  return /^(?:data:image\/|blob:)/iu.test(value.trim());
}

function buildPreviewBootstrap(nonce: string, status: "ready" | "error", message?: string): string {
  const payload = JSON.stringify({
    type: PREVIEW_MESSAGE_TYPE,
    nonce,
    status,
    ...(message ? { message } : {}),
  });
  // The next task lets authored load handlers and their microtasks initialize
  // images before missing-source cleanup/readiness. This is lifecycle ordering,
  // not a retry; messages carry no host authority and remain frame/nonce-bound.
  return `(()=>{const send=parent.postMessage.bind(parent);const create=document.createElement.bind(document);const afterEvent=window.setTimeout.bind(window);const replace=image=>{if(!image.parentNode)return;const placeholder=create("span");placeholder.textContent="[Image unavailable in this isolated preview]";placeholder.setAttribute("role","img");image.replaceWith(placeholder)};document.addEventListener("error",event=>{const image=event.target;const source=image&&image.localName==="img"?image.getAttribute("src"):null;if(source?.trim())afterEvent(()=>{if(image.getAttribute("src")===source&&image.naturalWidth===0)replace(image)},0)},true);window.addEventListener("load",()=>afterEvent(()=>{for(const image of document.querySelectorAll("img"))if(!image.getAttribute("src")?.trim())replace(image);send(${payload},"*")},0),{once:true})})();`;
}

function buildErrorPreview(
  message: string,
  scriptNonce: string,
  previewNonce: string,
  strict: boolean,
): string {
  const text = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const csp = previewContentSecurityPolicy(scriptNonce, strict, "child").replaceAll('"', "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><script nonce="${scriptNonce}">${buildPreviewBootstrap(previewNonce, "error", message)}</script></head><body><p role="alert">${text}</p></body></html>`;
}

function buildHtmlPreviewShell(
  childHtml: string,
  scriptNonce: string,
  previewNonce: string,
): string {
  // Authored bytes enter only srcdoc. Escaping '<' prevents an authored closing
  // script tag from escaping its JSON string into the privileged outer shell.
  const encodedHtml = JSON.stringify(childHtml)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const encodedNonce = JSON.stringify(previewNonce);
  const encodedMessageType = JSON.stringify(PREVIEW_MESSAGE_TYPE);
  const navigationError = JSON.stringify({
    type: PREVIEW_MESSAGE_TYPE,
    nonce: previewNonce,
    status: "error",
    message:
      "Navigation is unavailable in this isolated preview. Close and reopen the preview, or download the original HTML.",
  });
  // Browsers may replace a CSP-blocked child navigation with an error document.
  // Latch the visible failure so delayed child readiness cannot hide recovery.
  const bootstrap = `(()=>{const childHtml=${encodedHtml};let failed=false;const frame=document.createElement("iframe");frame.setAttribute("sandbox","allow-scripts");frame.setAttribute("title","HTML attachment preview");window.addEventListener("securitypolicyviolation",event=>{if(event.effectiveDirective!=="frame-src"||failed)return;failed=true;parent.postMessage(${navigationError},"*")});window.addEventListener("message",event=>{for(const port of event.ports||[])port.close();const data=event.data;if(failed||event.source!==frame.contentWindow||!data||data.type!==${encodedMessageType}||data.nonce!==${encodedNonce}||(data.status!=="ready"&&data.status!=="error"))return;failed=data.status==="error";parent.postMessage({type:${encodedMessageType},nonce:${encodedNonce},status:data.status,...(typeof data.message==="string"?{message:data.message.slice(0,500)}:{})},"*")});frame.srcdoc=childHtml;document.body.append(frame)})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{width:100%;height:100%;margin:0}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><script nonce="${scriptNonce}">${bootstrap}</script></body></html>`;
}

/** Prepare a separate display copy; the managed attachment's original bytes stay unchanged. */
async function buildHtmlPreviewDocument(params: {
  source: string;
  scriptNonce: string;
  previewNonce: string;
  strict: boolean;
}): Promise<string> {
  const { DOMParser } = await import("linkedom");
  const parser = new DOMParser();
  let document = parser.parseFromString(params.source, "text/html");
  if (document.documentElement?.localName !== "html") {
    document = parser.parseFromString(
      `<!doctype html><html><head></head><body>${params.source}</body></html>`,
      "text/html",
    );
  }
  let omittedAssets = false;
  for (const element of document.querySelectorAll(
    "base, meta[http-equiv], iframe, frame, object, embed, link[href], script[src]",
  )) {
    element.remove();
    omittedAssets = true;
  }
  for (const element of document.querySelectorAll("[srcset]")) {
    element.removeAttribute("srcset");
    omittedAssets = true;
  }
  for (const element of document.querySelectorAll("style, [style]")) {
    const style =
      element.localName === "style" ? element.textContent : element.getAttribute("style");
    const prepared = style ? omitHtmlPreviewCssAssets(style) : undefined;
    if (prepared?.omitted) {
      if (element.localName === "style") {
        element.textContent = prepared.css;
      } else {
        element.setAttribute("style", prepared.css);
      }
      omittedAssets = true;
    }
  }
  for (const [selector, attribute] of [
    ["img[src]", "src"],
    ['input[type="image"][src]', "src"],
    ["video[poster]", "poster"],
    ["image[href]", "href"],
    ["image[xlink\\:href]", "xlink:href"],
    ["feImage[href]", "href"],
    ["feImage[xlink\\:href]", "xlink:href"],
  ] as const) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute) ?? "";
      if (
        isInlineImageReference(value) ||
        // feImage can reference an SVG element like use; image/img instead
        // require a complete image resource, not a same-document element.
        (element.localName.toLowerCase() === "feimage" && value.trim().startsWith("#")) ||
        (element.localName === "img" && !params.strict && !value.trim())
      ) {
        continue;
      }
      element.removeAttribute(attribute);
      if (element.localName === "img") {
        const placeholder = document.createElement("span");
        placeholder.textContent = "[Image unavailable in this isolated preview]";
        placeholder.setAttribute("role", "img");
        element.replaceWith(placeholder);
      }
      omittedAssets = true;
    }
  }
  for (const element of document.querySelectorAll("use[href], use[xlink\\:href]")) {
    for (const attribute of ["href", "xlink:href"]) {
      const value = element.getAttribute(attribute);
      if (value !== null && !value.trim().startsWith("#")) {
        element.removeAttribute(attribute);
        omittedAssets = true;
      }
    }
  }
  for (const element of document.querySelectorAll("audio, video")) {
    const placeholder = document.createElement("span");
    placeholder.textContent = "[Media unavailable in this isolated preview]";
    element.replaceWith(placeholder);
    omittedAssets = true;
  }
  for (const element of document.querySelectorAll("source[src], track[src]")) {
    element.remove();
    omittedAssets = true;
  }
  if (params.strict) {
    for (const image of document.querySelectorAll("img")) {
      if (!image.getAttribute("src")?.trim()) {
        const placeholder = document.createElement("span");
        placeholder.textContent = "[Image unavailable in this isolated preview]";
        placeholder.setAttribute("role", "img");
        image.replaceWith(placeholder);
        omittedAssets = true;
      }
    }
  }
  // Navigation fragments inherit srcdoc's HTTP fallback base, unlike CSS local
  // url(#id) and SVG structural references. Pin links to this document and frame.
  for (const element of document.querySelectorAll("a[href], a[xlink\\:href], area[href]")) {
    for (const attribute of ["href", "xlink:href"]) {
      const value = element.getAttribute(attribute)?.trim();
      if (value === undefined) {
        continue;
      }
      if (value.startsWith("#")) {
        element.setAttribute(attribute, `about:srcdoc${value}`);
        element.setAttribute("target", "_self");
      } else {
        element.removeAttribute(attribute);
        omittedAssets = true;
      }
    }
  }
  for (const element of document.querySelectorAll("form[action]")) {
    element.removeAttribute("action");
    omittedAssets = true;
  }
  if (omittedAssets) {
    const notice = document.createElement("p");
    notice.setAttribute("role", "status");
    notice.setAttribute("data-openclaw-html-preview-notice", "");
    notice.textContent = ASSET_NOTICE;
    document.body.prepend(notice);
  }
  const bootstrap = document.createElement("script");
  bootstrap.setAttribute("nonce", params.scriptNonce);
  bootstrap.textContent = buildPreviewBootstrap(params.previewNonce, "ready");
  const policy = document.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute(
    "content",
    previewContentSecurityPolicy(params.scriptNonce, params.strict, "child"),
  );
  document.head.prepend(policy, bootstrap);
  return serializeHtmlDocument(document);
}

async function readBoundedHtmlPreview(handle: FileHandle, size: number): Promise<string> {
  if (size > MAX_HTML_PREVIEW_BYTES) {
    throw new HtmlPreviewInputError(
      413,
      "HTML preview exceeds 2 MiB. Download the original file instead.",
    );
  }
  const buffer = Buffer.alloc(MAX_HTML_PREVIEW_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const result = await handle.read(buffer, length, buffer.length - length, length);
    if (result.bytesRead === 0) {
      break;
    }
    length += result.bytesRead;
  }
  if (length > MAX_HTML_PREVIEW_BYTES) {
    throw new HtmlPreviewInputError(
      413,
      "HTML preview exceeds 2 MiB. Download the original file instead.",
    );
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    if (source.includes("\0")) {
      throw new Error("binary HTML");
    }
    return source;
  } catch {
    throw new HtmlPreviewInputError(
      422,
      "HTML preview requires UTF-8 text. Download the original file instead.",
    );
  }
}

/** Serve only an already-authorized managed snapshot, never a model-supplied path. */
export async function serveManagedHtmlPreview(params: {
  response: ServerResponse;
  method?: string;
  url: URL;
  file: { handle: FileHandle; stat: { size: number } };
  contentType: string;
  isEnabled: () => boolean;
  isStrict: () => boolean;
  revalidate: () => Promise<boolean>;
}): Promise<void> {
  const scriptNonce = randomBytes(24).toString("base64");
  const requestedNonce = params.url.searchParams.get("previewNonce") ?? "";
  const previewNonce = /^[A-Za-z0-9_-]{16,128}$/u.test(requestedNonce) ? requestedNonce : "";
  let strict = params.url.searchParams.get("previewMode") === "strict" || params.isStrict();
  let source: string;
  let message: string | undefined;
  let statusCode = 200;
  try {
    if (!params.isEnabled()) {
      throw new HtmlPreviewInputError(
        503,
        "HTML preview is disabled by the Canvas host setting. Download the original file instead.",
      );
    }
    if (params.contentType.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") {
      throw new HtmlPreviewInputError(
        415,
        "Only HTML attachments support this preview. Download the original file instead.",
      );
    }
    source = await readBoundedHtmlPreview(params.file.handle, params.file.stat.size);
  } catch (error) {
    statusCode = error instanceof HtmlPreviewInputError ? error.statusCode : 422;
    message =
      error instanceof HtmlPreviewInputError
        ? error.message
        : "HTML preview could not be read. Download the original file instead.";
    source = "<!doctype html><html><head></head><body></body></html>";
  } finally {
    await params.file.handle.close();
  }
  let childHtml: string;
  try {
    childHtml = message
      ? buildErrorPreview(message, scriptNonce, previewNonce, strict)
      : await buildHtmlPreviewDocument({ source, scriptNonce, previewNonce, strict });
  } catch {
    statusCode = 422;
    childHtml = buildErrorPreview(
      "HTML preview could not be prepared. Download the original file instead.",
      scriptNonce,
      previewNonce,
      strict,
    );
  }
  let body = buildHtmlPreviewShell(childHtml, scriptNonce, previewNonce);
  if (Buffer.byteLength(body) > MAX_HTML_PREVIEW_BYTES) {
    statusCode = 413;
    body = buildHtmlPreviewShell(
      buildErrorPreview(
        "HTML preview exceeds 2 MiB. Download the original file instead.",
        scriptNonce,
        previewNonce,
        strict,
      ),
      scriptNonce,
      previewNonce,
    );
  }
  // Reading/parsing yields. A revoked transcript attachment or expired ticket
  // must not become a newly served active HTML document after that work.
  if (!(await params.revalidate())) {
    return;
  }
  // A URL may tighten the operator's sandbox policy, never loosen it. A change
  // during awaited preparation also constrains the srcdoc through inheritance.
  strict ||= params.isStrict();
  if (!params.isEnabled()) {
    statusCode = 503;
    body = buildHtmlPreviewShell(
      buildErrorPreview(
        "HTML preview is disabled by the Canvas host setting. Download the original file instead.",
        scriptNonce,
        previewNonce,
        strict,
      ),
      scriptNonce,
      previewNonce,
    );
  }
  params.response.statusCode = statusCode;
  params.response.setHeader("Content-Type", "text/html; charset=utf-8");
  params.response.setHeader("Content-Disposition", "inline");
  params.response.setHeader("Cache-Control", "no-store");
  params.response.setHeader("X-Content-Type-Options", "nosniff");
  params.response.setHeader("Referrer-Policy", "no-referrer");
  params.response.setHeader(
    "Content-Security-Policy",
    previewContentSecurityPolicy(scriptNonce, strict, "outer"),
  );
  params.response.setHeader("Content-Length", Buffer.byteLength(body));
  params.response.end(params.method === "HEAD" ? undefined : body);
}
