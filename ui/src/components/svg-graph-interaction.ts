import { html, noChange } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { placeSvgGraphLabels } from "./svg-graph-labels.ts";
import { createSvgGraphLayout } from "./svg-graph-layout.ts";
import "./svg-graph.css";

type SvgGraphPoint = { x: number; y: number };

export function svgGraphEdgeCoordinates(source: SvgGraphPoint, target: SvgGraphPoint, offset = 0) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  const x = (-dy / length) * offset;
  const y = (dx / length) * offset;
  return { x1: source.x + x, y1: source.y + y, x2: target.x + x, y2: target.y + y };
}

type DragState = {
  pointerId: number;
  startClient: SvgGraphPoint;
  startGraph: SvgGraphPoint;
  startPointer: SvgGraphPoint;
  nodeId: string | null;
  moved: boolean;
};

type SvgGraphInteraction = {
  scale: number;
  minimumScale: number;
  initialView: { scale: number; x: number; y: number };
  x: number;
  y: number;
  positions: Map<string, SvgGraphPoint>;
  initialPositions: Map<string, SvgGraphPoint>;
  drag: DragState | null;
  suppressedNode: string | null;
  layout?: ReturnType<typeof createSvgGraphLayout>;
  frame?: number;
  canvas?: SVGSVGElement;
  hoveredNode?: string | null;
  focusedNode?: string | null;
};

const states = new WeakMap<object, SvgGraphInteraction>();
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
const DRAG_THRESHOLD = 4;

function getSvgGraphInteraction(
  key: object,
  positions: ReadonlyMap<string, SvgGraphPoint>,
): SvgGraphInteraction {
  let interaction = states.get(key);
  if (!interaction) {
    interaction = {
      scale: 1,
      minimumScale: MIN_SCALE,
      initialView: { scale: 1, x: 0, y: 0 },
      x: 0,
      y: 0,
      positions: new Map([...positions].map(([id, point]) => [id, { ...point }])),
      initialPositions: new Map([...positions].map(([id, point]) => [id, { ...point }])),
      drag: null,
      suppressedNode: null,
    };
    states.set(key, interaction);
  }
  for (const [id, point] of positions) {
    if (!interaction.positions.has(id)) {
      interaction.positions.set(id, { ...point });
      interaction.initialPositions.set(id, { ...point });
    }
  }
  return interaction;
}

const forceStates = new WeakMap<object, { signature: string; interaction: SvgGraphInteraction }>();

export function getSvgForceGraphInteraction(
  key: object,
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>,
  width: number,
  height: number,
) {
  const signature = JSON.stringify([width, height, nodes.map((node) => node.id), edges]);
  const previous = forceStates.get(key);
  if (previous?.signature === signature) {
    return previous.interaction;
  }
  if (previous) {
    stopSvgGraphAnimation(previous.interaction);
  }
  const layout = createSvgGraphLayout(nodes, edges, width, height);
  const interaction = getSvgGraphInteraction({}, layout.positions);
  interaction.layout = layout;
  interaction.positions = layout.positions;
  const points = [...layout.positions.values()];
  const minX = Math.min(width / 2, ...points.map((point) => point.x)) - 130;
  const maxX = Math.max(width / 2, ...points.map((point) => point.x)) + 130;
  const minY = Math.min(height / 2, ...points.map((point) => point.y)) - 80;
  const maxY = Math.max(height / 2, ...points.map((point) => point.y)) + 80;
  interaction.scale = Math.min(1, (width - 48) / (maxX - minX), (height - 48) / (maxY - minY));
  interaction.minimumScale = Math.min(MIN_SCALE, interaction.scale);
  interaction.x = width / 2 - ((minX + maxX) / 2) * interaction.scale;
  interaction.y = height / 2 - ((minY + maxY) / 2) * interaction.scale;
  interaction.initialView = { scale: interaction.scale, x: interaction.x, y: interaction.y };
  forceStates.set(key, { signature, interaction });
  return interaction;
}

function stopSvgGraphAnimation(interaction: SvgGraphInteraction) {
  if (interaction.frame !== undefined) {
    cancelAnimationFrame(interaction.frame);
    interaction.frame = undefined;
  }
  interaction.layout?.release();
  const pointerId = interaction.drag?.pointerId;
  interaction.drag = null;
  interaction.suppressedNode = null;
  if (pointerId !== undefined && interaction.canvas?.hasPointerCapture?.(pointerId)) {
    interaction.canvas.releasePointerCapture(pointerId);
  }
  interaction.canvas?.classList.remove("svg-graph-canvas--dragging");
}

