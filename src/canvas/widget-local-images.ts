/** Bounded workspace image embedding for self-contained Canvas widgets. */
import path from "node:path";
import { sniffInlineImageMime } from "@openclaw/media-core/inline-image-data-url";
import type { SandboxFsBridge } from "../agents/sandbox/fs-bridge.types.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import { MAX_IMAGE_INPUT_PIXELS, readImageMetadataFromHeader } from "../media/image-ops.js";
import { WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";

const MAX_WIDGET_SOURCE_BYTES = 6 * 1024 * 1024;
const MAX_WIDGET_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_WIDGET_IMAGE_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_WIDGET_IMAGES = 16;
const MAX_WIDGET_IMAGE_DIMENSION = 8192;
const MAX_WIDGET_IMAGE_TOTAL_PIXELS = 16_777_216;
const BROWSER_IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type WidgetWorkspace = {
  root: string;
  bridge?: SandboxFsBridge;
};

type ParsedElement = {
  localName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
};

type ParsedDocument = {
  querySelector(selector: string): ParsedElement | null;
  querySelectorAll(selector: string): Iterable<ParsedElement>;
  toString(): string;
};

type ImageReference = {
  element: ParsedElement;
  attribute: string;
  value: string;
};

type ParseHtml = (html: string) => { document: ParsedDocument };

let parseHtmlPromise: Promise<ParseHtml> | undefined;

async function loadParseHtml(): Promise<ParseHtml> {
  parseHtmlPromise ??= import("linkedom").then(
    (module) => module.parseHTML as unknown as ParseHtml,
  );
  return await parseHtmlPromise;
}

function unsupported(message: string): WidgetHtmlInputError {
  return new WidgetHtmlInputError(
    `${message} Use a static <img src="relative/path.png"> with widget_path, or embed a data:image/... URL or a document-created blob: URL.`,
  );
}

function collectImageReferences(document: ParsedDocument): ImageReference[] {
  const references: ImageReference[] = [];
  const selectors = [
    ["img[src]", "src"],
    ['input[type="image"][src]', "src"],
    ["video[poster]", "poster"],
    ["image[href]", "href"],
    ["image[xlink\\:href]", "xlink:href"],
  ] as const;
  for (const [selector, attribute] of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const value = element.getAttribute(attribute)?.trim();
      if (value) {
        references.push({ element, attribute, value });
      }
    }
  }
  return references;
}

function assertNoUnsupportedImageSyntax(document: ParsedDocument): void {
  if (document.querySelector("[srcset]")) {
    throw unsupported("show_widget does not support srcset workspace images.");
  }
  for (const element of document.querySelectorAll("[style], style")) {
    const css = element.localName === "style" ? element.textContent : element.getAttribute("style");
    if (!css) {
      continue;
    }
    for (const match of css.matchAll(/url\s*\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/giu)) {
      const value = (match[2] ?? match[3] ?? "").trim();
      if (value && !value.startsWith("#") && !/^(?:data|blob):/iu.test(value)) {
        throw unsupported("show_widget does not resolve local or HTTP CSS url() assets.");
      }
    }
  }
}

function classifyImageReference(value: string): "inline" | "local" | "unsupported" {
  if (value.startsWith("#") || /^(?:data|blob):/iu.test(value)) {
    return "inline";
  }
  if (/^(?:https?|file|javascript):/iu.test(value) || value.startsWith("//")) {
    return "unsupported";
  }
  return "local";
}

