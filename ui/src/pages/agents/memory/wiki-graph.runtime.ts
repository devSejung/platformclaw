// Lazy Control UI renderer for the Personal Wiki document graph.
import { html, nothing, svg } from "lit";
import {
  endSvgGraphPointer,
  getSvgGraphInteraction,
  handleSvgGraphWheel,
  moveSvgGraphPointer,
  renderSvgGraphControls,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
  svgGraphTransform,
} from "../../../components/svg-graph-interaction.ts";
import { platformClawT as t } from "../../../platformclaw/i18n.ts";
import type { WikiGraphRendererProps } from "./view.ts";

const WIDTH = 960;
const HEIGHT = 600;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type PositionedNode = WikiGraphRendererProps["graph"] extends infer Graph
  ? Graph extends { nodes: Array<infer Node> }
    ? Node & { x: number; y: number; degree: number }
    : never
  : never;

type DirectoryFilter = { directories: string[]; selected: Set<string> };
const directoryFilters = new WeakMap<object, DirectoryFilter>();
const ROOT_DIRECTORY = "";

function directoryForNode(id: string): string {
  if (id.startsWith("/") || /^[a-zA-Z]:[/\\]/u.test(id)) {
    return ROOT_DIRECTORY;
  }
  const segments = id.split("/");
  if (segments.some((segment) => segment === ".." || segment === ".")) {
    return ROOT_DIRECTORY;
  }
  return segments.length > 1 ? segments[0]! : ROOT_DIRECTORY;
}

function getDirectoryFilter(graph: NonNullable<WikiGraphRendererProps["graph"]>): DirectoryFilter {
  let filter = directoryFilters.get(graph);
  if (!filter) {
    const directories = [...new Set(graph.nodes.map((node) => directoryForNode(node.id)))].toSorted(
      (left, right) =>
        left === ROOT_DIRECTORY ? -1 : right === ROOT_DIRECTORY ? 1 : left < right ? -1 : 1,
    );
    filter = { directories, selected: new Set(directories) };
    directoryFilters.set(graph, filter);
  }
  return filter;
}

function truncateLabel(value: string): string {
  return value.length <= 28 ? value : `${value.slice(0, 27)}…`;
}