function animateSvgGraph(svg: SVGSVGElement, interaction: SvgGraphInteraction) {
  if (!interaction.layout || interaction.frame !== undefined) {
    return;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    for (let index = 0; index < 8; index += 1) {
      interaction.layout.tick();
    }
    updateSvg(svg, interaction);
    return;
  }
  const step = () => {
    interaction.frame = undefined;
    if (!svg.isConnected || document.hidden || !svg.getClientRects().length) {
      stopSvgGraphAnimation(interaction);
      return;
    }
    const running = interaction.layout!.tick();
    updateSvg(svg, interaction);
    if (running) {
      interaction.frame = requestAnimationFrame(step);
    }
  };
  interaction.frame = requestAnimationFrame(step);
}

// Lit owns the canvas lifetime: changing filters/snapshots or removing a tab
// cancels its animation and releases pins, including detached/reconnected hosts.
class SvgGraphCanvasDirective extends AsyncDirective {
  private interaction?: SvgGraphInteraction;
  private svg?: SVGSVGElement;
  private refresh = (event: Event) => {
    if (this.svg && this.interaction) {
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      const target = event.type.endsWith("out") ? related : event.target;
      const node =
        target instanceof Element ? target.closest<SVGGElement>("[data-svg-graph-node]") : null;
      const id = node && this.svg.contains(node) ? (node.dataset.svgGraphNode ?? null) : null;
      if (event.type.startsWith("pointer")) {
        this.interaction.hoveredNode = id;
      } else {
        this.interaction.focusedNode = id;
      }
      updateSvg(this.svg, this.interaction);
    }
  };

  override render(_interaction: SvgGraphInteraction) {
    return noChange;
  }

  override update(part: ElementPart, [interaction]: [SvgGraphInteraction]) {
    if (this.interaction && this.interaction !== interaction) {
      this.disconnected();
    }
    this.interaction = interaction;
    this.svg = part.element as SVGSVGElement;
    this.svg.classList.add("svg-graph-canvas");
    interaction.canvas = this.svg;
    for (const type of ["pointerover", "pointerout", "focusin", "focusout"]) {
      this.svg.addEventListener(type, this.refresh);
    }
    queueMicrotask(() => {
      if (this.isConnected && this.interaction === interaction) {
        updateSvg(this.svg!, interaction);
      }
    });
    return noChange;
  }

  protected override disconnected() {
    if (this.interaction) {
      stopSvgGraphAnimation(this.interaction);
      this.interaction.canvas = undefined;
      this.interaction.hoveredNode = this.interaction.focusedNode = null;
    }
    this.svg?.classList.remove("svg-graph-canvas--dragging");
    for (const type of ["pointerover", "pointerout", "focusin", "focusout"]) {
      this.svg?.removeEventListener(type, this.refresh);
    }
  }

  protected override reconnected() {
    if (this.svg && this.interaction) {
      this.interaction.canvas = this.svg;
      for (const type of ["pointerover", "pointerout", "focusin", "focusout"]) {
        this.svg.addEventListener(type, this.refresh);
      }
      updateSvg(this.svg, this.interaction);
    }
  }
}

export const svgGraphCanvas = directive(SvgGraphCanvasDirective);

export function svgGraphTransform(interaction: SvgGraphInteraction): string {
  return `translate(${interaction.x} ${interaction.y}) scale(${interaction.scale})`;
}

function graphPoint(svg: SVGSVGElement, clientX: number, clientY: number): SvgGraphPoint {
  const matrix = svg.getScreenCTM?.();
  if (matrix && typeof DOMPoint !== "undefined") {
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }
  return { x: clientX, y: clientY };
}

