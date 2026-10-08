/* @vitest-environment jsdom */

import { html, nothing, render, svg as litSvg } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  endSvgGraphPointer,
  fitSvgGraphView,
  getSvgForceGraphInteraction,
  handleSvgGraphWheel,
  moveSvgGraphPointer,
  renderSvgGraphControls,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
  svgGraphCanvas,
} from "./svg-graph-interaction.ts";

function pointer(currentTarget: EventTarget, overrides: Partial<PointerEvent>) {
  return {
    button: 0,
    clientX: 0,
    clientY: 0,
    currentTarget,
    isPrimary: true,
    pointerId: 1,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  } as unknown as PointerEvent;
}

function wheel(currentTarget: EventTarget, deltaY: number) {
  return {
    clientX: 0,
    clientY: 0,
    currentTarget,
    deltaY,
    preventDefault() {},
  } as unknown as WheelEvent;
}

type ForceInteraction = ReturnType<typeof getSvgForceGraphInteraction>;

function geometryInteraction(positions: ReadonlyMap<string, { x: number; y: number }>) {
  const interaction = getSvgForceGraphInteraction({}, [], [], 960, 600);
  // Coordinate conversion and edge geometry tests use a stationary layout.
  interaction.layout = undefined;
  interaction.positions = new Map([...positions].map(([id, point]) => [id, { ...point }]));
  interaction.initialPositions = new Map([...positions].map(([id, point]) => [id, { ...point }]));
  return interaction;
}

function forceCoordinates(interaction: ForceInteraction) {
  return new Map([...interaction.positions].map(([id, point]) => [id, { x: point.x, y: point.y }]));
}

function installFrameScheduler() {
  let nextId = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    pending.set(++nextId, callback);
    return nextId;
  });
  const cancel = vi.fn((id: number) => pending.delete(id));
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  return {
    pending,
    request,
    cancel,
    advance() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    },
  };
}

function renderForceCanvas(container: HTMLElement, interaction: ForceInteraction) {
  render(
    html`<svg viewBox="0 0 960 600" ${svgGraphCanvas(interaction)}>
        <g data-svg-graph-viewport>
          ${interaction.positions.has("two")
            ? litSvg`<line data-svg-graph-source="one" data-svg-graph-target="two"></line>`
            : nothing}
          ${[...interaction.positions.keys()].map(
            (id) =>
              litSvg`<g data-svg-graph-node=${id} role="button" tabindex="0"><circle r="10"></circle><text>${id}</text></g>`,
          )}
        </g>
      </svg>
      ${renderSvgGraphControls({
        label: "Graph controls",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        reset: "Reset",
        svg: () => container.querySelector("svg"),
        interaction,
      })}`,
    container,
  );
}

function mountForceCanvas(interaction: ForceInteraction) {
  const container = document.createElement("div");
  document.body.append(container);
  renderForceCanvas(container, interaction);
  const canvas = container.querySelector<SVGSVGElement>("svg")!;
  const captures = new Set<number>();
  const releaseCapture = vi.fn((id: number) => captures.delete(id));
  Object.assign(canvas, {
    getClientRects: () => [new DOMRect(0, 0, 960, 600)],
    getScreenCTM: () => null,
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: releaseCapture,
  });
  return { container, canvas, captures, releaseCapture };
}

