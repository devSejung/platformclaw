/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  endSvgGraphPointer,
  fitSvgGraphView,
  focusSvgGraphNode,
  getSvgGraphInteraction,
  handleSvgGraphWheel,
  moveSvgGraphPointer,
  renderSvgGraphControls,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
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

describe("SVG graph interaction", () => {
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
      const interaction = getSvgGraphInteraction({}, new Map([["one", { x: 20, y: 30 }]]));
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

  it("fits visible bounds without losing dragged positions and focuses a document", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const viewport = document.createElementNS("http://www.w3.org/2000/svg", "g");
    viewport.dataset.svgGraphViewport = "";
    Object.assign(viewport, { getBBox: () => ({ x: -100, y: -100, width: 4000, height: 2000 }) });
    Object.defineProperty(svg, "viewBox", {
      value: { baseVal: { x: 0, y: 0, width: 960, height: 600 } },
    });
    Object.assign(svg, { getScreenCTM: () => null });
    svg.append(viewport);
    const interaction = getSvgGraphInteraction({}, new Map([["one", { x: 20, y: 30 }]]));
    interaction.positions.set("one", { x: 1600, y: 850 });
    fitSvgGraphView(svg, interaction);
    expect(interaction.scale).toBeCloseTo(896 / 4000);
    expect(interaction.positions.get("one")).toEqual({ x: 1600, y: 850 });
    expect(interaction.x + 1900 * interaction.scale).toBeCloseTo(480);
    const fittedScale = interaction.scale;
    handleSvgGraphWheel(wheel(svg, -1), interaction);
    expect(interaction.scale).toBeCloseTo(fittedScale * 1.15);
    focusSvgGraphNode(svg, interaction, "one");
    expect(interaction.x + 1600 * interaction.scale).toBeCloseTo(480);
    expect(interaction.y + 850 * interaction.scale).toBeCloseTo(300);
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
    const interaction = getSvgGraphInteraction(
      {},
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
    const interaction = getSvgGraphInteraction({}, new Map([["one", { x: 10, y: 20 }]]));

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
