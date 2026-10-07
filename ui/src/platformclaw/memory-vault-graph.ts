import { html, nothing, svg, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { KnowledgeVaultSnapshot } from "../../../packages/platformclaw-control-plane/src/knowledge-vault-contracts.js";
import { renderHubTabs } from "../components/hub-tabs.ts";
import {
  endSvgGraphPointer,
  fitSvgGraphView,
  getSvgGraphInteraction,
  handleSvgGraphWheel,
  moveSvgGraphPointer,
  renderSvgGraphControls,
  shouldActivateSvgGraphNode,
  startSvgGraphPointer,
  svgGraphEdgeCoordinates,
  svgGraphTransform,
} from "../components/svg-graph-interaction.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";
import type { VaultDocumentContext } from "./memory-vault-document-actions.ts";
import "./memory-vault-graph.css";
import "./memory-vault-document-actions.ts";
import { renderVaultIndexStatus } from "./memory-vault-document.ts";

type SelectedVault = NonNullable<KnowledgeVaultSnapshot["selected"]>;
const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);
const WIDTH = 960;
const HEIGHT = 560;

class PlatformClawVaultDocuments extends OpenClawLightDomElement {
  @property({ attribute: false }) selected: SelectedVault | null = null;
  @property({ type: Boolean }) busy = false;
  @property({ attribute: false }) documentContext: VaultDocumentContext | null = null;
  @state() private view: "documents" | "graph" = "documents";
  @state() private query = "";
  @state() private activeId = "";
  @state() private canvasWidth = WIDTH;
  private observedCanvas: Element | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private layoutSnapshot: SelectedVault["graph"] | null = null;
  private layoutWidth = 0;
  private layoutQuery = "";
  private layoutKey = {};