describe("SVG graph interaction", () => {
  it("starts neighbor animation only after a real drag and restores force coordinates through reset", async () => {
    const frames = installFrameScheduler();
    const interaction = getSvgForceGraphInteraction(
      {},
      ["one", "two", "three"].map((id) => ({ id })),
      [{ source: "one", target: "two" }],
      960,
      600,
    );
    const { container, canvas, captures } = mountForceCanvas(interaction);
    try {
      await Promise.resolve();
      const node = canvas.querySelector<SVGGElement>('[data-svg-graph-node="one"]')!;
      const neighbor = canvas.querySelector<SVGGElement>('[data-svg-graph-node="two"]')!;
      const initial = forceCoordinates(interaction);
      const initialView = { scale: interaction.scale, x: interaction.x, y: interaction.y };
      const neighborTransform = neighbor.getAttribute("transform");
      startSvgGraphPointer(pointer(node, { clientX: 10, clientY: 10 }), interaction, "one");
      moveSvgGraphPointer(pointer(canvas, { clientX: 12, clientY: 11 }), interaction);
      expect(forceCoordinates(interaction)).toEqual(initial);
      expect(frames.request).not.toHaveBeenCalled();
      expect(endSvgGraphPointer(pointer(canvas, {}), interaction)).toBe("one");
      expect(shouldActivateSvgGraphNode(interaction, "one")).toBe(false);

      startSvgGraphPointer(pointer(node, { clientX: 10, clientY: 10 }), interaction, "one");
      moveSvgGraphPointer(pointer(canvas, { clientX: 230, clientY: -130 }), interaction);
      expect(frames.pending.size).toBe(1);
      const pinned = forceCoordinates(interaction).get("one")!;
      for (let index = 0; index < 12; index += 1) {
        frames.advance();
      }
      expect(forceCoordinates(interaction).get("one")).toEqual(pinned);
      expect(neighbor.getAttribute("transform")).not.toBe(neighborTransform);
      expect(Number(canvas.querySelector("line")!.getAttribute("x2"))).toBe(
        interaction.positions.get("two")!.x,
      );
      expect(endSvgGraphPointer(pointer(canvas, {}), interaction)).toBeNull();
      frames.advance();
      expect(forceCoordinates(interaction).get("one")).not.toEqual(pinned);
      for (let index = 0; index < 128 && frames.pending.size; index += 1) {
        frames.advance();
      }
      expect(frames.pending.size).toBe(0);
      expect(captures.size).toBe(0);

      startSvgGraphPointer(pointer(node, {}), interaction, "one");
      moveSvgGraphPointer(pointer(canvas, { clientX: 100, clientY: 60 }), interaction);
      const cancelled = forceCoordinates(interaction).get("one")!;
      expect(frames.pending.size).toBe(1);
      endSvgGraphPointer(pointer(canvas, {}), interaction, false);
      expect(frames.pending.size).toBe(0);
      expect(interaction.drag).toBeNull();
      expect(captures.size).toBe(0);
      interaction.layout!.tick();
      expect(forceCoordinates(interaction).get("one")).not.toEqual(cancelled);

      handleSvgGraphWheel(wheel(canvas, -1), interaction);
      startSvgGraphPointer(pointer(canvas, {}), interaction, null);
      moveSvgGraphPointer(pointer(canvas, { clientX: 50, clientY: 20 }), interaction);
      endSvgGraphPointer(pointer(canvas, {}), interaction);
      const reset = container.querySelectorAll<HTMLButtonElement>("button")[2]!;
      reset.click();
      expect(forceCoordinates(interaction)).toEqual(initial);
      expect({ scale: interaction.scale, x: interaction.x, y: interaction.y }).toEqual(initialView);
      interaction.positions.get("one")!.x += 500;
      reset.click();
      expect(forceCoordinates(interaction)).toEqual(initial);
      expect(frames.pending.size).toBe(0);
      expect(canvas.classList.contains("svg-graph-canvas--dragging")).toBe(false);
    } finally {
      render(nothing, container);
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("cancels frames and releases pins and capture when filters replace the layout or Lit removes the canvas", async () => {
    const frames = installFrameScheduler();
    const key = {};
    const original = getSvgForceGraphInteraction(
      key,
      [{ id: "one" }, { id: "two" }],
      [{ source: "one", target: "two" }],
      960,
      600,
    );
    const { container, canvas, captures, releaseCapture } = mountForceCanvas(original);
    try {
      await Promise.resolve();
      const node = canvas.querySelector<SVGGElement>('[data-svg-graph-node="one"]')!;
      startSvgGraphPointer(pointer(node, {}), original, "one");
      moveSvgGraphPointer(pointer(canvas, { clientX: 180, clientY: 60 }), original);
      const pinned = forceCoordinates(original).get("one")!;
      expect(frames.pending.size).toBe(1);
      expect(captures.has(1)).toBe(true);
      const filtered = getSvgForceGraphInteraction(key, [{ id: "one" }], [], 960, 600);
      expect(frames.pending.size).toBe(0);
      expect(captures.size).toBe(0);
      expect(original.drag).toBeNull();
      original.layout!.tick();
      expect(forceCoordinates(original).get("one")).not.toEqual(pinned);
      renderForceCanvas(container, filtered);
      await Promise.resolve();
      expect(original.canvas).toBeUndefined();
      expect(filtered.canvas).toBe(canvas);
      expect(canvas.querySelectorAll("[data-svg-graph-node]")).toHaveLength(1);

      startSvgGraphPointer(pointer(node, {}), filtered, "one");
      moveSvgGraphPointer(pointer(canvas, { clientX: 180, clientY: 60 }), filtered);
      const removed = forceCoordinates(filtered).get("one")!;
      expect(frames.pending.size).toBe(1);
      render(nothing, container);
      await Promise.resolve();
      expect(frames.pending.size).toBe(0);
      expect(captures.size).toBe(0);
      expect(releaseCapture).toHaveBeenCalledTimes(2);
      expect(filtered.drag).toBeNull();
      expect(filtered.canvas).toBeUndefined();
      expect(canvas.classList.contains("svg-graph-canvas--dragging")).toBe(false);
      filtered.layout!.tick();
      expect(forceCoordinates(filtered).get("one")).not.toEqual(removed);
    } finally {
      render(nothing, container);
      container.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("moves nodes and the view in SVG coordinates at a responsive display scale", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.append(node);
    Object.assign(svg, { getScreenCTM: () => ({ inverse: () => ({ a: 2, d: 2 }) }) });
    vi.stubGlobal(
      "DOMPoint",
      class {
        constructor(
          readonly x: number,
          readonly y: number,
        ) {}
        matrixTransform(matrix: { a: number; d: number }) {
          return { x: this.x * matrix.a, y: this.y * matrix.d };
        }
      },
    );
    try {
      const interaction = geometryInteraction(new Map([["one", { x: 20, y: 30 }]]));
      interaction.scale = 2;
      startSvgGraphPointer(pointer(node, { clientX: 10, clientY: 10 }), interaction, "one");
      moveSvgGraphPointer(pointer(svg, { clientX: 40, clientY: 30 }), interaction);
      expect(interaction.positions.get("one")).toEqual({ x: 50, y: 50 });
      endSvgGraphPointer(pointer(svg, {}), interaction);
      startSvgGraphPointer(pointer(svg, { clientX: 10, clientY: 10 }), interaction, null);
      moveSvgGraphPointer(pointer(svg, { clientX: 40, clientY: 30 }), interaction);
      expect({ x: interaction.x, y: interaction.y }).toEqual({ x: 60, y: 40 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fits visible bounds without losing dragged positions", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
    viewport.dataset.svgGraphViewport = "";
    Object.assign(viewport, { getBBox: () => ({ x: -100, y: -100, width: 4000, height: 2000 }) });
    Object.defineProperty(svg, "viewBox", {
      value: { baseVal: { x: 0, y: 0, width: 960, height: 600 } },
    });
    Object.assign(svg, { getScreenCTM: () => null });
    svg.append(viewport);
    const interaction = geometryInteraction(new Map([["one", { x: 20, y: 30 }]]));
    interaction.positions.set("one", { x: 1600, y: 850 });
    fitSvgGraphView(svg, interaction);
    expect(interaction.scale).toBeCloseTo(896 / 4000);
    expect(interaction.positions.get("one")).toEqual({ x: 1600, y: 850 });
    expect(interaction.x + 1900 * interaction.scale).toBeCloseTo(480);
    const fittedScale = interaction.scale;
    handleSvgGraphWheel(wheel(svg, -1), interaction);
    expect(interaction.scale).toBeCloseTo(fittedScale * 1.15);
  });

  it("preserves parallel edge lanes when dragging while zero-offset edges stay centered", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
    node.dataset.svgGraphNode = "one";
    svg.append(node);
    const edges = [-3, 0, 3].map((offset) => {
      const edge = document.createElementNS("http://www.w3.org/2000/svg", "line");
      Object.assign(edge.dataset, {
        svgGraphSource: "one",
        svgGraphTarget: "two",
        svgGraphOffset: String(offset),
      });
      svg.append(edge);
      return edge;
    });
    const interaction = geometryInteraction(
      new Map([
        ["one", { x: 10, y: 20 }],
        ["two", { x: 100, y: 20 }],
      ]),
    );
    startSvgGraphPointer(pointer(node, { clientX: 10, clientY: 20 }), interaction, "one");
    moveSvgGraphPointer(pointer(svg, { clientX: 30, clientY: 40 }), interaction);
    expect(edges[0]!.getAttribute("y1")).not.toBe(edges[2]!.getAttribute("y1"));
    expect(edges[1]!.getAttribute("x1")).toBe("30");
    expect(edges[1]!.getAttribute("y1")).toBe("40");
  });
  it("clamps zoom and drags a node without activating it", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
    viewport.dataset.svgGraphViewport = "";
    const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
    node.dataset.svgGraphNode = "one";
    viewport.append(node);
    svg.append(viewport);
    document.body.append(svg);
    const interaction = geometryInteraction(new Map([["one", { x: 10, y: 20 }]]));

    for (let index = 0; index < 20; index += 1) {
      handleSvgGraphWheel(wheel(svg, -1), interaction);
    }
    expect(interaction.scale).toBe(3);
    for (let index = 0; index < 40; index += 1) {
      handleSvgGraphWheel(wheel(svg, 1), interaction);
    }
    expect(interaction.scale).toBe(0.4);

    startSvgGraphPointer(pointer(node, { clientX: 10, clientY: 20 }), interaction, "one");
    moveSvgGraphPointer(pointer(svg, { clientX: 30, clientY: 40 }), interaction);
    endSvgGraphPointer(pointer(svg, { clientX: 30, clientY: 40 }), interaction);
    expect(interaction.positions.get("one")).toEqual({ x: 60, y: 70 });
    expect(shouldActivateSvgGraphNode(interaction, "one")).toBe(false);
    expect(shouldActivateSvgGraphNode(interaction, "one")).toBe(true);

    const controls = document.createElement("div");
    render(
      renderSvgGraphControls({
        label: "Graph controls",
        zoomIn: "Zoom in",
        zoomOut: "Zoom out",
        reset: "Reset",
        svg: () => svg,
        interaction,
      }),
      controls,
    );
    controls.querySelectorAll("button")[2]?.click();
    expect(interaction.positions.get("one")).toEqual({ x: 10, y: 20 });
    expect(interaction.scale).toBe(1);
  });
});
