import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { PDFPageProxy } from "./pdf-document.runtime.ts";

export type DocumentSelectionTarget = {
  region: { x: number; y: number; width: number; height: number };
  text: string;
};

type Matrix = [number, number, number, number, number, number];

function isFiniteMatrix(value: unknown): value is Matrix {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/** PDF font-metric boxes, not glyph outlines or native presentation objects. */
export function createDocumentSelectionTargets(
  content: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>,
  viewport: ReturnType<PDFPageProxy["getViewport"]>,
): DocumentSelectionTarget[] {
  const targets: DocumentSelectionTarget[] = [];
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    !isFiniteMatrix(viewport.transform)
  ) {
    return targets;
  }
  const [a, b, c, d, e, f] = viewport.transform;
  // PageViewport already includes page rotation, viewBox origin and userUnit.
  const scale = Math.hypot(a, b);
  if (!Number.isFinite(scale) || scale <= 0) {
    return targets;
  }
  // Bound scanned work as well as emitted boxes: marked content or invalid text
  // in a highly compressed page must not consume an unbounded geometry budget.
  for (const item of content.items.slice(0, 8_192)) {
    if (!("str" in item) || !item.str.trim() || !isFiniteMatrix(item.transform)) {
      continue;
    }
    const [ta, tb, tc, td, tx, ty] = item.transform;
    const style = content.styles[item.fontName];
    const vertical = style?.vertical ?? false;
    const advance = (vertical ? item.height : item.width) * scale;
    const fontHeight = Math.hypot(a * tc + c * td, b * tc + d * td);
    if (
      !Number.isFinite(item.width) ||
      !Number.isFinite(item.height) ||
      !Number.isFinite(advance) ||
      advance <= 0 ||
      !Number.isFinite(fontHeight) ||
      fontHeight <= 0
    ) {
      continue;
    }
    // TextLayer uses this baseline angle and vertical-writing adjustment. Its
    // browser-font measurements are unavailable here; retain the PDF metrics
    // fallback (ascent, then descent, then 0.8) without a DOM text overlay.
    const angle = Math.atan2(b * ta + d * tb, a * ta + c * tb) + (vertical ? Math.PI / 2 : 0);
    const fontAscent = style?.ascent;
    const fontDescent = style?.descent;
    const ascent =
      typeof fontAscent === "number" && Number.isFinite(fontAscent) && fontAscent > 0
        ? fontAscent
        : typeof fontDescent === "number" && Number.isFinite(fontDescent) && fontDescent < 0
          ? 1 + fontDescent
          : 0.8;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    const left = a * tx + c * ty + e + fontHeight * ascent * sin;
    const top = b * tx + d * ty + f - fontHeight * ascent * cos;
    const corners: [number, number][] = [
      [left, top],
      [left + advance * cos, top + advance * sin],
      [left - fontHeight * sin, top + fontHeight * cos],
      [left + advance * cos - fontHeight * sin, top + advance * sin + fontHeight * cos],
    ];
    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const x = Math.max(0, Math.min(...xs) / viewport.width);
    const y = Math.max(0, Math.min(...ys) / viewport.height);
    const right = Math.min(1, Math.max(...xs) / viewport.width);
    const bottom = Math.min(1, Math.max(...ys) / viewport.height);
    if (![x, y, right, bottom].every(Number.isFinite) || right <= x || bottom <= y) {
      continue;
    }
    targets.push({
      region: { x, y, width: right - x, height: bottom - y },
      text: truncateUtf16Safe(item.str.trim(), 1_024),
    });
    if (targets.length === 2_048) {
      break;
    }
  }
  return targets;
}
