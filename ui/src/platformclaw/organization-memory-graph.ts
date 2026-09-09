import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, svg, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  OrganizationMemoryDocument,
  OrganizationMemoryGraph,
  OrganizationMemoryGraphKind,
} from "../../../packages/platformclaw-control-plane/src/contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import {
  endSvgGraphPointer,
  getSvgGraphInteraction,
  handleSvgGraphWheel,
  moveSvgGraphPointer,
  renderSvgGraphControls,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
  svgGraphTransform,
} from "../components/svg-graph-interaction.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
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
  @property() agentId: string | null = null;

  @state() private kind: OrganizationMemoryGraphKind = "part";
  @state() private states = new Map<OrganizationMemoryGraphKind, GraphState>();
  @state() private preview: OrganizationMemoryDocument | null = null;
  @state() private previewPath: string | null = null;
  @state() private previewLoading = false;
  @state() private previewError: string | null = null;
  private requestEpoch = 0;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  protected override updated(changed: PropertyValues<this>) {
    if (
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("methodAdvertised") ||
      changed.has("agentId")
    ) {
      this.requestEpoch += 1;
      this.states = new Map();
      this.closePreview();
      void this.load(this.kind);
    }
  }

  private async load(kind: OrganizationMemoryGraphKind, force = false) {
    const client = this.connected && this.methodAdvertised ? this.client : null;
    if (!client || !this.agentId || (!force && this.states.get(kind)?.status === "ready")) {
      return;
    }
    const epoch = ++this.requestEpoch;
    this.states = new Map(this.states).set(kind, { status: "loading" });
    try {
      const graph = await client.request<OrganizationMemoryGraph>("platformclaw.memory.graph", {
        kind,
      });
      if (epoch !== this.requestEpoch || this.kind !== kind) {
        return;
      }
      this.states = new Map(this.states).set(kind, { status: "ready", graph });
    } catch (error) {
      if (epoch === this.requestEpoch && this.kind === kind) {
        this.states = new Map(this.states).set(kind, {
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
    this.requestEpoch += 1;
    this.closePreview();
    void this.load(kind);
  }

  private async openPreview(path: string) {
    const client = this.connected && this.getAdvertised ? this.client : null;
    if (!client || !this.agentId) {
      return;
    }
    const epoch = ++this.requestEpoch;
    this.previewPath = path;
    this.preview = null;
    this.previewLoading = true;
    this.previewError = null;
    try {
      const document = await client.request<OrganizationMemoryDocument | null>(
        "platformclaw.memory.get",
        { agentId: this.agentId, path, fromLine: 1, lineCount: 200 },
      );
      if (epoch !== this.requestEpoch || this.previewPath !== path) {
        return;
      }
      if (!document) {
        this.previewError = t("platformClaw.memory.organization.graphPreviewMissing");
      } else {
        this.preview = document;
      }
    } catch (error) {
      if (epoch === this.requestEpoch && this.previewPath === path) {
        this.previewError = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.requestEpoch && this.previewPath === path) {
        this.previewLoading = false;
      }
    }
  }

  private closePreview() {
    this.requestEpoch += 1;
    this.previewPath = null;
    this.preview = null;
    this.previewLoading = false;
    this.previewError = null;
  }

  private renderPreview() {
    if (!this.previewPath) {
      return nothing;
    }
    return html`<openclaw-modal-dialog
      .label=${this.preview?.title ?? t("platformClaw.memory.organization.graphPreview")}
      style="--openclaw-modal-width: 1120px"
      @modal-cancel=${() => this.closePreview()}
    >
      <div class="organization-memory-graph__preview">
        ${this.previewLoading
          ? html`<p role="status">${t("platformClaw.memory.organization.graphPreviewLoading")}</p>`
          : this.previewError
            ? html`<p role="alert">${this.previewError}</p>`
            : html`<div class="organization-memory-graph__preview-meta">
                  ${this.preview?.scopeName} · ${this.preview?.path}
                </div>
                <pre tabindex="0">${this.preview?.content ?? ""}</pre>`}
      </div>
    </openclaw-modal-dialog>`;
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
              void this.openPreview(node.path);
            }
          }}
          @pointercancel=${(event: PointerEvent) => endSvgGraphPointer(event, interaction, false)}
          @lostpointercapture=${(event: PointerEvent) =>
            endSvgGraphPointer(event, interaction, false)}
        >
          <g data-svg-graph-viewport transform=${svgGraphTransform(interaction)}>
            <g class="organization-memory-graph__edges" aria-hidden="true">
              ${graph.edges.map((edge) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                return source && target
                  ? svg`<line data-svg-graph-source=${edge.source} data-svg-graph-target=${edge.target} x1=${source.x} y1=${source.y} x2=${target.x} y2=${target.y}></line>`
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
                    void this.openPreview(node.path);
                  }
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    void this.openPreview(node.path);
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
    const graphState = this.states.get(this.kind) ?? { status: "idle" as const };
    let content;
    if (graphState.status === "idle" || graphState.status === "loading") {
      content = html`<div class="organization-memory-graph__state" role="status">
        ${t("platformClaw.memory.organization.graphLoading")}
      </div>`;
    } else if (graphState.status === "error") {
      content = html`<div class="organization-memory-graph__state" role="alert">
        <strong>${t("platformClaw.memory.organization.graphError")}</strong>
        <span>${graphState.message}</span>
        <button class="btn btn--sm" @click=${() => void this.load(this.kind, true)}>
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
        </div>
        <button
          class="btn btn--subtle btn--sm"
          ?disabled=${graphState.status === "loading"}
          @click=${() => void this.load(this.kind, true)}
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
        ],
        ariaLabel: t("platformClaw.memory.organization.graphKinds"),
        panelId: "organization-memory-graph-panel",
        variant: "sub",
        onSelect: (kind) => this.selectKind(kind),
      })}
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