function updateSvg(svg: SVGSVGElement, interaction: SvgGraphInteraction) {
  const viewport = svg.querySelector<SVGGElement>("[data-svg-graph-viewport]");
  viewport?.setAttribute("transform", svgGraphTransform(interaction));
  const nodes = [...svg.querySelectorAll<SVGGElement>("[data-svg-graph-node]")];
  const edges = [...svg.querySelectorAll<SVGLineElement>("[data-svg-graph-source]")];
  const active =
    interaction.drag?.nodeId ||
    interaction.hoveredNode ||
    interaction.focusedNode ||
    nodes.find((node) => node.getAttribute("aria-pressed") === "true")?.dataset.svgGraphNode;
  const neighbors = new Set<string>();
  for (const edge of edges) {
    const source = edge.dataset.svgGraphSource!;
    const target = edge.dataset.svgGraphTarget!;
    const connected = source === active || target === active;
    const state = active ? (connected ? "active" : "muted") : "idle";
    if (edge.dataset.svgGraphState !== state) {
      edge.dataset.svgGraphState = state;
    }
    if (connected) {
      neighbors.add(source);
      neighbors.add(target);
    }
  }
  for (const node of nodes) {
    const id = node.dataset.svgGraphNode;
    const state = active
      ? id === active
        ? "active"
        : neighbors.has(id!)
          ? "neighbor"
          : "muted"
      : "idle";
    if (node.dataset.svgGraphState !== state) {
      node.dataset.svgGraphState = state;
    }
    const point = id ? interaction.positions.get(id) : null;
    if (point) {
      node.setAttribute("transform", `translate(${point.x} ${point.y})`);
      const pinned = String(interaction.drag?.moved && interaction.drag.nodeId === id);
      if (node.dataset.svgGraphPinned !== pinned) {
        node.dataset.svgGraphPinned = pinned;
      }
    }
  }
  for (const edge of edges) {
    const source = interaction.positions.get(edge.dataset.svgGraphSource ?? "");
    const target = interaction.positions.get(edge.dataset.svgGraphTarget ?? "");
    if (source && target) {
      // Typed parallel edges must retain their lane when endpoints move.
      const coordinates = svgGraphEdgeCoordinates(
        source,
        target,
        Number(edge.dataset.svgGraphOffset ?? 0),
      );
      for (const [name, value] of Object.entries(coordinates)) {
        edge.setAttribute(name, String(value));
      }
    }
  }
  if (interaction.layout) {
    placeSvgGraphLabels(svg, interaction.scale, interaction.x, interaction.y);
  }
}

function zoomSvgGraph(
  svg: SVGSVGElement,
  interaction: SvgGraphInteraction,
  factor: number,
  client?: SvgGraphPoint,
) {
  const nextScale = Math.min(
    MAX_SCALE,
    Math.max(interaction.minimumScale, interaction.scale * factor),
  );
  if (nextScale === interaction.scale) {
    return;
  }
  const box = svg.viewBox?.baseVal;
  const anchor = client
    ? graphPoint(svg, client.x, client.y)
    : { x: (box?.x ?? 0) + (box?.width || 960) / 2, y: (box?.y ?? 0) + (box?.height || 600) / 2 };
  const graphX = (anchor.x - interaction.x) / interaction.scale;
  const graphY = (anchor.y - interaction.y) / interaction.scale;
  interaction.x = anchor.x - graphX * nextScale;
  interaction.y = anchor.y - graphY * nextScale;
  interaction.scale = nextScale;
  updateSvg(svg, interaction);
}

function resetSvgGraph(svg: SVGSVGElement, interaction: SvgGraphInteraction) {
  stopSvgGraphAnimation(interaction);
  interaction.scale = interaction.initialView.scale;
  interaction.minimumScale = Math.min(MIN_SCALE, interaction.scale);
  interaction.x = interaction.initialView.x;
  interaction.y = interaction.initialView.y;
  if (interaction.layout) {
    interaction.layout.reset();
  } else {
    interaction.positions = new Map(
      [...interaction.initialPositions].map(([id, point]) => [id, { ...point }]),
    );
  }
  interaction.drag = null;
  interaction.suppressedNode = null;
  updateSvg(svg, interaction);
}

export function handleSvgGraphWheel(event: WheelEvent, interaction: SvgGraphInteraction) {
  event.preventDefault();
  zoomSvgGraph(
    event.currentTarget as SVGSVGElement,
    interaction,
    event.deltaY < 0 ? 1.15 : 1 / 1.15,
    {
      x: event.clientX,
      y: event.clientY,
    },
  );
}

export function startSvgGraphPointer(
  event: PointerEvent,
  interaction: SvgGraphInteraction,
  nodeId: string | null,
) {
  if (event.button !== 0 || !event.isPrimary || interaction.drag) {
    return;
  }
  if (!nodeId) {
    event.preventDefault();
  }
  event.stopPropagation();
  const svg = (event.currentTarget as SVGElement).closest("svg") as SVGSVGElement | null;
  if (!svg) {
    return;
  }
  const start = graphPoint(svg, event.clientX, event.clientY);
  interaction.drag = {
    pointerId: event.pointerId,
    startClient: { x: event.clientX, y: event.clientY },
    startPointer: start,
    startGraph: nodeId
      ? {
          x: (interaction.positions.get(nodeId) ?? start).x,
          y: (interaction.positions.get(nodeId) ?? start).y,
        }
      : { x: interaction.x, y: interaction.y },
    nodeId,
    moved: false,
  };
  svg.setPointerCapture?.(event.pointerId);
  svg.classList.add("svg-graph-canvas--dragging");
}