function decodeLocalReference(value: string): string {
  const pathname = value.split(/[?#]/u, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw unsupported(`show_widget image path is invalid: ${value}`);
  }
  if (!decoded || decoded.includes("\0")) {
    throw unsupported(`show_widget image path is invalid: ${value}`);
  }
  return decoded;
}

async function readWorkspaceFile(params: {
  workspace: WidgetWorkspace;
  filePath: string;
  cwd?: string;
  maxBytes: number;
}): Promise<Buffer> {
  if (params.workspace.bridge) {
    return await params.workspace.bridge.readFile({
      filePath: params.filePath,
      cwd: params.cwd ?? params.workspace.root,
      maxBytes: params.maxBytes,
    });
  }
  const root = await fsRoot(params.workspace.root);
  const absolute = path.isAbsolute(params.filePath)
    ? path.resolve(params.filePath)
    : path.resolve(params.cwd ?? params.workspace.root, params.filePath);
  const relative = path.relative(path.resolve(params.workspace.root), absolute);
  const read = await root.read(relative, {
    hardlinks: "reject",
    maxBytes: params.maxBytes,
    symlinks: "reject",
  });
  return read.buffer;
}

function resolveSourceDirectory(workspace: WidgetWorkspace, widgetPath: string): string {
  if (workspace.bridge) {
    const resolved = workspace.bridge.resolveUserPath
      ? workspace.bridge.resolveUserPath({ filePath: widgetPath, cwd: workspace.root })
      : workspace.bridge.resolvePath({ filePath: widgetPath, cwd: workspace.root });
    return path.posix.dirname(resolved.containerPath);
  }
  return path.dirname(
    path.isAbsolute(widgetPath)
      ? path.resolve(widgetPath)
      : path.resolve(workspace.root, widgetPath),
  );
}

export async function embedWidgetWorkspaceImages(params: {
  widgetCode: string;
  widgetPath?: string;
  workspace?: WidgetWorkspace;
}): Promise<string> {
  const parseHtml = await loadParseHtml();
  const { document } = parseHtml(params.widgetCode);
  assertNoUnsupportedImageSyntax(document);
  const references = collectImageReferences(document);
  const localReferences = references.filter(
    (reference) => classifyImageReference(reference.value) === "local",
  );
  const unsupportedReference = references.find(
    (reference) => classifyImageReference(reference.value) === "unsupported",
  );
  if (unsupportedReference) {
    throw unsupported(`show_widget cannot fetch image URL: ${unsupportedReference.value}`);
  }
  if (localReferences.length === 0 && !params.widgetPath) {
    return params.widgetCode;
  }
  if (!params.widgetPath) {
    throw unsupported("Relative or local image references require widget_path.");
  }
  if (!params.workspace) {
    throw unsupported("widget_path requires an active agent workspace.");
  }

  const source = await readWorkspaceFile({
    workspace: params.workspace,
    filePath: params.widgetPath,
    maxBytes: MAX_WIDGET_SOURCE_BYTES,
  });
  if (!source.equals(Buffer.from(params.widgetCode, "utf8"))) {
    throw new WidgetHtmlInputError(
      "widget_path content must exactly match widget_code. Read the saved HTML file again and pass its unchanged contents.",
    );
  }
  if (localReferences.length === 0) {
    return params.widgetCode;
  }

  const uniquePaths = new Set(localReferences.map((reference) => reference.value));
  if (uniquePaths.size > MAX_WIDGET_IMAGES) {
    throw new WidgetHtmlInputError(
      `show_widget supports at most ${MAX_WIDGET_IMAGES} local images.`,
    );
  }
  const sourceDirectory = resolveSourceDirectory(params.workspace, params.widgetPath);
  const embedded = new Map<string, string>();
  let totalBytes = 0;
  let totalPixels = 0;
  for (const reference of localReferences) {
    let dataUrl = embedded.get(reference.value);
    if (!dataUrl) {
      const image = await readWorkspaceFile({
        workspace: params.workspace,
        filePath: decodeLocalReference(reference.value),
        cwd: sourceDirectory,
        maxBytes: MAX_WIDGET_IMAGE_BYTES,
      });
      totalBytes += image.byteLength;
      if (totalBytes > MAX_WIDGET_IMAGE_TOTAL_BYTES) {
        throw new WidgetHtmlInputError(
          `show_widget local images exceed ${MAX_WIDGET_IMAGE_TOTAL_BYTES} total bytes. Compress or resize them and retry.`,
        );
      }
      const mimeType = sniffInlineImageMime(image);
      if (!mimeType || !BROWSER_IMAGE_MIMES.has(mimeType)) {
        throw unsupported(
          `show_widget local image is not a supported PNG, JPEG, WebP, or GIF: ${reference.value}`,
        );
      }
      const dimensions = readImageMetadataFromHeader(image);
      if (
        !dimensions ||
        dimensions.width <= 0 ||
        dimensions.height <= 0 ||
        dimensions.width > MAX_WIDGET_IMAGE_DIMENSION ||
        dimensions.height > MAX_WIDGET_IMAGE_DIMENSION ||
        dimensions.width > MAX_IMAGE_INPUT_PIXELS / dimensions.height
      ) {
        throw new WidgetHtmlInputError(
          `show_widget local image dimensions are invalid or exceed ${MAX_WIDGET_IMAGE_DIMENSION}px / ${MAX_IMAGE_INPUT_PIXELS} pixels: ${reference.value}. Resize the image and retry.`,
        );
      }
      totalPixels += dimensions.width * dimensions.height;
      if (totalPixels > MAX_WIDGET_IMAGE_TOTAL_PIXELS) {
        throw new WidgetHtmlInputError(
          `show_widget local images exceed ${MAX_WIDGET_IMAGE_TOTAL_PIXELS} aggregate decoded pixels. Resize or remove images and retry.`,
        );
      }
      dataUrl = `data:${mimeType};base64,${image.toString("base64")}`;
      embedded.set(reference.value, dataUrl);
    }
    reference.element.setAttribute(reference.attribute, dataUrl);
  }
  return document.toString();
}
