import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, svg, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  OrganizationMemoryGraph,
  OrganizationMemoryGraphKind,
  OrganizationMemoryLifecycleSnapshot,
} from "../../../packages/platformclaw-control-plane/src/contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import "./organization-memory-document-preview.ts";
import "../styles/sidebar-markdown.css";
import {
  endSvgGraphPointer,
  getSvgGraphInteraction,
  handleSvgGraphWheel,
  moveSvgGraphPointer,
  renderSvgGraphControls,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
  svgGraphTransform,
  svgGraphEdgeCoordinates,
} from "../components/svg-graph-interaction.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { formatMs, formatRelativeTimestamp } from "../lib/format.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../components/modal-dialog.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

const WIDTH = 960;
const HEIGHT = 600;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type GraphState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; graph: OrganizationMemoryGraph }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

type PositionedNode = OrganizationMemoryGraph["nodes"][number] & {
  x: number;
  y: number;
  degree: number;
};

function positionNodes(graph: OrganizationMemoryGraph): PositionedNode[] {
  const degree = new Map<string, number>();
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const scopes = [...new Set(graph.nodes.map((node) => node.scopeName))].toSorted();
  const scopeIndex = new Map(scopes.map((scope, index) => [scope, index] as const));
  const scopeCounts = new Map<string, number>();
  return graph.nodes
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map((node) => {
      const cluster = scopeIndex.get(node.scopeName) ?? 0;
      const clusterAngle = (cluster / Math.max(1, scopes.length)) * Math.PI * 2 - Math.PI / 2;
      const clusterRadius = scopes.length === 1 ? 0 : Math.min(WIDTH, HEIGHT) * 0.25;
      const centerX = WIDTH / 2 + Math.cos(clusterAngle) * clusterRadius;
      const centerY = HEIGHT / 2 + Math.sin(clusterAngle) * clusterRadius;
      const index = scopeCounts.get(node.scopeName) ?? 0;
      scopeCounts.set(node.scopeName, index + 1);
      const radius = index === 0 ? 0 : 24 + Math.sqrt(index) * 22;
      const angle = index * GOLDEN_ANGLE;
      return {
        id: node.id,
        path: node.path,
        title: node.title,
        scopeName: node.scopeName,
        updatedAt: node.updatedAt,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
        degree: degree.get(node.id) ?? 0,
      };
    });
}

function shortLabel(value: string): string {
  return value.length <= 28 ? value : `${value.slice(0, 27)}…`;
}

