import { html } from "lit";

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
};

const states = new WeakMap<object, SvgGraphInteraction>();
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
const DRAG_THRESHOLD = 4;

export function getSvgGraphInteraction(
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
      positions: new Map(positions),
      initialPositions: new Map(positions),
      drag: null,
      suppressedNode: null,
    };
    states.set(key, interaction);
  }
  for (const [id, point] of positions) {
    if (!interaction.positions.has(id)) {
      interaction.positions.set(id, point);
      interaction.initialPositions.set(id, point);
    }
  }
  return interaction;
}

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
  for (const node of svg.querySelectorAll<SVGGElement>("[data-svg-graph-node]")) {
    const id = node.dataset.svgGraphNode;
    const point = id ? interaction.positions.get(id) : null;
    if (point) {
      node.setAttribute("transform", `translate(${point.x} ${point.y})`);
    }
  }
  for (const edge of svg.querySelectorAll<SVGLineElement>("[data-svg-graph-source]")) {
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
  interaction.scale = interaction.initialView.scale;
  interaction.minimumScale = Math.min(MIN_SCALE, interaction.scale);
  interaction.x = interaction.initialView.x;
  interaction.y = interaction.initialView.y;
  interaction.positions = new Map(interaction.initialPositions);
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
  if (event.button !== 0 || !event.isPrimary) {
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
  // Responsive SVGs scale client pixels independently from graph zoom. Use
  // the same coordinate space as pointerdown so a node stays under the finger.
  const point = graphPoint(event.currentTarget as SVGSVGElement, event.clientX, event.clientY);
  const graphDx = point.x - drag.startPointer.x;
  const graphDy = point.y - drag.startPointer.y;
  if (drag.nodeId) {
    interaction.positions.set(drag.nodeId, {
      x: drag.startGraph.x + graphDx / interaction.scale,
      y: drag.startGraph.y + graphDy / interaction.scale,
    });
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
  const svg = event.currentTarget as SVGSVGElement;
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

export function focusSvgGraphNode(
  svg: SVGSVGElement,
  interaction: SvgGraphInteraction,
  id: string,
) {
  const point = interaction.positions.get(id);
  if (!point) {
    return;
  }
  const box = svg.viewBox?.baseVal ?? { x: 0, y: 0, width: 960, height: 600 };
  const screenScale = Math.abs(svg.getScreenCTM?.()?.a ?? 1) || 1;
  interaction.scale = Math.min(MAX_SCALE, Math.max(1, 1.25 / screenScale));
  interaction.x = box.x + box.width / 2 - point.x * interaction.scale;
  interaction.y = box.y + box.height / 2 - point.y * interaction.scale;
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
