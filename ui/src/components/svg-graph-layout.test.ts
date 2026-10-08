import { describe, expect, it } from "vitest";
import { createSvgGraphLayout } from "./svg-graph-layout.ts";

type Layout = ReturnType<typeof createSvgGraphLayout>;

function coordinates(layout: Layout) {
  return new Map([...layout.positions].map(([id, point]) => [id, { x: point.x, y: point.y }]));
}

function expectFinite(layout: Layout) {
  for (const point of layout.positions.values()) {
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  }
}

describe("SVG graph layout", () => {
  it("deterministically spreads connected documents across two dimensions", () => {
    const nodes = ["hub", "north", "south", "east", "west", "other"].map((id) => ({ id }));
    const edges = nodes.slice(1).map((node) => ({ source: "hub", target: node.id }));
    const layout = createSvgGraphLayout(nodes, edges, 960, 600);
    const reversed = createSvgGraphLayout(nodes.toReversed(), edges, 960, 600);
    expect(coordinates(layout)).toEqual(coordinates(reversed));
    const points = [...layout.positions.values()];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(48);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(48);
    const origin = points[0]!;
    const areas = points.flatMap((left) =>
      points.map((right) =>
        Math.abs(
          (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x),
        ),
      ),
    );
    expect(Math.max(...areas)).toBeGreaterThan(48 * 48);
    expectFinite(layout);
  });

  it("keeps a dragged node pinned while its linked neighbor follows naturally", () => {
    const nodes = ["anchor", "neighbor", "isolate"].map((id) => ({ id }));
    const edges = [{ source: "anchor", target: "neighbor" }];
    const layout = createSvgGraphLayout(nodes, edges, 960, 600);
    const control = createSvgGraphLayout(nodes, edges, 960, 600);
    const anchor = coordinates(layout).get("anchor")!;
    const movement = { x: 220, y: -140 };
    const destination = { x: anchor.x + movement.x, y: anchor.y + movement.y };
    layout.pin("anchor", destination);
    control.pin("anchor", anchor);
    for (let index = 0; index < 12; index += 1) {
      layout.tick();
      control.tick();
    }
    expect(coordinates(layout).get("anchor")).toEqual(destination);
    const response = (id: string) => {
      const moved = layout.positions.get(id)!;
      const stationary = control.positions.get(id)!;
      return { x: moved.x - stationary.x, y: moved.y - stationary.y };
    };
    const neighbor = response("neighbor");
    const isolate = response("isolate");
    expect(neighbor.x * movement.x + neighbor.y * movement.y).toBeGreaterThan(0);
    expect(Math.hypot(neighbor.x, neighbor.y)).toBeGreaterThan(Math.hypot(isolate.x, isolate.y));
    expectFinite(layout);
    layout.release();
    for (let index = 0; index < 12; index += 1) {
      layout.tick();
    }
    expect(coordinates(layout).get("anchor")).not.toEqual(destination);
    expectFinite(layout);
  });

  it("preserves API nodes and directed links while deriving reciprocal springs", () => {
    const nodes = Object.freeze([
      Object.freeze({ id: "a", title: "Alpha" }),
      Object.freeze({ id: "b", title: "Beta" }),
    ]);
    const edges = Object.freeze([
      Object.freeze({ source: "a", target: "b", type: "reference" }),
      Object.freeze({ source: "b", target: "a", type: "related" }),
      Object.freeze({ source: "a", target: "a", type: "reference" }),
    ]);
    const before = structuredClone({ nodes, edges });
    const layout = createSvgGraphLayout(nodes, edges, 960, 600);
    const singleSpring = createSvgGraphLayout(nodes, edges.slice(0, 1), 960, 600);
    expect(coordinates(layout)).toEqual(coordinates(singleSpring));
    layout.pin("a", { x: 700, y: 200 });
    layout.tick();
    layout.release();
    layout.reset();
    expect({ nodes, edges }).toEqual(before);
  });

  it("deeply restores initial coordinates after mutable drag, release and repeated resets", () => {
    const layout = createSvgGraphLayout(
      [{ id: "a" }, { id: "b" }],
      [{ source: "a", target: "b" }],
      960,
      600,
    );
    const initial = coordinates(layout);
    layout.pin("a", { x: 800, y: 100 });
    for (let index = 0; index < 8; index += 1) {
      layout.tick();
    }
    layout.release();
    layout.reset();
    expect(coordinates(layout)).toEqual(initial);
    const livePoint = layout.positions.get("a")!;
    livePoint.x += 500;
    livePoint.y -= 300;
    layout.reset();
    expect(coordinates(layout)).toEqual(initial);
    layout.pin("a", { x: 800, y: 100 });
    layout.reset();
    expect(coordinates(layout)).toEqual(initial);
  });

  it("handles empty and isolated snapshots without inventing links", () => {
    const empty = createSvgGraphLayout([], [], 960, 600);
    expect(empty.positions.size).toBe(0);
    empty.release();
    empty.reset();
    expect(empty.tick()).toBe(false);
    const isolated = createSvgGraphLayout([{ id: "alone" }], [], 960, 600);
    expect(coordinates(isolated).get("alone")).toEqual({ x: 480, y: 300 });
    isolated.pin("alone", { x: 700, y: 100 });
    isolated.tick();
    isolated.release();
    isolated.tick();
    expectFinite(isolated);
    isolated.reset();
    expect(coordinates(isolated).get("alone")).toEqual({ x: 480, y: 300 });
  });

  it("keeps the bounded 500-document, 2000-link snapshot finite during drag and cooldown", () => {
    const nodes = Array.from({ length: 500 }, (_, index) => ({ id: `page-${index}` }));
    const edges = nodes.flatMap((node, index) =>
      [1, 7, 23, 61].map((offset) => ({
        source: node.id,
        target: nodes[(index + offset) % nodes.length]!.id,
      })),
    );
    const layout = createSvgGraphLayout(nodes, edges, 960, 600);
    expect(layout.positions.size).toBe(500);
    expect(edges).toHaveLength(2000);
    expectFinite(layout);
    layout.pin(nodes[0]!.id, { x: 700, y: 180 });
    for (let index = 0; index < 8; index += 1) {
      layout.tick();
    }
    layout.release();
    let running = true;
    for (let index = 0; index < 128 && running; index += 1) {
      running = layout.tick();
    }
    expect(running).toBe(false);
    expectFinite(layout);
  });
});