function positionNodes(
  graph: Pick<NonNullable<WikiGraphRendererProps["graph"]>, "nodes" | "edges">,
): PositionedNode[] {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const sorted = graph.nodes.toSorted(
    (left, right) =>
      (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
  if (sorted.length === 1) {
    const node = sorted[0]!;
    return [
      {
        id: node.id,
        title: node.title,
        kind: node.kind,
        updatedAt: node.updatedAt,
        x: WIDTH / 2,
        y: HEIGHT / 2,
        degree: degree.get(node.id) ?? 0,
      },
    ];
  }
  const positionedNodes: PositionedNode[] = [];
  for (const [index, node] of sorted.entries()) {
    const progress = Math.sqrt((index + 1) / Math.max(1, sorted.length));
    const radius = 36 + progress * Math.min(WIDTH, HEIGHT) * 0.4;
    const angle = index * GOLDEN_ANGLE - Math.PI / 2;
    positionedNodes.push({
      id: node.id,
      title: node.title,
      kind: node.kind,
      updatedAt: node.updatedAt,
      x: WIDTH / 2 + Math.cos(angle) * radius,
      y: HEIGHT / 2 + Math.sin(angle) * radius,
      degree: degree.get(node.id) ?? 0,
    });
  }
  return positionedNodes;
}

function renderState(
  title: string,
  hint: string | null,
  action: ReturnType<typeof html> | typeof nothing = nothing,
) {
  return html`
    <div class="dreams-diary__empty memory-wiki-graph__state">
      <div class="dreams-diary__empty-text">${title}</div>
      ${hint ? html`<div class="dreams-diary__empty-hint">${hint}</div>` : nothing} ${action}
    </div>
  `;
}

export function renderWikiGraph(props: WikiGraphRendererProps) {
  if (props.error) {
    return renderState(
      t("dreaming.wiki.graphError"),
      props.error,
      html`<button class="btn btn--subtle btn--sm" @click=${props.onRetry}>
        ${t("dreaming.diary.reload")}
      </button>`,
    );
  }
  if (!props.graph) {
    return renderState(t("dreaming.wiki.loadingGraph"), null);
  }
  if (props.graph.nodes.length === 0) {
    return renderState(t("dreaming.wiki.emptyGraph"), t("dreaming.wiki.emptyGraphHint"));
  }

  const filter = getDirectoryFilter(props.graph);
  const visibleNodes = props.graph.nodes.filter((node) =>
    filter.selected.has(directoryForNode(node.id)),
  );
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleGraph = {
    nodes: visibleNodes,
    edges: props.graph.edges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    ),
  };
  const nodes = positionNodes(visibleGraph);
  const positions = new Map(nodes.map((node) => [node.id, node] as const));
  const interaction = getSvgGraphInteraction(props.graph, positions);
  const positioned = nodes.map((node) => {
    const point = interaction.positions.get(node.id) ?? node;
    return {
      id: node.id,
      title: node.title,
      kind: node.kind,
      updatedAt: node.updatedAt,
      degree: node.degree,
      x: point.x,
      y: point.y,
    };
  });
  const renderedPositions = new Map(positioned.map((node) => [node.id, node] as const));
  const allDirectoriesSelected = filter.selected.size === filter.directories.length;
  const updateSelection = (directory: string, selected: boolean) => {
    if (selected) {
      filter.selected.add(directory);
    } else {
      filter.selected.delete(directory);
    }
    props.onChange();
  };
  return html`
    <div class="memory-wiki-graph" aria-busy=${props.loading ? "true" : "false"}>
      <div class="memory-wiki-graph__toolbar">
        <fieldset class="memory-wiki-graph__directories">
          <legend>${t("dreaming.wiki.graphDirectories")}</legend>
          ${filter.directories.map(
            (directory) => html`<label>
              <input
                type="checkbox"
                .checked=${filter.selected.has(directory)}
                @change=${(event: Event) =>
                  updateSelection(directory, (event.currentTarget as HTMLInputElement).checked)}
              />
              ${directory || t("dreaming.wiki.graphRootDirectory")}
            </label>`,
          )}
          <button
            class="btn btn--subtle btn--sm"
            @click=${() => {
              filter.selected = new Set(filter.directories);
              props.onChange();
            }}
            ?disabled=${allDirectoriesSelected}
          >
            ${t("dreaming.wiki.graphSelectAll")}
          </button>
        </fieldset>
        ${renderSvgGraphControls({
          label: t("dreaming.wiki.graphControls"),
          zoomIn: t("dreaming.wiki.graphZoomIn"),
          zoomOut: t("dreaming.wiki.graphZoomOut"),
          reset: t("dreaming.wiki.graphResetView"),
          svg: (source) => source.closest(".memory-wiki-graph")?.querySelector("svg") ?? null,
          interaction,
        })}
      </div>
      <div class="memory-wiki-graph__stats">
        <span aria-live="polite"
          >${t("dreaming.wiki.graphNodes", { count: String(nodes.length) })}</span
        >
        <span>${t("dreaming.wiki.graphEdges", { count: String(visibleGraph.edges.length) })}</span>
        ${allDirectoriesSelected
          ? html`<span
              >${t("dreaming.wiki.graphBroken", {
                count: String(props.graph.stats.unresolvedLinks),
              })}</span
            >`
          : nothing}
        ${props.graph.stats.truncated
          ? html`<span class="memory-wiki-graph__truncated"
              >${t("dreaming.wiki.graphTruncated")}</span
            >`
          : nothing}
      </div>
      <div class="memory-wiki-graph__canvas">
        <svg
          viewBox="0 0 ${WIDTH} ${HEIGHT}"
          aria-label=${t("dreaming.wiki.graphView")}
          @wheel=${(event: WheelEvent) => handleSvgGraphWheel(event, interaction)}
          @pointerdown=${(event: PointerEvent) => startSvgGraphPointer(event, interaction, null)}
          @pointermove=${(event: PointerEvent) => moveSvgGraphPointer(event, interaction)}
          @pointerup=${(event: PointerEvent) => {
            const nodeId = endSvgGraphPointer(event, interaction);
            if (nodeId) {
              props.onOpenNode(nodeId);
            }
          }}
          @pointercancel=${(event: PointerEvent) => endSvgGraphPointer(event, interaction, false)}
          @lostpointercapture=${(event: PointerEvent) =>
            endSvgGraphPointer(event, interaction, false)}
        >
          <g data-svg-graph-viewport transform=${svgGraphTransform(interaction)}>
            <g class="memory-wiki-graph__edges" aria-hidden="true">
              ${visibleGraph.edges.map((edge) => {
                const source = renderedPositions.get(edge.source);
                const target = renderedPositions.get(edge.target);
                return source && target
                  ? svg`<line data-svg-graph-source=${edge.source} data-svg-graph-target=${edge.target} x1=${source.x} y1=${source.y} x2=${target.x} y2=${target.y}></line>`
                  : nothing;
              })}
            </g>
            <g class="memory-wiki-graph__nodes">
              ${positioned.map(
                (node) => svg`
                <g
                  class="memory-wiki-graph__node memory-wiki-graph__node--${node.kind}"
                  transform="translate(${node.x} ${node.y})"
                  role="button"
                  tabindex="0"
                  aria-label=${node.title}
                  data-wiki-node=${node.id}
                  @contextmenu=${
                    props.wikiActions
                      ? (event: MouseEvent) => props.wikiActions!.open(node.id, event)
                      : nothing
                  }
                  data-svg-graph-node=${node.id}
                  @pointerdown=${(event: PointerEvent) =>
                    startSvgGraphPointer(event, interaction, node.id)}
                  @click=${() => {
                    if (shouldActivateSvgGraphNode(interaction, node.id)) {
                      props.onOpenNode(node.id);
                    }
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      props.onOpenNode(node.id);
                    }
                  }}
                >
                  <circle r=${Math.min(11, 6 + Math.sqrt(node.degree + 1))}></circle>
                  <text x="13" y="4">${truncateLabel(node.title)}</text>
                  <title>${node.title} · ${node.kind}</title>
                </g>
              `,
              )}
            </g>
          </g>
        </svg>
      </div>
    </div>
  `;
}
