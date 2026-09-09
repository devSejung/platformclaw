import { html } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../pages/config/memory-promotions.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

type OrganizationView = "sharing" | "graph";

class PlatformClawMemoryOrganization extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) lifecycleAdvertised = false;
  @property({ type: Boolean }) graphAdvertised = false;
  @property({ type: Boolean }) wikiSearchAdvertised = false;
  @property({ type: Boolean }) wikiGetAdvertised = false;
  @property({ type: Boolean }) organizationGetAdvertised = false;
  @property() agentId: string | null = null;

  @state() private activeView: OrganizationView = "sharing";
  @state() private graphModuleReady = false;
  private graphModuleLoad: Promise<unknown> | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  private selectView(view: OrganizationView) {
    this.activeView = view;
    if (view === "graph" && !this.graphModuleReady) {
      this.graphModuleLoad ??= import("./organization-memory-graph.ts");
      void this.graphModuleLoad.then(() => {
        this.graphModuleReady = true;
      });
    }
  }

  override render() {
    return html`
      <div class="platformclaw-memory-organization">
        ${renderHubTabs<OrganizationView>({
          id: "platformclaw-memory-organization",
          active: this.activeView,
          tabs: [
            { value: "sharing", label: t("platformClaw.memory.organization.sharing") },
            { value: "graph", label: t("platformClaw.memory.organization.graph") },
          ],
          ariaLabel: t("platformClaw.memory.organization.views"),
          panelId: "platformclaw-memory-organization-panel",
          variant: "sub",
          onSelect: (view) => this.selectView(view),
        })}
        <div id="platformclaw-memory-organization-panel" role="tabpanel">
          ${this.activeView === "sharing"
            ? html`<openclaw-memory-promotions
                .client=${this.client}
                .connected=${this.connected}
                .methodAdvertised=${this.lifecycleAdvertised}
                .wikiSearchAdvertised=${this.wikiSearchAdvertised}
                .wikiGetAdvertised=${this.wikiGetAdvertised}
                .agentId=${this.agentId}
              ></openclaw-memory-promotions>`
            : this.graphModuleReady
              ? html`<platformclaw-organization-memory-graph
                  .client=${this.client}
                  .connected=${this.connected}
                  .methodAdvertised=${this.graphAdvertised}
                  .getAdvertised=${this.organizationGetAdvertised}
                  .agentId=${this.agentId}
                ></platformclaw-organization-memory-graph>`
              : html`<p class="memory-promotions__empty" role="status">
                  ${t("platformClaw.memory.organization.graphLoading")}
                </p>`}
        </div>
      </div>
    `;
  }
}

if (!customElements.get("platformclaw-memory-organization")) {
  customElements.define("platformclaw-memory-organization", PlatformClawMemoryOrganization);
}
