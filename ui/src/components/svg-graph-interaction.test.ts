/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  endSvgGraphPointer,
  getSvgGraphInteraction,
  moveSvgGraphPointer,
  resetSvgGraph,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
  zoomSvgGraph,
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

describe("SVG graph interaction", () => {
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

    zoomSvgGraph(svg, interaction, 100);
    expect(interaction.scale).toBe(3);
    zoomSvgGraph(svg, interaction, 0.001);
    expect(interaction.scale).toBe(0.4);

    startSvgGraphPointer(pointer(node, { clientX: 10, clientY: 20 }), interaction, "one");
    moveSvgGraphPointer(pointer(svg, { clientX: 30, clientY: 40 }), interaction);
    endSvgGraphPointer(pointer(svg, { clientX: 30, clientY: 40 }), interaction);
    expect(interaction.positions.get("one")).toEqual({ x: 60, y: 70 });
    expect(shouldActivateSvgGraphNode(interaction, "one")).toBe(false);
    expect(shouldActivateSvgGraphNode(interaction, "one")).toBe(true);

    resetSvgGraph(svg, interaction);
    expect(interaction.positions.get("one")).toEqual({ x: 10, y: 20 });
    expect(interaction.scale).toBe(1);
  });
});
