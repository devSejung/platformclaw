import { html, nothing, svg } from "lit";
import type { OrganizationMemoryGraph } from "../../../packages/platformclaw-control-plane/src/contracts.js";
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
  svgGraphEdgeCoordinates,
  svgGraphTransform,
} from "../components/svg-graph-interaction.ts";
import { formatMs, formatRelativeTimestamp } from "../lib/format.ts";
import { platformClawT as t } from "./i18n.ts";

type GraphNode = OrganizationMemoryGraph["nodes"][number];
type GraphEdge = OrganizationMemoryGraph["edges"][number];

type OrganizationGraphViewState = {
  query: string;
  edgeTypes: ReadonlySet<GraphEdge["type"]>;
  selection: { nodeId: string } | { edge: GraphEdge } | null;
  neighborsOnly: boolean;
  labels: boolean;
  expanded: boolean;
};

export function createOrganizationGraphViewState(): OrganizationGraphViewState {
  return {
    query: "",
    edgeTypes: new Set(["reference", "promotion", "comparison"]),
    selection: null,
    neighborsOnly: false,
    labels: true,
    expanded: false,
  };
}

const WIDTH = 960;
const HEIGHT = 600;
const layouts = new WeakMap<OrganizationMemoryGraph, Map<string, { x: number; y: number }>>();
const relationLabels = {
  reference: "referenceLegend",
  promotion: "provenanceLegend",
  comparison: "comparisonLegend",
} as const;

function relationLabel(edge: GraphEdge) {
  return t(`platformClaw.memory.organization.${relationLabels[edge.type]}`);
}

function graphPositions(graph: OrganizationMemoryGraph) {
  let positions = layouts.get(graph);
  if (positions) {
    return positions;
  }
  // Stable, label-sized lanes keep long document titles apart. Nearby IDs stay
  // together within their scope; filtering does not scramble spatial memory.
  const nodes = graph.nodes.toSorted(
    (a, b) => a.scopeName.localeCompare(b.scopeName) || a.id.localeCompare(b.id),
  );
  const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length / (nodes.length > 8 ? 1.6 : 1))));
  const rows = Math.ceil(nodes.length / columns);
  positions = new Map(
    nodes.map((node, index) => {
      const row = Math.floor(index / columns);
      const column = row % 2 === 0 ? index % columns : columns - 1 - (index % columns);
      return [
        node.id,
        {
          x: WIDTH / 2 + (column - (columns - 1) / 2) * 240,
          y: HEIGHT / 2 - 16 + (row - (rows - 1) / 2) * 90,
        },
      ];
    }),
  );
  layouts.set(graph, positions);
  const interaction = getSvgGraphInteraction(graph, positions);
  interaction.scale = Math.min(
    1.5,
    (WIDTH - 80) / ((columns - 1) * 240 + 220),
    (HEIGHT - 80) / ((rows - 1) * 90 + 80),
  );
  interaction.minimumScale = Math.min(interaction.minimumScale, interaction.scale);
  interaction.x = (WIDTH / 2) * (1 - interaction.scale);
  interaction.y = (HEIGHT / 2) * (1 - interaction.scale);
  interaction.initialView = { scale: interaction.scale, x: interaction.x, y: interaction.y };
  return positions;
}

