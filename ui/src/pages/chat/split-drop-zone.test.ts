import { describe, expect, it } from "vitest";
import { resolveSplitDropIndicator, resolveSplitDropZone } from "./split-drop-zone.ts";

const rect = { left: 100, top: 200, width: 400, height: 200 };

describe("split drop zones", () => {
  it.each([
    [110, 300, { kind: "edge", edge: "left" }],
    [490, 300, { kind: "edge", edge: "right" }],
    [300, 210, { kind: "edge", edge: "up" }],
    [300, 390, { kind: "edge", edge: "down" }],
    [300, 300, { kind: "center" }],
  ] as const)("resolves the zone at %d, %d", (x, y, expected) => {
    expect(resolveSplitDropZone(rect, x, y)).toEqual(expected);
  });

  it("chooses the nearer edge when both axes qualify", () => {
    expect(resolveSplitDropZone(rect, 120, 240)).toEqual({ kind: "edge", edge: "left" });
    expect(resolveSplitDropZone(rect, 140, 210)).toEqual({ kind: "edge", edge: "up" });
    expect(resolveSplitDropZone(rect, 460, 390)).toEqual({ kind: "edge", edge: "down" });
    expect(resolveSplitDropZone(rect, 490, 370)).toEqual({ kind: "edge", edge: "right" });
  });

  it.each([
    [110, 300, { left: 100, top: 200, width: 200, height: 200 }],
    [490, 300, { left: 300, top: 200, width: 200, height: 200 }],
    [300, 210, { left: 100, top: 200, width: 400, height: 100 }],
    [300, 390, { left: 100, top: 300, width: 400, height: 100 }],
    [300, 300, rect],
  ] as const)("positions the pane indicator at %d, %d", (x, y, expected) => {
    const container = { left: 0, top: 0, width: 800, height: 600 };
    expect(resolveSplitDropIndicator("pane-1", rect, container, x, y).rect).toEqual(expected);
  });

  it("copies non-enumerable DOMRect fields and translates to the drop container", () => {
    const domRect = Object.create(rect) as typeof rect;
    const container = { left: 10, top: 20, width: 800, height: 600 };
    expect(resolveSplitDropIndicator("pane-1", domRect, container, 300, 300)).toEqual({
      paneId: "pane-1",
      zone: { kind: "center" },
      rect: { left: 90, top: 180, width: 400, height: 200 },
    });
    expect(resolveSplitDropIndicator("pane-1", domRect, container, 300, 390).rect).toEqual({
      left: 90,
      top: 280,
      width: 400,
      height: 100,
    });
  });
});
