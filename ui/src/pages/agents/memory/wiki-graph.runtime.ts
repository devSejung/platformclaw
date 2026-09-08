// Lazy Control UI renderer for the Personal Wiki document graph.
import { html, nothing, svg } from "lit";
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

function truncateLabel(value: string): string {
  return value.length <= 28 ? value : `${value.slice(0, 27)}…`;
}

function positionNodes(graph: NonNullable<WikiGraphRendererProps["graph"]>): PositionedNode[] {
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
    return [{ ...node, x: WIDTH / 2, y: HEIGHT / 2, degree: degree.get(node.id) ?? 0 }];
  }
  const positionedNodes: PositionedNode[] = [];
  for (const [index, node] of sorted.entries()) {
    const progress = Math.sqrt((index + 1) / Math.max(1, sorted.length));
    const radius = 36 + progress * Math.min(WIDTH, HEIGHT) * 0.4;
    const angle = index * GOLDEN_ANGLE - Math.PI / 2;
    positionedNodes.push({
      ...node,
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

  const nodes = positionNodes(props.graph);
  const positions = new Map(nodes.map((node) => [node.id, node] as const));
  const stats = props.graph.stats;
  return html`
    <div class="memory-wiki-graph" aria-busy=${props.loading ? "true" : "false"}>
      <div class="memory-wiki-graph__stats">
        <span>${t("dreaming.wiki.graphNodes", { count: String(stats.totalNodes) })}</span>
        <span>${t("dreaming.wiki.graphEdges", { count: String(stats.totalEdges) })}</span>
        <span>${t("dreaming.wiki.graphBroken", { count: String(stats.unresolvedLinks) })}</span>
        ${stats.truncated
          ? html`<span class="memory-wiki-graph__truncated"
              >${t("dreaming.wiki.graphTruncated")}</span
            >`
          : nothing}
      </div>
      <div class="memory-wiki-graph__canvas">
        <svg viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label=${t("dreaming.wiki.graphView")}>
          <g class="memory-wiki-graph__edges" aria-hidden="true">
            ${props.graph.edges.map((edge) => {
              const source = positions.get(edge.source);
              const target = positions.get(edge.target);
              return source && target
                ? svg`<line x1=${source.x} y1=${source.y} x2=${target.x} y2=${target.y}></line>`
                : nothing;
            })}
          </g>
          <g class="memory-wiki-graph__nodes">
            ${nodes.map(
              (node) => svg`
                <g
                  class="memory-wiki-graph__node memory-wiki-graph__node--${node.kind}"
                  transform="translate(${node.x} ${node.y})"
                  role="button"
                  tabindex="0"
                  aria-label=${node.title}
                  data-wiki-node=${node.id}
                  @click=${() => props.onOpenNode(node.id)}
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
        </svg>
      </div>
    </div>
  `;
}
