import "../styles/config.css";
import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  INTERNAL_MEMORY_PATH_PARAM,
  memoryTabFromPath,
  pathForMemoryTab,
  type MemoryRouteTab,
} from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { renderSettingsRow, renderSettingsSection } from "../components/settings-ui.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import "../pages/agents/memory/memory-panel.ts";
import "../pages/config/memory-memories.ts";
import "./memory-organization.ts";
import "../pages/config/memory-promotions.ts";
import { isExpandableResult, type SearchResult } from "../pages/config/memory-memories-view.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";
import "./memory-item-menu.ts";
import "./memory-delete-dialog.ts";
import type { MemoryMenuAction } from "./memory-item-menu.ts";

type PersonalMemoryTab = "overview" | "memory" | "wiki" | "organization" | "dreaming";

const PANEL_ID = "platformclaw-memory-panel";

export function platformClawMemoryTabFromLocation(
  location: Pick<Location, "pathname" | "search">,
  basePath = "",
): PersonalMemoryTab {
  // Dynamic hub routes travel through the exact-match Memory route. Recover the
  // original path so deep links do not silently fall back to Overview.
  const routedPath =
    new URLSearchParams(location.search).get(INTERNAL_MEMORY_PATH_PARAM) ?? location.pathname;
  const routeTab = memoryTabFromPath(routedPath, basePath) ?? memoryTabFromPath(routedPath);
  return routeTab === "memories"
    ? "memory"
    : routeTab === "wiki" || routeTab === "organization"
      ? routeTab
      : routeTab === "dreams"
        ? "dreaming"
        : "overview";
}

class PlatformClawMemoryPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property() agentId: string | null = null;
  @property() initialTab: PersonalMemoryTab = "overview";
  @state() private activeTab: PersonalMemoryTab = "overview";
  @state() private menu: {
    lookup: string;
    kind: "memory" | "wiki";
    x: number;
    y: number;
    trigger: HTMLElement | null;
  } | null = null;
  @state() private promotionLookup = "";
  @state() private deleteTarget: { kind: "memory" | "wiki"; path: string } | null = null;
  @state() private actionMessage = "";
  @state() private refreshRevision = 0;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override connectedCallback() {
    super.connectedCallback();
    this.activeTab = this.initialTab;
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("agentId") || this.context.gateway.snapshot.phase !== "connected") {
      this.menu = null;
      this.promotionLookup = "";
      this.deleteTarget = null;
      this.actionMessage = "";
    }
    if (changed.has("initialTab") && this.activeTab !== this.initialTab) {
      this.activeTab = this.initialTab;
    }
  }

  private selectTab(tab: PersonalMemoryTab) {
    const routeTab: MemoryRouteTab =
      tab === "memory" ? "memories" : tab === "dreaming" ? "dreams" : tab;
    this.context.navigate("memory", {
      pathname: pathForMemoryTab(routeTab, this.context.basePath),
    });
  }

  private availableActions(kind: "memory" | "wiki"): MemoryMenuAction[] {
    const gateway = this.context.gateway.snapshot;
    if (gateway.phase !== "connected") {
      return [];
    }
    const has = (methods: string[]) =>
      methods.every((method) => isGatewayMethodAdvertised(gateway, method) === true);
    const actions: MemoryMenuAction[] = [];
    if (
      kind === "wiki" &&
      has(["platformclaw.memory.promotion.submit", "platformclaw.memory.lifecycle", "wiki.get"])
    ) {
      actions.push("share");
    }
    if (
      has(kind === "wiki" ? ["wiki.delete", "wiki.get"] : ["memory.delete", "agents.workspace.get"])
    ) {
      actions.push("delete");
    }
    return actions;
  }

  private openActions(kind: "memory" | "wiki", lookup: string, event: MouseEvent) {
    if (this.availableActions(kind).length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const bounds = target instanceof Element ? target.getBoundingClientRect() : null;
    this.menu = {
      kind,
      lookup,
      x: event.type === "contextmenu" ? event.clientX : (bounds?.left ?? 0),
      y: event.type === "contextmenu" ? event.clientY : (bounds?.bottom ?? 0),
      trigger: target instanceof HTMLElement ? target : null,
    };
  }

  private renderActions() {
    const gateway = this.context.gateway.snapshot;
    const menu = this.menu;
    return html`
      ${menu
        ? html`<platformclaw-memory-item-menu
            .x=${menu.x}
            .y=${menu.y}
            .trigger=${menu.trigger}
            .actions=${this.availableActions(menu.kind)}
            .kind=${menu.kind}
            .onClose=${() => (this.menu = null)}
            .onAction=${(action: MemoryMenuAction) => {
              if (!this.availableActions(menu.kind).includes(action)) {
                return;
              }
              this.actionMessage = "";
              if (action === "delete") {
                this.deleteTarget = { kind: menu.kind, path: menu.lookup };
              } else {
                this.promotionLookup = menu.lookup;
              }
            }}
          ></platformclaw-memory-item-menu>`
        : nothing}
      ${this.promotionLookup
        ? html`<openclaw-modal-dialog
            label=${t("platformClaw.memory.share")}
            style="--openclaw-modal-width: 800px"
            @modal-cancel=${() => (this.promotionLookup = "")}
            ><div class="settings-page platformclaw-memory-action-dialog">
              <button class="btn" @click=${() => (this.promotionLookup = "")}>
                ${t("common.close")}
              </button>
              <openclaw-memory-promotions
                .client=${gateway.client}
                .connected=${gateway.phase === "connected"}
                .methodAdvertised=${isGatewayMethodAdvertised(
                  gateway,
                  "platformclaw.memory.lifecycle",
                ) === true}
                .wikiSearchAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.search") === true}
                .wikiGetAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.get") === true}
                .agentId=${this.agentId}
                .initialPersonalLookup=${this.promotionLookup}
                .formOnly=${true}
                @promotion-submitted=${(event: CustomEvent<{ message: string }>) => {
                  this.promotionLookup = "";
                  this.actionMessage = event.detail.message;
                }}
              ></openclaw-memory-promotions></div
          ></openclaw-modal-dialog>`
        : nothing}
      ${this.deleteTarget
        ? html`<platformclaw-memory-delete-dialog
            .client=${gateway.client}
            .agentId=${this.agentId ?? ""}
            .path=${this.deleteTarget.path}
            .kind=${this.deleteTarget.kind}
            @delete-cancel=${() => (this.deleteTarget = null)}
            @memory-deleted=${(
              event: CustomEvent<{
                kind: "memory" | "wiki";
                indexesRefreshed: boolean;
                wikiRefreshed?: boolean;
              }>,
            ) => {
              this.deleteTarget = null;
              this.refreshRevision++;
              this.actionMessage = t(
                event.detail.kind === "wiki"
                  ? event.detail.indexesRefreshed
                    ? "platformClaw.wiki.deleted"
                    : "platformClaw.wiki.deletedRefreshPending"
                  : event.detail.indexesRefreshed && event.detail.wikiRefreshed
                    ? "platformClaw.memory.deleted"
                    : "platformClaw.memory.deletedRefreshPending",
              );
            }}
          ></platformclaw-memory-delete-dialog>`
        : nothing}
    `;
  }

  private renderOverview() {
    return html`
      <div class="settings-page platformclaw-memory-overview">
        ${renderSettingsSection(
          {
            title: t("platformClaw.memory.overview.title"),
            description: t("platformClaw.memory.overview.description"),
          },
          html`
            ${renderSettingsRow({
              title: "MEMORY.md",
              description: t("platformClaw.memory.overview.memoryDescription"),
              control: html`<button class="btn btn--sm" @click=${() => this.selectTab("memory")}>
                ${t("platformClaw.memory.overview.openMemory")}
              </button>`,
            })}
            ${renderSettingsRow({
              title: "Personal Wiki",
              description: t("platformClaw.memory.overview.wikiDescription"),
              control: html`<button class="btn btn--sm" @click=${() => this.selectTab("wiki")}>
                ${t("platformClaw.memory.overview.openWiki")}
              </button>`,
            })}
            ${renderSettingsRow({
              title: t("platformClaw.memory.tabs.organization"),
              description: t("platformClaw.memory.overview.organizationDescription"),
              control: html`<button
                class="btn btn--sm"
                @click=${() => this.selectTab("organization")}
              >
                ${t("platformClaw.memory.overview.openOrganization")}
              </button>`,
            })}
            ${renderSettingsRow({
              title: "Dreaming",
              description: t("platformClaw.memory.overview.dreamingDescription"),
              control: html`<button class="btn btn--sm" @click=${() => this.selectTab("dreaming")}>
                ${t("platformClaw.memory.overview.openDreaming")}
              </button>`,
            })}
          `,
        )}
        <openclaw-agent-memory-panel
          .agentId=${this.agentId ?? ""}
          .summaryOnly=${true}
        ></openclaw-agent-memory-panel>
      </div>
    `;
  }

  private renderPanel() {
    const gateway = this.context.gateway.snapshot;
    switch (this.activeTab) {
      case "memory":
        return html`<openclaw-memory-memories
          .client=${gateway.client}
          .connected=${gateway.phase === "connected"}
          .connectionPhase=${gateway.phase}
          .methodAdvertised=${isGatewayMethodAdvertised(gateway, "memory.search")}
          .wikiSearchAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.search")}
          .browseEnabled=${true}
          .browseListAdvertised=${isGatewayMethodAdvertised(gateway, "agents.workspace.list")}
          .personalDetailAdvertised=${isGatewayMethodAdvertised(gateway, "agents.workspace.get")}
          .wikiGetAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.get")}
          .organizationGetAdvertised=${isGatewayMethodAdvertised(
            gateway,
            "platformclaw.memory.get",
          )}
          .translator=${t}
          .refreshRevision=${this.refreshRevision}
          .itemActions=${{
            label: t("platformClaw.memory.actions"),
            available: (result: SearchResult) =>
              isExpandableResult(result) &&
              (result.source === "memory" || result.source === "wiki") &&
              this.availableActions(result.source).length > 0,
            open: (result: SearchResult, event: MouseEvent) =>
              this.openActions(result.source as "memory" | "wiki", result.path, event),
          }}
          .agentId=${this.agentId}
        ></openclaw-memory-memories>`;
      case "wiki":
        return html`<openclaw-agent-memory-panel
          .agentId=${this.agentId ?? ""}
          surface="wiki"
          .refreshRevision=${this.refreshRevision}
          .wikiActions=${this.availableActions("wiki").length > 0
            ? {
                label: t("platformClaw.memory.actions"),
                open: (lookup: string, event: MouseEvent) =>
                  this.openActions("wiki", lookup, event),
              }
            : undefined}
        ></openclaw-agent-memory-panel>`;
      case "organization":
        return html`<platformclaw-memory-organization
          .client=${gateway.client}
          .connected=${gateway.phase === "connected"}
          .lifecycleAdvertised=${isGatewayMethodAdvertised(
            gateway,
            "platformclaw.memory.lifecycle",
          ) === true}
          .graphAdvertised=${isGatewayMethodAdvertised(gateway, "platformclaw.memory.graph") ===
          true}
          .wikiSearchAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.search") === true}
          .wikiGetAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.get") === true}
          .organizationGetAdvertised=${isGatewayMethodAdvertised(
            gateway,
            "platformclaw.memory.get",
          ) === true}
          .agentId=${this.agentId}
        ></platformclaw-memory-organization>`;
      case "dreaming":
        return html`<openclaw-agent-memory-panel
          .agentId=${this.agentId ?? ""}
          surface="dreaming"
        ></openclaw-agent-memory-panel>`;
      default:
        return this.renderOverview();
    }
  }

  override render() {
    if (!this.agentId) {
      return html`<main class="settings-page">
        <div class="card" role="status">
          <div class="card-title">${t("platformClaw.memory.unavailable")}</div>
          <div class="muted">${t("platformClaw.memory.unassigned")}</div>
        </div>
      </main>`;
    }
    return html`
      <main class="settings-page platformclaw-memory-page">
        ${this.actionMessage ? html`<p role="status">${this.actionMessage}</p>` : nothing}
        <nav class="platformclaw-memory-page__tabs">
          ${renderHubTabs<PersonalMemoryTab>({
            id: "platformclaw-memory",
            active: this.activeTab,
            tabs: [
              { value: "overview", label: t("platformClaw.memory.tabs.overview") },
              { value: "memory", label: "Memory" },
              { value: "wiki", label: "Personal Wiki" },
              { value: "organization", label: t("platformClaw.memory.tabs.organization") },
              { value: "dreaming", label: "Dreaming" },
            ],
            ariaLabel: t("platformClaw.memory.tabs.label"),
            panelId: PANEL_ID,
            onSelect: (tab) => this.selectTab(tab),
          })}
        </nav>
        <section
          id=${PANEL_ID}
          class="platformclaw-memory-page__panel"
          role="tabpanel"
          aria-labelledby=${`platformclaw-memory-tab-${this.activeTab}`}
        >
          ${this.renderPanel()}
        </section>
        ${this.renderActions()}
      </main>
    `;
  }
}

if (!customElements.get("platformclaw-memory-page")) {
  customElements.define("platformclaw-memory-page", PlatformClawMemoryPage);
}