export function moveSvgGraphPointer(event: PointerEvent, interaction: SvgGraphInteraction) {
  const drag = interaction.drag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  const dx = event.clientX - drag.startClient.x;
  const dy = event.clientY - drag.startClient.y;
  drag.moved ||= Math.hypot(dx, dy) >= DRAG_THRESHOLD;
  if (!drag.moved) {
    return;
  }
  // Responsive SVGs scale client pixels independently from graph zoom. Use
  // the same coordinate space as pointerdown so a node stays under the finger.
  const point = graphPoint(event.currentTarget as SVGSVGElement, event.clientX, event.clientY);
  const graphDx = point.x - drag.startPointer.x;
  const graphDy = point.y - drag.startPointer.y;
  if (drag.nodeId) {
    const position = {
      x: drag.startGraph.x + graphDx / interaction.scale,
      y: drag.startGraph.y + graphDy / interaction.scale,
    };
    if (interaction.layout) {
      interaction.layout.pin(drag.nodeId, position);
      animateSvgGraph(event.currentTarget as SVGSVGElement, interaction);
    } else {
      interaction.positions.set(drag.nodeId, position);
    }
  } else {
    interaction.x = drag.startGraph.x + graphDx;
    interaction.y = drag.startGraph.y + graphDy;
  }
  updateSvg(event.currentTarget as SVGSVGElement, interaction);
}

export function endSvgGraphPointer(
  event: PointerEvent,
  interaction: SvgGraphInteraction,
  activate = true,
): string | null {
  const drag = interaction.drag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return null;
  }
  if (drag.nodeId) {
    interaction.suppressedNode = drag.nodeId;
  }
  interaction.drag = null;
  interaction.layout?.release();
  const svg = event.currentTarget as SVGSVGElement;
  if (drag.nodeId && drag.moved && activate) {
    animateSvgGraph(svg, interaction);
  } else if (!activate) {
    stopSvgGraphAnimation(interaction);
  }
  if (svg.hasPointerCapture?.(event.pointerId)) {
    svg.releasePointerCapture(event.pointerId);
  }
  svg.classList.remove("svg-graph-canvas--dragging");
  return activate && drag.nodeId && !drag.moved ? drag.nodeId : null;
}

export function shouldActivateSvgGraphNode(
  interaction: SvgGraphInteraction,
  nodeId: string,
): boolean {
  if (interaction.suppressedNode !== nodeId) {
    return true;
  }
  interaction.suppressedNode = null;
  return false;
}

export function fitSvgGraphView(svg: SVGSVGElement, interaction: SvgGraphInteraction) {
  const bounds = svg.querySelector<SVGGElement>("[data-svg-graph-viewport]")?.getBBox?.();
  if (!bounds || !bounds.width || !bounds.height) {
    return;
  }
  const box = svg.viewBox?.baseVal ?? { x: 0, y: 0, width: 960, height: 600 };
  // Fit the visible snapshot, including labels, without undoing dragged nodes.
  interaction.scale = Math.min(
    MAX_SCALE,
    Math.max(1, box.width - 64) / bounds.width,
    Math.max(1, box.height - 64) / bounds.height,
  );
  // A fitted large graph may need a wider range than ordinary wheel zoom.
  interaction.minimumScale = Math.min(MIN_SCALE, interaction.scale);
  interaction.x = box.x + box.width / 2 - (bounds.x + bounds.width / 2) * interaction.scale;
  interaction.y = box.y + box.height / 2 - (bounds.y + bounds.height / 2) * interaction.scale;
  updateSvg(svg, interaction);
}

export function renderSvgGraphControls(params: {
  label: string;
  zoomIn: string;
  zoomOut: string;
  reset: string;
  svg: (source: HTMLElement) => SVGSVGElement | null;
  interaction: SvgGraphInteraction;
}) {
  const withSvg = (source: HTMLElement, action: (svg: SVGSVGElement) => void) => {
    const svg = params.svg(source);
    if (svg) {
      action(svg);
    }
  };
  return html`<div class="svg-graph-controls" role="group" aria-label=${params.label}>
    <button
      class="btn btn--subtle btn--sm"
      aria-label=${params.zoomIn}
      title=${params.zoomIn}
      @click=${(event: Event) =>
        withSvg(event.currentTarget as HTMLElement, (svg) =>
          zoomSvgGraph(svg, params.interaction, 1.2),
        )}
    >
      +
    </button>
    <button
      class="btn btn--subtle btn--sm"
      aria-label=${params.zoomOut}
      title=${params.zoomOut}
      @click=${(event: Event) =>
        withSvg(event.currentTarget as HTMLElement, (svg) =>
          zoomSvgGraph(svg, params.interaction, 1 / 1.2),
        )}
    >
      −
    </button>
    <button
      class="btn btn--subtle btn--sm"
      @click=${(event: Event) =>
        withSvg(event.currentTarget as HTMLElement, (svg) =>
          resetSvgGraph(svg, params.interaction),
        )}
    >
      ${params.reset}
    </button>
  </div>`;
}