  override disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.observedCanvas = null;
    super.disconnectedCallback();
  }

  protected override updated() {
    const canvas = this.querySelector(".vault-graph__canvas");
    if (canvas === this.observedCanvas) {
      return;
    }
    this.resizeObserver?.disconnect();
    this.observedCanvas = canvas;
    if (canvas && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(([entry]) => {
        const width = Math.round(entry!.contentRect.width);
        if (width > 0 && width !== this.canvasWidth) {
          this.canvasWidth = width;
        }
      });
      this.resizeObserver.observe(canvas);
    }
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("selected")) {
      const previous = changed.get("selected") as SelectedVault | null | undefined;
      if (previous?.vault.id !== this.selected?.vault.id) {
        this.activeId = this.query = "";
        this.view = "documents";
      }
    }
  }

  private open(id: string) {
    this.dispatchEvent(
      new CustomEvent("vault-document-open", { detail: id, bubbles: true, composed: true }),
    );
  }

  private renderGraph(selected: SelectedVault) {
    const { graph } = selected;
    const nodeIds = graph.nodeIds ? new Set(graph.nodeIds) : null;
    const documents = nodeIds
      ? selected.documents.filter((document) => nodeIds.has(document.id))
      : selected.documents;
    const documentIds = new Set(documents.map((document) => document.id));
    // The authored catalog can extend beyond the bounded graph and omit generated indexes.
    const documentEdges = graph.edges.filter(
      (edge) => documentIds.has(edge.source) && documentIds.has(edge.target),
    );
    if (!documents.length) {
      return html`<p class="vaults__empty" role="status">
        ${t(
          selected.documents.length
            ? "graphTruncated"
            : selected.vault.canEdit
              ? "graphEmpty"
              : "readerEmpty",
        )}
      </p>`;
    }
    const query = this.query.trim().toLocaleLowerCase();
    const nodes = documents
      .filter((doc) => `${doc.title} ${doc.logicalPath}`.toLocaleLowerCase().includes(query))
      .toSorted((a, b) => a.logicalPath.localeCompare(b.logicalPath));
    const width = this.canvasWidth;
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    // Keep a two-dimensional layout on phones too: one column makes unrelated
    // edges overlap and appear to pass through intermediate documents.
    const columnGap = width < 500 ? 160 : 360;
    const rows = Math.ceil(nodes.length / columns);
    const positions = new Map(
      nodes.map((doc, index) => [
        doc.id,
        {
          x: width / 2 + ((index % columns) - (columns - 1) / 2) * columnGap,
          y: HEIGHT / 2 + (Math.floor(index / columns) - (rows - 1) / 2) * 170,
        },
      ]),
    );
    // One live layout per viewport/filter snapshot. Filtering also fits isolated results;
    // otherwise a match could remain tiny or outside the old dense graph's viewport.
    const fresh =
      this.layoutSnapshot !== graph || this.layoutWidth !== width || this.layoutQuery !== query;
    if (fresh) {
      this.layoutSnapshot = graph;
      this.layoutWidth = width;
      this.layoutQuery = query;
      this.layoutKey = {};
    }
    const interaction = getSvgGraphInteraction(this.layoutKey, positions);
    if (fresh) {
      const scale = Math.min(
        1,
        Math.max(1, width - 32) / ((columns - 1) * columnGap + 230),
        (HEIGHT - 64) / (Math.max(0, rows - 1) * 170 + 70),
      );
      interaction.scale = scale;
      interaction.minimumScale = Math.min(0.4, scale);
      interaction.x = (width / 2) * (1 - scale);
      interaction.y = (HEIGHT / 2) * (1 - scale);
      interaction.initialView = { scale, x: interaction.x, y: interaction.y };
    }
    const visibleIds = new Set(nodes.map((doc) => doc.id));
    const edges = documentEdges.filter(
      (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
    );
    const active = nodes.find((doc) => doc.id === this.activeId);
    const indexed = documents.filter((doc) => doc.compile.status !== "ready");
    const edgesByPair = new Set(edges.map((edge) => `${edge.source}\0${edge.target}`));
    const select = (id: string) => {
      this.activeId = id;
    };
    const relationships = (incoming: boolean) => {
      const related = documentEdges.filter((edge) =>
        incoming ? edge.target === active?.id : edge.source === active?.id,
      );
      return html`<section>
        <h4>${t(incoming ? "backlinks" : "links")}</h4>
        ${related.length
          ? related.map((edge) => {
              const doc = documents.find(
                (item) => item.id === (incoming ? edge.source : edge.target),
              )!;
              return html`<button
                class="btn btn--sm"
                @click=${() => {
                  this.query = "";
                  select(doc.id);
                }}
              >
                ${doc.title}
              </button>`;
            })
          : html`<p class="vaults__hint">
              ${t(graph.truncated ? "graphNoVisibleLinks" : "graphNoLinks")}
            </p>`}
      </section>`;
    };
    return html`<section class="vault-graph" aria-label=${t("graph")}>
      <p class="vaults__hint">${t("graphHint")}</p>
      ${indexed.length
        ? html`<div class="callout warning" role="status">
            <strong>${t("graphRetained")}</strong>
          </div>`
        : nothing}
      <div class="vault-graph__toolbar">
        <input
          class="settings-input"
          type="search"
          aria-label=${t("graphSearch")}
          placeholder=${t("graphSearch")}
          .value=${this.query}
          @input=${(event: Event) => {
            this.query = (event.target as HTMLInputElement).value;
            this.activeId = "";
          }}
        />
        ${renderSvgGraphControls({
          label: t("graphControls"),
          zoomIn: t("graphZoomIn"),
          zoomOut: t("graphZoomOut"),
          reset: t("graphReset"),
          interaction,
          svg: (source) => source.closest(".vault-graph")?.querySelector("svg") ?? null,
        })}
        <button
          class="btn btn--sm"
          @click=${() => {
            const canvas = this.querySelector<SVGSVGElement>(".vault-graph svg");
            if (canvas) {
              fitSvgGraphView(canvas, interaction);
            }
          }}
        >
          ${t("graphFit")}
        </button>
      </div>
      <p class="vaults__hint" aria-live="polite">
        ${t("graphCounts")
          .replace("{nodes}", String(nodes.length))
          .replace("{edges}", String(edges.length))}
        · ${t("graphUnresolved").replace("{count}", String(graph.unresolvedLinks))}
      </p>
      ${graph.truncated ? html`<p class="callout warning">${t("graphTruncated")}</p>` : nothing}
      <div class="vault-graph__body">
        <div class="vault-graph__canvas">
          ${!nodes.length ? html`<p role="status">${t("graphNoMatches")}</p>` : nothing}
          <svg
            viewBox="0 0 ${width} ${HEIGHT}"
            aria-label=${t("graph")}
            @wheel=${(event: WheelEvent) => handleSvgGraphWheel(event, interaction)}
            @pointerdown=${(event: PointerEvent) => startSvgGraphPointer(event, interaction, null)}
            @pointermove=${(event: PointerEvent) => moveSvgGraphPointer(event, interaction)}
            @pointerup=${(event: PointerEvent) => {
              const id = endSvgGraphPointer(event, interaction);
              if (id) {
                select(id);
              }
            }}
            @pointercancel=${(event: PointerEvent) => endSvgGraphPointer(event, interaction, false)}
            @lostpointercapture=${(event: PointerEvent) =>
              endSvgGraphPointer(event, interaction, false)}
          >
            <defs>
              <marker
                id="vault-graph-arrow"
                markerUnits="userSpaceOnUse"
                viewBox="0 0 10 10"
                refX="26"
                refY="5"
                markerWidth="10"
                markerHeight="10"
                orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z"></path>
              </marker>
            </defs>
            <g data-svg-graph-viewport transform=${svgGraphTransform(interaction)}>
              <g class="vault-graph__edges" aria-hidden="true">
                ${edges
                  .filter((edge) => edge.source !== edge.target)
                  .map((edge) => {
                    const offset = edgesByPair.has(`${edge.target}\0${edge.source}`) ? 5 : 0;
                    const line = svgGraphEdgeCoordinates(
                      interaction.positions.get(edge.source)!,
                      interaction.positions.get(edge.target)!,
                      offset,
                    );
                    return svg`<line data-svg-graph-source=${edge.source} data-svg-graph-target=${edge.target} data-svg-graph-offset=${offset} marker-end="url(#vault-graph-arrow)" x1=${line.x1} y1=${line.y1} x2=${line.x2} y2=${line.y2}></line>`;
                  })}
              </g>
              ${nodes.map((doc) => {
                const point = interaction.positions.get(doc.id)!;
                return svg`<g class="vault-graph__node" data-svg-graph-node=${doc.id} transform="translate(${point.x} ${point.y})" role="button" tabindex="0" aria-label=${doc.title} aria-pressed=${String(doc.id === active?.id)}
                  @pointerdown=${(event: PointerEvent) => startSvgGraphPointer(event, interaction, doc.id)}
                  @click=${() => {
                    if (shouldActivateSvgGraphNode(interaction, doc.id)) {
                      select(doc.id);
                    }
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      select(doc.id);
                    }
                  }}>
                  ${edgesByPair.has(`${doc.id}\0${doc.id}`) ? svg`<path class="vault-graph__self" data-vault-self-link=${doc.id} d="M -7 -7 C -55 -65 55 -65 7 -7" marker-end="url(#vault-graph-arrow)"></path>` : nothing}
                  <circle r="10"></circle><text y="30" text-anchor="middle">${doc.title.length > 16 ? doc.title.slice(0, 15) + "…" : doc.title}</text><title>${doc.title} · ${doc.logicalPath}</title>
                </g>`;
              })}
            </g>
          </svg>
        </div>
        <aside class="vault-graph__inspector card">
          <label
            >${t("graphSelect")}<select
              class="settings-select"
              aria-label=${t("graphSelect")}
              .value=${active?.id ?? ""}
              @change=${(event: Event) => select((event.target as HTMLSelectElement).value)}
            >
              <option value="">${t("graphSelect")}</option>
              ${nodes.map((doc) => html`<option value=${doc.id}>${doc.title}</option>`)}
            </select></label
          >
          ${active
            ? html`<h3>${active.title}</h3>
                <p class="vaults__hint">${active.logicalPath} · r${active.revision}</p>
                <p class="vaults__hint">
                  ${t("indexedRevision")}: ${active.compile.indexedRevision ?? "—"} ·
                  ${t(active.compile.status)}
                </p>
                ${active.compile.status !== "ready"
                  ? renderVaultIndexStatus(active.compile)
                  : nothing}
                <button
                  class="btn primary btn--sm"
                  ?disabled=${this.busy}
                  @click=${() => this.open(active.id)}
                >
                  ${t("graphOpen")}
                </button>
                ${relationships(false)}${relationships(true)}`
            : html`<p class="vaults__hint">${t("graphSelectHint")}</p>`}
        </aside>
      </div>
    </section>`;
  }

  override render() {
    const selected = this.selected;
    if (!selected) {
      return nothing;
    }
    return html`${renderHubTabs({
        id: "vault-documents",
        active: this.view,
        variant: "sub",
        ariaLabel: t("documentViews"),
        panelId: "vault-documents-panel",
        tabs: [
          { value: "documents" as const, label: t("documents") },
          { value: "graph" as const, label: t("graph") },
        ],
        onSelect: (view) => {
          this.view = view;
        },
      })}
      <div
        id="vault-documents-panel"
        role="tabpanel"
        aria-labelledby=${`vault-documents-tab-${this.view}`}
      >
        ${this.view === "graph"
          ? this.renderGraph(selected)
          : html`<platformclaw-vault-document-actions
              .selected=${selected}
              .busy=${this.busy}
              .context=${this.documentContext}
            ></platformclaw-vault-document-actions>`}
      </div>`;
  }
}
if (!customElements.get("platformclaw-vault-documents")) {
  customElements.define("platformclaw-vault-documents", PlatformClawVaultDocuments);
}