function titleLines(title: string): string[] {
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const character of title) {
    const advance = (character.codePointAt(0) ?? 0) > 255 ? 2 : 1;
    if (width + advance > 25) {
      const space = line.lastIndexOf(" ");
      const carry = lines.length === 0 && space > line.length / 2 ? line.slice(space + 1) : "";
      if (carry) {
        line = line.slice(0, space);
      }
      lines.push(line);
      if (lines.length === 2) {
        lines[1] = `${line.slice(0, -1)}…`;
        return lines;
      }
      line = carry;
      width = 0;
      for (const value of carry) {
        width += (value.codePointAt(0) ?? 0) > 255 ? 2 : 1;
      }
    }
    line += character;
    width += advance;
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

function renderEdgeDetails(edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>) {
  return html`<section class="organization-memory-graph__edge-detail" role="status">
    <strong
      >${nodes.get(edge.source)?.title} ${edge.type === "comparison" ? "↔" : "→"}
      ${nodes.get(edge.target)?.title}</strong
    >
    <p>${relationLabel(edge)}</p>
    ${edge.type === "comparison"
      ? html`<p>
            ${t("platformClaw.memory.knowledge.aiJudgment")} ·
            ${t(`platformClaw.memory.knowledge.kind.${edge.kind}`)}
          </p>
          <p>${edge.summary}</p>
          <p>${t(`platformClaw.memory.knowledge.proposal.${edge.reviewStatus}`)}</p>
          <p>${formatMs(edge.completedAt)} · ${formatRelativeTimestamp(edge.completedAt)}</p>`
      : edge.type === "reference"
        ? html`<p>
            ${nodes.get(edge.source)?.title} · r${edge.sourceRevision} →
            ${nodes.get(edge.target)?.title} · r${edge.targetRevision}
          </p>`
        : nothing}
  </section>`;
}

export function renderOrganizationGraph(params: {
  graph: OrganizationMemoryGraph;
  state: OrganizationGraphViewState;
  canRead: boolean;
  onChange: (state: OrganizationGraphViewState) => void;
  onOpen: (path: string) => void;
}) {
  const { graph, state } = params;
  const set = (patch: Partial<OrganizationGraphViewState>) =>
    params.onChange({ ...state, ...patch });
  const positions = graphPositions(graph);
  const interaction = getSvgGraphInteraction(graph, positions);
  const allNodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const selectedId = state.selection && "nodeId" in state.selection ? state.selection.nodeId : null;
  const selectedNode = selectedId ? allNodes.get(selectedId) : null;
  const selectedEdge = state.selection && "edge" in state.selection ? state.selection.edge : null;
  const query = state.query.trim().toLocaleLowerCase();
  const typedEdges = graph.edges.filter((edge) => state.edgeTypes.has(edge.type));
  const neighbors = new Set(
    typedEdges
      .filter((edge) => edge.source === selectedId || edge.target === selectedId)
      .flatMap((edge) => [edge.source, edge.target]),
  );
  const nodes = graph.nodes.filter(
    (node) =>
      (!query ||
        `${node.title} ${node.scopeName} ${node.path}`.toLocaleLowerCase().includes(query)) &&
      (!state.neighborsOnly || !selectedId || node.id === selectedId || neighbors.has(node.id)),
  );
  const ids = new Set(nodes.map((node) => node.id));
  const edges = typedEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const connections = edges.filter(
    (edge) => edge.source === selectedId || edge.target === selectedId,
  );
  const selectNode = (id: string) =>
    set({ selection: id ? { nodeId: id } : null, neighborsOnly: false });
  const findSvg = (source: HTMLElement) =>
    source
      .closest(".organization-memory-graph__explorer")
      ?.querySelector<SVGSVGElement>(".organization-memory-graph__canvas svg") ?? null;
  const graphAction = (event: Event, action: (canvas: SVGSVGElement) => void) => {
    const canvas = findSvg(event.currentTarget as HTMLElement);
    if (canvas) {
      action(canvas);
    }
  };
  const pairTypes = new Map<string, string[]>();
  const pairKey = (edge: GraphEdge) => JSON.stringify([edge.source, edge.target].toSorted());
  for (const edge of edges) {
    const key = pairKey(edge);
    const types = pairTypes.get(key) ?? [];
    if (!types.includes(edge.type)) {
      types.push(edge.type);
    }
    pairTypes.set(key, types.toSorted());
  }
  return html`<div class="organization-memory-graph__explorer">
    <div class="organization-memory-graph__toolbar">
      <label class="organization-memory-graph__search">
        <span>${t("platformClaw.memory.organization.graphSearch")}</span>
        <input
          type="search"
          class="settings-input"
          .value=${state.query}
          @input=${(event: Event) =>
            set({
              query: (event.currentTarget as HTMLInputElement).value,
              selection: null,
              neighborsOnly: false,
            })}
        />
      </label>
      <div class="organization-memory-graph__view-controls">
        ${renderSvgGraphControls({
          label: t("platformClaw.memory.organization.graphControls"),
          zoomIn: t("platformClaw.memory.organization.graphZoomIn"),
          zoomOut: t("platformClaw.memory.organization.graphZoomOut"),
          reset: t("platformClaw.memory.organization.graphResetView"),
          svg: findSvg,
          interaction,
        })}
        <button
          class="btn btn--sm"
          ?disabled=${!nodes.length}
          @click=${(event: Event) =>
            graphAction(event, (canvas) => fitSvgGraphView(canvas, interaction))}
        >
          ${t("platformClaw.memory.organization.graphFit")}
        </button>
        <button
          class="btn btn--sm"
          aria-pressed=${String(state.expanded)}
          @click=${() => set({ expanded: !state.expanded })}
        >
          ${t(`platformClaw.memory.organization.${state.expanded ? "graphReduce" : "graphExpand"}`)}
        </button>
      </div>
    </div>
    <fieldset class="organization-memory-graph__filters">
      <legend>${t("platformClaw.memory.organization.legendTitle")}</legend>
      ${(["reference", "promotion", "comparison"] as const).map(
        (type) => html`<label data-relation-type=${type}>
          <input
            type="checkbox"
            .checked=${state.edgeTypes.has(type)}
            @change=${(event: Event) => {
              const edgeTypes = new Set(state.edgeTypes);
              if ((event.currentTarget as HTMLInputElement).checked) {
                edgeTypes.add(type);
              } else {
                edgeTypes.delete(type);
              }
              set({ edgeTypes, selection: selectedEdge ? null : state.selection });
            }}
          />
          <span title=${t(`platformClaw.memory.organization.${relationLabels[type]}`)}
            >${t(`platformClaw.memory.organization.graphFilter.${type}`)}</span
          >
        </label>`,
      )}
      <label
        ><input
          type="checkbox"
          .checked=${state.labels}
          @change=${(event: Event) =>
            set({ labels: (event.currentTarget as HTMLInputElement).checked })}
        />${t("platformClaw.memory.organization.graphLabels")}</label
      >
    </fieldset>
    <div class="organization-memory-graph__stats" role="status">
      <span
        >${t("platformClaw.memory.organization.graphVisible", {
          count: String(nodes.length),
          total: String(graph.nodes.length),
        })}</span
      >
      <span
        >${t("platformClaw.memory.organization.graphEdges", { count: String(edges.length) })}</span
      >
      ${graph.stats.truncated
        ? html`<span>${t("platformClaw.memory.organization.graphTruncated")}</span>`
        : nothing}
      ${graph.stats.partial
        ? html`<span>${t("platformClaw.memory.organization.graphPartial")}</span>`
        : nothing}
    </div>
    <div class="organization-memory-graph__body">
      <aside
        class="organization-memory-graph__inspector"
        aria-label=${t("platformClaw.memory.organization.graphSelection")}
      >
        <label class="organization-memory-graph__picker">
          <span>${t("platformClaw.memory.organization.graphSelectDocument")}</span>
          <select
            class="settings-select"
            .value=${selectedId ?? ""}
            @change=${(event: Event) =>
              selectNode((event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">${t("platformClaw.memory.organization.graphSelectDocument")}</option>
            ${nodes
              .toSorted((a, b) => a.title.localeCompare(b.title))
              .map(
                (node) =>
                  html`<option value=${node.id} .selected=${node.id === selectedId}>
                    ${node.title}
                  </option>`,
              )}
          </select>
        </label>
        ${selectedNode && ids.has(selectedNode.id)
          ? html`<div class="organization-memory-graph__selection" aria-live="polite">
              <h3>${selectedNode.title}</h3>
              <p>${selectedNode.scopeName} · ${formatRelativeTimestamp(selectedNode.updatedAt)}</p>
              <time datetime=${new Date(selectedNode.updatedAt).toISOString()}
                >${formatMs(selectedNode.updatedAt)}</time
              >
              ${selectedNode.verification
                ? html`<p data-memory-verification>
                    ${t("platformClaw.memory.graph.approved")} ·
                    ${t("platformClaw.memory.graph.revision", {
                      revision: String(selectedNode.verification.revision),
                    })}
                    · ${t(`platformClaw.memory.graph.${selectedNode.verification.sourceStatus}`)}
                  </p>`
                : html`<p data-memory-verification>
                    ${t("platformClaw.memory.graph.unverified")}
                  </p>`}
              <div class="organization-memory-graph__selection-actions">
                <button
                  class="btn btn--sm primary"
                  ?disabled=${!params.canRead}
                  @click=${() => params.onOpen(selectedNode.path)}
                >
                  ${t("platformClaw.memory.organization.graphOpenDocument")}
                </button>
                <button
                  class="btn btn--sm"
                  @click=${(event: Event) =>
                    graphAction(event, (canvas) => {
                      focusSvgGraphNode(canvas, interaction, selectedNode.id);
                      if (canvas.getBoundingClientRect().width <= 640) {
                        canvas.scrollIntoView?.({ block: "center" });
                      }
                    })}
                >
                  ${t("platformClaw.memory.organization.graphFocus")}
                </button>
                <button
                  class="btn btn--sm"
                  @click=${() => set({ selection: null, neighborsOnly: false })}
                >
                  ${t("platformClaw.memory.organization.graphClearSelection")}
                </button>
              </div>
              <label
                ><input
                  type="checkbox"
                  .checked=${state.neighborsOnly}
                  @change=${(event: Event) =>
                    set({ neighborsOnly: (event.currentTarget as HTMLInputElement).checked })}
                />${t("platformClaw.memory.organization.graphNeighborsOnly")}</label
              >
              <h4>
                ${t("platformClaw.memory.organization.graphEdges", {
                  count: String(connections.length),
                })}
              </h4>
              <div class="organization-memory-graph__connections">
                ${connections.map((edge) => {
                  const neighbor = allNodes.get(
                    edge.source === selectedId ? edge.target : edge.source,
                  )!;
                  return html`<div class="organization-memory-graph__connection">
                    <button class="btn btn--subtle" @click=${() => selectNode(neighbor.id)}>
                      ${neighbor.title}
                    </button>
                    <span
                      >${edge.type === "comparison" ? "↔" : edge.source === selectedId ? "→" : "←"}
                      ${relationLabel(edge)}</span
                    >
                    <button
                      class="btn btn--subtle btn--sm"
                      @click=${() => set({ selection: { edge }, neighborsOnly: false })}
                    >
                      ${t("platformClaw.memory.organization.graphRelationDetails")}
                    </button>
                  </div>`;
                })}
                ${!connections.length
                  ? html`<p>${t("platformClaw.memory.organization.graphNoConnections")}</p>`
                  : nothing}
              </div>
            </div>`
          : selectedEdge && edges.includes(selectedEdge)
            ? html`${renderEdgeDetails(selectedEdge, allNodes)}
                <button class="btn btn--sm" @click=${() => selectNode(selectedEdge.source)}>
                  ${allNodes.get(selectedEdge.source)?.title}
                </button>
                <button class="btn btn--sm" @click=${() => selectNode(selectedEdge.target)}>
                  ${allNodes.get(selectedEdge.target)?.title}
                </button>
                <button class="btn btn--sm" @click=${() => set({ selection: null })}>
                  ${t("platformClaw.memory.organization.graphClearSelection")}
                </button>`
            : html`<p>${t("platformClaw.memory.organization.graphInspectHint")}</p>`}
      </aside>
      ${!nodes.length
        ? html`<div class="organization-memory-graph__state">
            <p>
              ${t(
                graph.nodes.length
                  ? "platformClaw.memory.organization.graphNoMatches"
                  : "platformClaw.memory.organization.graphEmpty",
              )}
            </p>
            <button
              class="btn btn--sm"
              @click=${() => set({ query: "", neighborsOnly: false, selection: null })}
            >
              ${t("platformClaw.memory.organization.graphClearSearch")}
            </button>
          </div>`
        : html`<div class="organization-memory-graph__canvas">
            <svg
              viewBox="0 0 ${WIDTH} ${HEIGHT}"
              aria-label=${t("platformClaw.memory.organization.graph")}
              @wheel=${(event: WheelEvent) => handleSvgGraphWheel(event, interaction)}
              @pointerdown=${(event: PointerEvent) =>
                startSvgGraphPointer(event, interaction, null)}
              @pointermove=${(event: PointerEvent) => moveSvgGraphPointer(event, interaction)}
              @pointerup=${(event: PointerEvent) => {
                const id = endSvgGraphPointer(event, interaction);
                if (id) {
                  selectNode(id);
                }
              }}
              @pointercancel=${(event: PointerEvent) =>
                endSvgGraphPointer(event, interaction, false)}
              @lostpointercapture=${(event: PointerEvent) =>
                endSvgGraphPointer(event, interaction, false)}
            >
              <defs>
                <marker
                  id="organization-memory-promotion-arrow"
                  viewBox="0 0 10 10"
                  refX="16"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)"></path>
                </marker>
                <marker
                  id="organization-memory-reference-arrow"
                  viewBox="0 0 10 10"
                  refX="16"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)"></path>
                </marker>
              </defs>
              <g data-svg-graph-viewport transform=${svgGraphTransform(interaction)}>
                <g class="organization-memory-graph__edges">
                  ${edges.map((edge) => {
                    const types = pairTypes.get(pairKey(edge))!;
                    const offset =
                      (types.indexOf(edge.type) - (types.length - 1) / 2) *
                      8 *
                      (edge.source < edge.target ? 1 : -1);
                    const coordinates = svgGraphEdgeCoordinates(
                      interaction.positions.get(edge.source)!,
                      interaction.positions.get(edge.target)!,
                      offset,
                    );
                    const label = `${allNodes.get(edge.source)?.title} ${edge.type === "comparison" ? "↔" : "→"} ${allNodes.get(edge.target)?.title} · ${edge.type === "comparison" ? t(`platformClaw.memory.knowledge.kind.${edge.kind}`) : relationLabel(edge)}`;
                    return svg`<line data-edge-type=${edge.type} data-active=${!state.selection || (selectedId ? edge.source === selectedId || edge.target === selectedId : edge === selectedEdge)}
                      data-edge-kind=${edge.type === "comparison" ? edge.kind : nothing}
                      marker-end=${edge.type === "comparison" ? nothing : edge.type === "reference" ? "url(#organization-memory-reference-arrow)" : "url(#organization-memory-promotion-arrow)"}
                      role="button" tabindex="0" aria-label=${label}
                      @pointerdown=${(event: Event) => event.stopPropagation()}
                      @click=${(event: Event) => {
                        event.stopPropagation();
                        set({ selection: { edge }, neighborsOnly: false });
                      }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          set({ selection: { edge }, neighborsOnly: false });
                        }
                      }}
                      data-svg-graph-source=${edge.source} data-svg-graph-target=${edge.target} data-svg-graph-offset=${offset}
                      x1=${coordinates.x1} y1=${coordinates.y1} x2=${coordinates.x2} y2=${coordinates.y2}><title>${label}</title></line>`;
                  })}
                </g>
                <g class="organization-memory-graph__nodes">
                  ${nodes.map((node) => {
                    const point = interaction.positions.get(node.id)!;
                    const active =
                      !state.selection ||
                      (selectedId
                        ? node.id === selectedId || neighbors.has(node.id)
                        : node.id === selectedEdge?.source || node.id === selectedEdge?.target);
                    return svg`<g class="organization-memory-graph__node" transform="translate(${point.x} ${point.y})" role="button" tabindex="0" aria-label=${node.title} aria-pressed=${String(node.id === selectedId)} data-active=${active}
                      data-organization-node=${node.path} data-svg-graph-node=${node.id}
                      @pointerdown=${(event: PointerEvent) => startSvgGraphPointer(event, interaction, node.id)}
                      @click=${() => {
                        if (shouldActivateSvgGraphNode(interaction, node.id)) {
                          selectNode(node.id);
                        }
                      }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectNode(node.id);
                        }
                      }}>
                      <circle class="organization-memory-graph__hit" r="20"></circle><circle r="10"></circle>
                      ${state.labels || (state.selection && active) ? svg`<text text-anchor="middle">${titleLines(node.title).map((line, index) => svg`<tspan x="0" y=${26 + index * 16}>${line}</tspan>`)}</text>` : nothing}
                      <title>${node.title} · ${node.scopeName}</title>
                    </g>`;
                  })}
                </g>
              </g>
            </svg>
          </div>`}
    </div>
    <p class="organization-memory-graph__hint">
      ${t("platformClaw.memory.organization.graphNavigationHint")}
    </p>
  </div>`;
}
