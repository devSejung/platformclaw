import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
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
import "../styles/organization-memory-graph.css";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import "../components/modal-dialog.ts";
import {
  createOrganizationGraphViewState,
  renderOrganizationGraph,
} from "./organization-memory-graph-view.ts";

type GraphState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; graph: OrganizationMemoryGraph }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

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
  @state() private viewState = createOrganizationGraphViewState();

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
      this.resetExplorer();
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
    this.resetExplorer();
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
    this.resetExplorer();
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
    this.resetExplorer();
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
    this.resetExplorer();
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
  private resetExplorer() {
    this.viewState = { ...createOrganizationGraphViewState(), expanded: this.viewState.expanded };
  }

  private renderGraph(graph: OrganizationMemoryGraph) {
    if (!graph.nodes.length) {
      return html`<div class="organization-memory-graph__state">
        <strong>${t("platformClaw.memory.organization.graphEmpty")}</strong>
        <span>${t("platformClaw.memory.organization.graphEmptyHint")}</span>
        ${graph.stats.partial
          ? html`<span>${t("platformClaw.memory.organization.graphPartial")}</span>`
          : nothing}
      </div>`;
    }
    return renderOrganizationGraph({
      graph,
      state: this.viewState,
      canRead: this.connected && this.getAdvertised,
      onChange: (nextState) => {
        const selected =
          nextState.selection && "nodeId" in nextState.selection
            ? nextState.selection.nodeId
            : null;
        const previous =
          this.viewState.selection && "nodeId" in this.viewState.selection
            ? this.viewState.selection.nodeId
            : null;
        this.viewState = nextState;
        if (selected && selected !== previous) {
          void this.updateComplete.then(() => {
            const canvas = this.querySelector(".organization-memory-graph__canvas");
            if (
              this.viewState === nextState &&
              canvas &&
              canvas.getBoundingClientRect().width <= 640
            ) {
              this.querySelector(".organization-memory-graph__inspector")?.scrollIntoView?.({
                block: "nearest",
              });
            }
          });
        }
      },
      onOpen: (path) => this.openPreview(path),
    });
  }

  override render() {
    if (!this.methodAdvertised) {
      return html`<p class="memory-memories__unavailable">
        ${t("platformClaw.memory.organization.graphUnavailable")}
      </p>`;
    }
    if (!this.connected || !this.client) {
      return html`<p class="organization-memory-graph__state" role="status">
        ${t("platformClaw.memory.organization.graphOffline")}
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
    return html`<section
      class="settings-page organization-memory-graph ${this.viewState.expanded
        ? "organization-memory-graph--expanded"
        : ""}"
    >
      <header class="organization-memory-graph__header">
        <div>
          <h2>${t("platformClaw.memory.organization.graph")}</h2>
          <p>${t("platformClaw.memory.organization.graphDescription")}</p>
          <details class="organization-memory-graph__explanation">
            <summary>${t("platformClaw.memory.organization.legendTitle")}</summary>
            <p>${t("platformClaw.memory.graph.description")}</p>
            <p>${t("platformClaw.memory.organization.referenceLegend")}</p>
            <p>${t("platformClaw.memory.organization.provenanceLegend")}</p>
            <p>${t("platformClaw.memory.organization.comparisonLegend")}</p>
          </details>
        </div>
        <button
          class="btn btn--subtle btn--sm"
          ?disabled=${graphState.status === "loading" || !this.connected}
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
                class="settings-select"
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
            <p>${t(`platformClaw.memory.organization.${this.kind}Audience`)}</p>
          </div>`
        : this.kind === "global"
          ? html`<p>${t("platformClaw.memory.organization.globalAudience")}</p>`
          : nothing}
      <div
        id="organization-memory-graph-panel"
        role="tabpanel"
        aria-labelledby=${`organization-memory-graph-kind-tab-${this.kind}`}
      >
        ${content}
      </div>
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