class PlatformClawOrganizationMemoryGraph extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = false;
  @property({ type: Boolean }) getAdvertised = false;
  @property({ type: Boolean }) inventoryAdvertised = false;
  @property() agentId: string | null = null;

  @state() private kind: OrganizationMemoryGraphKind = "part";
  @state() private states = new Map<string, GraphState>();
  @state() private scopes: OrganizationMemoryLifecycleSnapshot["scopes"] = [];
  @state() private selectedScopes = new Map<OrganizationMemoryGraphKind, string>();
  private inventoryEpoch = 0;
  private inventoryReady = false;
  @state() private previewPath: string | null = null;
  private requestEpoch = 0;
  @state() private selectedEdge: OrganizationMemoryGraph["edges"][number] | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    this.requestEpoch += 1;
    this.inventoryEpoch += 1;
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("methodAdvertised") ||
      changed.has("agentId") ||
      changed.has("inventoryAdvertised")
    ) {
      this.requestEpoch += 1;
      this.selectedEdge = null;
      this.states = new Map();
      this.closePreview();
      this.scopes = [];
      this.inventoryReady = false;
      this.selectedScopes = new Map();
      void this.loadInventory();
    }
  }

  private stateKey(kind = this.kind) {
    return `${kind}:${kind === "global" ? "global" : (this.selectedScopes.get(kind) ?? "none")}`;
  }

  private async loadInventory() {
    const epoch = ++this.inventoryEpoch;
    this.inventoryReady = false;
    if (!this.inventoryAdvertised) {
      this.states = new Map().set(this.stateKey(), {
        status: "error",
        message: t("platformClaw.memory.organization.graphUnavailable"),
      });
      return;
    }
    if (!this.client || !this.connected || !this.methodAdvertised || !this.agentId) {
      return;
    }
    this.states = new Map().set(this.stateKey(), { status: "loading" });
    this.requestEpoch += 1;
    this.selectedEdge = null;
    this.closePreview();
    try {
      const snapshot = await this.client.request<OrganizationMemoryLifecycleSnapshot>(
        "platformclaw.memory.lifecycle",
        {},
      );
      if (epoch !== this.inventoryEpoch) {
        return;
      }
      this.scopes = snapshot.scopes
        .filter((scope) => scope.canRead && typeof scope.id === "string")
        .toSorted(
          (a, b) => a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)),
        );
      for (const kind of ["part", "group", "team"] as const) {
        if (
          !this.scopes.some(
            (scope) => scope.kind === kind && scope.id === this.selectedScopes.get(kind),
          )
        ) {
          const selected = this.scopes.find((scope) => scope.kind === kind);
          this.selectedScopes.delete(kind);
          if (selected?.id) {
            this.selectedScopes.set(kind, selected.id);
          }
        }
      }
      this.inventoryReady = true;
      void this.load(this.kind, true);
    } catch (error) {
      if (epoch !== this.inventoryEpoch) {
        return;
      }
      this.scopes = [];
      this.selectedScopes = new Map();
      this.states = new Map().set(this.stateKey(), {
        status: "error",
        message: formatErrorMessage(error, { redact: redactToolDetail }),
      });
    }
  }

  private selectScope(scopeId: string) {
    if (!this.scopes.some((scope) => scope.kind === this.kind && scope.id === scopeId)) {
      return;
    }
    this.selectedScopes = new Map(this.selectedScopes).set(this.kind, scopeId);
    this.selectedEdge = null;
    this.requestEpoch += 1;
    this.closePreview();
    void this.load(this.kind);
  }

  private async load(kind: OrganizationMemoryGraphKind, force = false) {
    const client = this.connected && this.methodAdvertised ? this.client : null;
    const key = this.stateKey(kind);
    if (kind !== "global" && this.inventoryReady && !this.selectedScopes.get(kind)) {
      this.states = new Map(this.states).set(key, {
        status: "unavailable",
        message: t("platformClaw.memory.organization.noReadableScope"),
      });
      return;
    }
    if (
      !client ||
      !this.agentId ||
      !this.inventoryReady ||
      (!force && this.states.get(key)?.status === "ready")
    ) {
      return;
    }
    const epoch = ++this.requestEpoch;
    this.selectedEdge = null;
    this.states = new Map(this.states).set(key, { status: "loading" });
    try {
      const graph = await client.request<OrganizationMemoryGraph>("platformclaw.memory.graph", {
        kind,
        ...(kind !== "global" ? { scopeId: this.selectedScopes.get(kind)! } : {}),
      });
      if (epoch !== this.requestEpoch || this.kind !== kind) {
        return;
      }
      this.states = new Map(this.states).set(key, { status: "ready", graph });
    } catch (error) {
      if (epoch === this.requestEpoch && this.kind === kind) {
        this.states = new Map(this.states).set(key, {
          status: "error",
          message: formatErrorMessage(error, { redact: redactToolDetail }),
        });
      }
    }
  }

  private selectKind(kind: OrganizationMemoryGraphKind) {
    if (this.kind === kind) {
      return;
    }
    this.kind = kind;
    this.selectedEdge = null;
    this.requestEpoch += 1;
    this.closePreview();
    void this.load(kind);
  }

  private openPreview(path: string) {
    this.previewPath = path;
  }

  private closePreview() {
    this.previewPath = null;
  }

  private renderPreview() {
    return html`<platformclaw-organization-memory-document-preview
      .client=${this.client}
      .connected=${this.connected}
      .getAdvertised=${this.getAdvertised}
      .agentId=${this.agentId}
      .path=${this.previewPath}
      @document-preview-close=${() => this.closePreview()}
    ></platformclaw-organization-memory-document-preview>`;
  }
  private renderGraph(graph: OrganizationMemoryGraph) {
    if (graph.nodes.length === 0) {
      return html`<div class="organization-memory-graph__state">
        <strong>${t("platformClaw.memory.organization.graphEmpty")}</strong>
        <span>${t("platformClaw.memory.organization.graphEmptyHint")}</span>
        ${graph.stats.partial
          ? html`<span>${t("platformClaw.memory.organization.graphPartial")}</span>`
          : nothing}
      </div>`;
    }
    const nodes = positionNodes(graph);
    const initialPositions = new Map(nodes.map((node) => [node.id, node] as const));
    const interaction = getSvgGraphInteraction(graph, initialPositions);
    const positioned = nodes.map((node) => {
      const point = interaction.positions.get(node.id) ?? node;
      return {
        id: node.id,
        path: node.path,
        title: node.title,
        scopeName: node.scopeName,
        updatedAt: node.updatedAt,
        degree: node.degree,
        x: point.x,
        y: point.y,
      };
    });
    const positions = new Map(positioned.map((node) => [node.id, node] as const));
    const pairKey = (edge: OrganizationMemoryGraph["edges"][number]) =>
      JSON.stringify([edge.source, edge.target].toSorted());
    const pairTypes = new Map<string, string[]>();
    for (const edge of graph.edges) {
      const key = pairKey(edge);
      const types = pairTypes.get(key) ?? [];
      if (!types.includes(edge.type)) {
        types.push(edge.type);
      }
      pairTypes.set(key, types.toSorted());
    }
    return html`<div class="organization-memory-graph__stats">
        <span
          >${t("platformClaw.memory.organization.graphNodes", {
            count: String(graph.stats.totalNodes),
          })}</span
        >

        <span
          >${t("platformClaw.memory.organization.graphEdges", {
            count: String(graph.stats.totalEdges),
          })}</span
        >
        ${graph.stats.truncated
          ? html`<span>${t("platformClaw.memory.organization.graphTruncated")}</span>`
          : nothing}
        ${graph.stats.partial
          ? html`<span>${t("platformClaw.memory.organization.graphPartial")}</span>`
          : nothing}
      </div>
      ${this.selectedEdge
        ? html`<section class="organization-memory-graph__edge-detail" role="status">
            <strong
              >${positions.get(this.selectedEdge.source)?.title} ·
              ${positions.get(this.selectedEdge.target)?.title}</strong
            >
            ${this.selectedEdge.type === "comparison"
              ? html`<p>
                    ${t("platformClaw.memory.knowledge.aiJudgment")} ·
                    ${t(`platformClaw.memory.knowledge.kind.${this.selectedEdge.kind}`)}
                  </p>
                  <p>${this.selectedEdge.summary}</p>
                  <p>
                    ${t(`platformClaw.memory.knowledge.proposal.${this.selectedEdge.reviewStatus}`)}
                  </p>
                  <p>
                    ${formatMs(this.selectedEdge.completedAt)} ·
                    ${formatRelativeTimestamp(this.selectedEdge.completedAt)}
                  </p>`
              : this.selectedEdge.type === "reference"
                ? html`<p>${t("platformClaw.memory.organization.referenceLegend")}</p>
                    <p>
                      ${positions.get(this.selectedEdge.source)?.title} ·
                      r${this.selectedEdge.sourceRevision} →
                      ${positions.get(this.selectedEdge.target)?.title} ·
                      r${this.selectedEdge.targetRevision}
                    </p>`
                : html`<p>${t("platformClaw.memory.organization.provenanceLegend")}</p>`}
          </section>`
        : nothing}
      ${renderSvgGraphControls({
        label: t("platformClaw.memory.organization.graphControls"),
        zoomIn: t("platformClaw.memory.organization.graphZoomIn"),
        zoomOut: t("platformClaw.memory.organization.graphZoomOut"),
        reset: t("platformClaw.memory.organization.graphResetView"),
        svg: () => this.querySelector(".organization-memory-graph__canvas svg"),
        interaction,
      })}
      <div class="organization-memory-graph__canvas">
        <svg
          viewBox="0 0 ${WIDTH} ${HEIGHT}"
          aria-label=${t("platformClaw.memory.organization.graph")}
          @wheel=${(event: WheelEvent) => handleSvgGraphWheel(event, interaction)}
          @pointerdown=${(event: PointerEvent) => startSvgGraphPointer(event, interaction, null)}
          @pointermove=${(event: PointerEvent) => moveSvgGraphPointer(event, interaction)}
          @pointerup=${(event: PointerEvent) => {
            const nodeId = endSvgGraphPointer(event, interaction);
            const node = nodeId ? positioned.find((candidate) => candidate.id === nodeId) : null;
            if (node) {
              this.openPreview(node.path);
            }
          }}
          @pointercancel=${(event: PointerEvent) => endSvgGraphPointer(event, interaction, false)}
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
              ${graph.edges.map((edge) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                const types = pairTypes.get(pairKey(edge))!;
                const offset = (types.indexOf(edge.type) - (types.length - 1) / 2) * 6;
                const direction = edge.source < edge.target ? 1 : -1;
                // Coexisting reference, provenance, and inferred edges share a
                // node pair; parallel lanes keep each typed edge selectable.
                const coordinates =
                  source && target
                    ? svgGraphEdgeCoordinates(source, target, offset * direction)
                    : null;
                return source && target
                  ? svg`<line data-edge-type=${edge.type} data-edge-kind=${edge.type === "comparison" ? edge.kind : nothing} marker-end=${edge.type === "comparison" ? nothing : edge.type === "reference" ? "url(#organization-memory-reference-arrow)" : "url(#organization-memory-promotion-arrow)"} role="button" tabindex="0" aria-label=${edge.type === "comparison" ? `${source.title} · ${target.title} · ${t(`platformClaw.memory.knowledge.kind.${edge.kind}`)}` : `${edge.type === "reference" ? t("platformClaw.memory.organization.referenceLegend") : t("platformClaw.memory.organization.provenanceLegend")}: ${source.title} → ${target.title}`} @pointerdown=${(event: PointerEvent) => event.stopPropagation()} @click=${(
                      event: Event,
                    ) => {
                      event.stopPropagation();
                      this.selectedEdge = edge;
                    }} @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        this.selectedEdge = edge;
                      }
                    }} data-svg-graph-source=${edge.source} data-svg-graph-target=${edge.target} data-svg-graph-offset=${offset * direction} x1=${coordinates!.x1} y1=${coordinates!.y1} x2=${coordinates!.x2} y2=${coordinates!.y2}><title>${edge.type === "comparison" ? `${t(`platformClaw.memory.knowledge.kind.${edge.kind}`)}: ${edge.summary}` : `${edge.type === "reference" ? t("platformClaw.memory.organization.referenceLegend") : t("platformClaw.memory.organization.provenanceLegend")}: ${source.title} → ${target.title}`}</title></line>`
                  : nothing;
              })}
            </g>
            <g class="organization-memory-graph__nodes">
              ${positioned.map(
                (node) => svg`<g
                class="organization-memory-graph__node"
                transform="translate(${node.x} ${node.y})"
                role="button"
                tabindex="0"
                aria-label=${node.title}
                data-organization-node=${node.path}
                data-svg-graph-node=${node.id}
                @pointerdown=${(event: PointerEvent) =>
                  startSvgGraphPointer(event, interaction, node.id)}
                @click=${() => {
                  if (shouldActivateSvgGraphNode(interaction, node.id)) {
                    this.openPreview(node.path);
                  }
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    this.openPreview(node.path);
                  }
                }}
              >
                <circle r=${Math.min(11, 7 + Math.sqrt(node.degree + 1))}></circle>
                <text x="13" y="4">${shortLabel(node.title)}</text>
                <title>${node.title} · ${node.scopeName}</title>
              </g>`,
              )}
            </g>
          </g>
        </svg>
      </div>`;
  }

  override render() {
    if (!this.methodAdvertised) {
      return html`<p class="memory-memories__unavailable">
        ${t("platformClaw.memory.organization.graphUnavailable")}
      </p>`;
    }
    const graphState = this.states.get(this.stateKey()) ?? { status: "idle" as const };
    let content;
    if (graphState.status === "idle" || graphState.status === "loading") {
      content = html`<div class="organization-memory-graph__state" role="status">
        ${t("platformClaw.memory.organization.graphLoading")}
      </div>`;
    } else if (graphState.status === "unavailable") {
      content = html`<p class="organization-memory-graph__state">${graphState.message}</p>`;
    } else if (graphState.status === "error") {
      content = html`<div class="organization-memory-graph__state" role="alert">
        <strong>${t("platformClaw.memory.organization.graphError")}</strong>
        <span>${graphState.message}</span>
        <button class="btn btn--sm" @click=${() => void this.loadInventory()}>
          ${t("platformClaw.memory.organization.graphRetry")}
        </button>
      </div>`;
    } else {
      content = this.renderGraph(graphState.graph);
    }
    return html`<section class="settings-page organization-memory-graph">
      <header class="organization-memory-graph__header">
        <div>
          <h2>${t("platformClaw.memory.organization.graph")}</h2>
          <p>${t("platformClaw.memory.organization.graphDescription")}</p>
          <p>${t("platformClaw.memory.graph.description")}</p>
        </div>
        <button
          class="btn btn--subtle btn--sm"
          ?disabled=${graphState.status === "loading"}
          @click=${() => void this.loadInventory()}
        >
          ${t("platformClaw.memory.organization.graphRefresh")}
        </button>
      </header>
      ${renderHubTabs<OrganizationMemoryGraphKind>({
        id: "organization-memory-graph-kind",
        active: this.kind,
        tabs: [
          { value: "part", label: t("platformClaw.memory.organization.partGraph") },
          { value: "group", label: t("platformClaw.memory.organization.groupGraph") },
          { value: "team", label: t("platformClaw.memory.organization.teamGraph") },
          { value: "global", label: t("platformClaw.memory.organization.globalGraph") },
        ],
        ariaLabel: t("platformClaw.memory.organization.graphKinds"),
        panelId: "organization-memory-graph-panel",
        variant: "sub",
        onSelect: (kind) => this.selectKind(kind),
      })}
      ${this.kind !== "global" && this.inventoryAdvertised
        ? html`<div class="organization-memory-graph__scope">
            <label
              >${t("platformClaw.memory.organization.scopeSelect")}
              <select
                ?disabled=${!this.scopes.some((scope) => scope.kind === this.kind)}
                @change=${(event: Event) =>
                  this.selectScope((event.target as HTMLSelectElement).value)}
              >
                ${this.scopes
                  .filter((scope) => scope.kind === this.kind)
                  .map(
                    (scope) =>
                      html`<option
                        value=${scope.id!}
                        .selected=${scope.id === this.selectedScopes.get(this.kind)}
                      >
                        ${scope.name}
                      </option>`,
                  )}
              </select>
            </label>
            <h3>
              ${this.scopes.find((scope) => scope.id === this.selectedScopes.get(this.kind))
                ?.name ?? t("platformClaw.memory.organization.noReadableScope")}
            </h3>
            <p>${t(`platformClaw.memory.organization.${this.kind}Audience`)}</p>
          </div>`
        : this.kind === "global"
          ? html`<p>${t("platformClaw.memory.organization.globalAudience")}</p>`
          : nothing}
      <section
        class="organization-memory-graph__legend"
        aria-label=${t("platformClaw.memory.organization.legendTitle")}
      >
        ${["reference", "provenance", "comparison"].map(
          (type) => html`<div class="organization-memory-graph__legend-item">
            <svg viewBox="0 0 64 16" width="64" height="16" aria-hidden="true">
              <line
                x1="2"
                y1="8"
                x2="54"
                y2="8"
                stroke=${type === "reference" ? "var(--accent)" : "var(--muted)"}
                stroke-width=${type === "reference" ? "2.5" : type === "comparison" ? "3" : "2"}
                stroke-dasharray=${type === "comparison" ? "5 4" : nothing}
              ></line>
              ${type !== "comparison"
                ? svg`<path d="M 52 3 L 60 8 L 52 13 z" fill=${type === "reference" ? "var(--accent)" : "var(--muted)"}></path>`
                : nothing}</svg
            ><span>${t(`platformClaw.memory.organization.${type}Legend`)}</span>
          </div>`,
        )}
      </section>
      <div id="organization-memory-graph-panel" role="tabpanel">${content}</div>
      ${this.renderPreview()}
    </section>`;
  }
}

if (!customElements.get("platformclaw-organization-memory-graph")) {
  customElements.define(
    "platformclaw-organization-memory-graph",
    PlatformClawOrganizationMemoryGraph,
  );
}
