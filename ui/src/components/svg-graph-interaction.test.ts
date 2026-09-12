/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  endSvgGraphPointer,
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
