import { describe, expect, it } from "vitest";
import { createDocumentSelectionTargets } from "./document-viewer-selection.ts";
import type { PDFPageProxy } from "./pdf-document.runtime.ts";

type Viewport = ReturnType<PDFPageProxy["getViewport"]>;
type Content = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type TextItem = Extract<Content["items"][number], { str: string }>;

function viewport(overrides: Partial<Viewport> = {}): Viewport {
  return {
    viewBox: [0, 0, 200, 200],
    userUnit: 1,
    scale: 1,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
    width: 200,
    height: 200,
    transform: [1, 0, 0, -1, 0, 200],
    rawDims: { pageWidth: 200, pageHeight: 200, pageX: 0, pageY: 0 },
    clone() {
      throw new Error("Geometry must use the supplied viewport");
    },
    convertToViewportPoint() {
      throw new Error("Geometry must use the supplied transform");
    },
    convertToPdfPoint() {
      throw new Error("Geometry must not invert the viewport");
    },
    ...overrides,
  };
}

function item(overrides: Partial<TextItem> = {}): TextItem {
  return {
    str: "Heading",
    dir: "ltr",
    transform: [20, 0, 0, 20, 50, 100],
    width: 60,
    height: 20,
    fontName: "heading",
    hasEOL: false,
    ...overrides,
  };
}

function content(items: Content["items"] = [item()], style = {}): Content {
  return {
    items,
    styles: {
      heading: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: "sans-serif", ...style },
    },
    lang: "en",
  };
}

function expectRegion(contentValue: Content, viewportValue: Viewport, expected: number[]) {
  const targets = createDocumentSelectionTargets(contentValue, viewportValue);
  expect(targets).toHaveLength(1);
  const { x, y, width, height } = targets[0]!.region;
  [x, y, width, height].forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 10));
  expect(targets[0]!.text).toBe("Heading");
}

describe("document text selection geometry", () => {
  it("places a 20-unit font box 16 units above its baseline, with the recorded text advance", () => {
    // PDF baseline (50,100), ascent16/descent4, advance60 on a200-square page.
    expectRegion(content(), viewport(), [0.25, 0.42, 0.3, 0.1]);
  });

  it.each([
    { rotation: 90, transform: [0, 1, 1, 0, 0, 0], region: [0.48, 0.25, 0.1, 0.3] },
    { rotation: 180, transform: [-1, 0, 0, 1, 200, 0], region: [0.45, 0.48, 0.3, 0.1] },
    { rotation: 270, transform: [0, -1, -1, 0, 200, 200], region: [0.42, 0.45, 0.1, 0.3] },
  ])("rotates the baseline box with a $rotation-degree page", ({ rotation, transform, region }) => {
    expectRegion(content(), viewport({ rotation, transform }), region);
  });

  it("normalizes a quarter-turn against the swapped dimensions of a rectangular page", () => {
    // A200x300 PDF page becomes300x200; the visible box is(96,50)–(116,110).
    expectRegion(
      content(),
      viewport({
        viewBox: [0, 0, 200, 300],
        rotation: 90,
        width: 300,
        height: 200,
        transform: [0, 1, 1, 0, 0, 0],
      }),
      [0.32, 0.25, 1 / 15, 0.3],
    );
  });

  it("uses the viewport's negative crop origin and userUnit exactly once", () => {
    expectRegion(
      content([item({ transform: [20, 0, 0, 20, -50, 50] })]),
      viewport({
        viewBox: [-100, -50, 100, 150],
        scale: 1.5,
        userUnit: 2,
        width: 600,
        height: 600,
        transform: [3, 0, 0, -3, 300, 450],
      }),
      [0.25, 0.42, 0.3, 0.1],
    );
  });

  it("honors rotated text and vertical-writing advance", () => {
    expectRegion(
      content([item({ transform: [0, 20, -20, 0, 100, 50] })]),
      viewport(),
      [0.42, 0.45, 0.1, 0.3],
    );
    expectRegion(
      content([item({ height: 80 })], { vertical: true }),
      viewport(),
      [0.23, 0.5, 0.1, 0.4],
    );
  });

  it("uses descent metrics when ascent is absent, otherwise the documented 0.8 fallback", () => {
    expectRegion(
      content(undefined, { ascent: 0, descent: -0.3 }),
      viewport(),
      [0.25, 0.43, 0.3, 0.1],
    );
    expectRegion(content(undefined, { ascent: 0, descent: 0 }), viewport(), [0.25, 0.42, 0.3, 0.1]);
  });

  it("clips partially visible boxes and discards empty, outside or invalid entries", () => {
    const source = content([
      { type: "beginMarkedContent", id: "marker" },
      item({ str: "   " }),
      item({ transform: [20, 0, 0, 20, 250, 100] }),
      item({ width: 0 }),
      item({ width: Number.POSITIVE_INFINITY }),
      item({ height: Number.NaN }),
      item({ transform: [0, 0, 0, 0, 50, 100] }),
      item({ transform: [20, 0, 0, 20, Number.NaN, 100] }),
      item({ transform: [20, 0, 0, 20, -20, 100] }),
    ]);
    expectRegion(source, viewport(), [0, 0.42, 0.2, 0.1]);
    expect(createDocumentSelectionTargets(content(), viewport({ width: 0 }))).toEqual([]);
    expect(
      createDocumentSelectionTargets(
        content(),
        viewport({ transform: [1, 0, 0, -1, 0, Number.NaN] }),
      ),
    ).toEqual([]);
  });

  it("bounds targets and UTF16 text without splitting a surrogate pair", () => {
    const source = content(
      Array.from({ length: 2_050 }, () => item({ str: ` ${"x".repeat(1_023)}😀tail ` })),
    );
    const targets = createDocumentSelectionTargets(source, viewport());
    expect(targets).toHaveLength(2_048);
    expect(targets.every((target) => target.text === "x".repeat(1_023))).toBe(true);
  });

  it("stops scanning after 8192 marked-content items even when no target was emitted", () => {
    const markers = Array.from({ length: 8_192 }, () => ({
      type: "beginMarkedContent",
      id: "marker",
    }));
    expect(createDocumentSelectionTargets(content([...markers, item()]), viewport())).toEqual([]);
  });
});
