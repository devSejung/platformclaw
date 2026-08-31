import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
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
import "../pages/config/memory-promotions.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

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
          .translate=${t}
          .agentId=${this.agentId}
        ></openclaw-memory-memories>`;
      case "wiki":
        return html`<openclaw-agent-memory-panel
          .agentId=${this.agentId ?? ""}
          surface="wiki"
        ></openclaw-agent-memory-panel>`;
      case "organization":
        return html`<openclaw-memory-promotions
          .client=${gateway.client}
          .connected=${gateway.phase === "connected"}
          .methodAdvertised=${isGatewayMethodAdvertised(
            gateway,
            "platformclaw.memory.lifecycle",
          ) === true}
          .wikiSearchAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.search") === true}
          .wikiGetAdvertised=${isGatewayMethodAdvertised(gateway, "wiki.get") === true}
          .agentId=${this.agentId}
        ></openclaw-memory-promotions>`;
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
      </main>
    `;
  }
}

if (!customElements.get("platformclaw-memory-page")) {
  customElements.define("platformclaw-memory-page", PlatformClawMemoryPage);
}
