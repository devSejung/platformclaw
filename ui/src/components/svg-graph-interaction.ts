import { html } from "lit";

type SvgGraphPoint = { x: number; y: number };

type DragState = {
  pointerId: number;
  startClient: SvgGraphPoint;
  startGraph: SvgGraphPoint;
  nodeId: string | null;
  moved: boolean;
};

type SvgGraphInteraction = {
  scale: number;
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
      edge.setAttribute("x1", String(source.x));
      edge.setAttribute("y1", String(source.y));
      edge.setAttribute("x2", String(target.x));
      edge.setAttribute("y2", String(target.y));
    }
  }
}

function zoomSvgGraph(
  svg: SVGSVGElement,
  interaction: SvgGraphInteraction,
  factor: number,
  client?: SvgGraphPoint,
) {
  const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, interaction.scale * factor));
  if (nextScale === interaction.scale) {
    return;
  }
  const anchor = client ? graphPoint(svg, client.x, client.y) : { x: 480, y: 300 };
  const graphX = (anchor.x - interaction.x) / interaction.scale;
  const graphY = (anchor.y - interaction.y) / interaction.scale;
  interaction.x = anchor.x - graphX * nextScale;
  interaction.y = anchor.y - graphY * nextScale;
  interaction.scale = nextScale;
  updateSvg(svg, interaction);
}

function resetSvgGraph(svg: SVGSVGElement, interaction: SvgGraphInteraction) {
  interaction.scale = 1;
  interaction.x = 0;
  interaction.y = 0;
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
  if (drag.nodeId) {
    interaction.positions.set(drag.nodeId, {
      x: drag.startGraph.x + dx / interaction.scale,
      y: drag.startGraph.y + dy / interaction.scale,
    });
  } else {
    interaction.x = drag.startGraph.x + dx;
    interaction.y = drag.startGraph.y + dy;
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
