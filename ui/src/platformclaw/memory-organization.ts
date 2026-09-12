import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { OrganizationKnowledgeSnapshotResponse } from "../../../packages/platformclaw-control-plane/src/organization-memory-knowledge-contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { renderHubTabs } from "../components/hub-tabs.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "../pages/config/memory-promotions.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

type OrganizationView = "sharing" | "graph" | "knowledge";

class PlatformClawMemoryOrganization extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) lifecycleAdvertised = false;
  @property({ type: Boolean }) graphAdvertised = false;
  @property({ type: Boolean }) wikiSearchAdvertised = false;
  @property({ type: Boolean }) wikiGetAdvertised = false;
  @property({ type: Boolean }) comparisonAdvertised = false;
  @property({ type: Boolean }) referencesAdvertised = false;
  @property({ type: Boolean }) organizationGetAdvertised = false;
  @property({ type: Boolean }) knowledgeAdvertised = false;
  @property({ type: Boolean }) knowledgeGenerateAdvertised = false;
  @property({ type: Boolean }) knowledgeDecideAdvertised = false;
  @property({ type: Boolean }) knowledgeApplyAdvertised = false;
  @property() agentId: string | null = null;

  @state() private activeView: OrganizationView = "sharing";
  @state() private graphModuleReady = false;
  private graphModuleLoad: Promise<unknown> | null = null;
  @state() private knowledgeModuleReady = false;
  private knowledgeModuleLoad: Promise<unknown> | null = null;
  @state() private knowledgeEligible = false;
  private eligibilityEpoch = 0;

  override disconnectedCallback() {
    this.eligibilityEpoch++;
    this.knowledgeEligible = false;
    this.activeView = "sharing";
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues) {
    if (
      ["client", "connected", "agentId", "knowledgeAdvertised"].some((name) => changed.has(name))
    ) {
      const epoch = ++this.eligibilityEpoch;
      this.knowledgeEligible = false;
      this.activeView = "sharing";
      if (!this.client || !this.connected || !this.knowledgeAdvertised) {
        return;
      }
      void this.client
        .request<OrganizationKnowledgeSnapshotResponse>(
          "platformclaw.memory.knowledge.snapshot",
          {},
        )
        .then((response) => {
          if (epoch !== this.eligibilityEpoch || !this.isConnected) {
            return;
          }
          this.knowledgeEligible = response.scopes.some(
            (scope) => scope.capabilities.canReadReport,
          );
        })
        .catch(() => {
          if (epoch === this.eligibilityEpoch) {
            this.knowledgeEligible = false;
            this.activeView = "sharing";
          }
        });
    }
  }

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  private selectView(view: OrganizationView) {
    this.activeView = view;
    if (view === "knowledge" && !this.knowledgeModuleReady) {
      this.knowledgeModuleLoad ??= import("./memory-knowledge-management.ts");
      void this.knowledgeModuleLoad.then(() => {
        this.knowledgeModuleReady = true;
      });
    }
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
            ...(this.knowledgeAdvertised && this.knowledgeEligible
              ? [{ value: "knowledge" as const, label: t("platformClaw.memory.knowledge.title") }]
              : []),
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
                .comparisonAdvertised=${this.comparisonAdvertised}
                .referencesAdvertised=${this.referencesAdvertised}
                .getAdvertised=${this.organizationGetAdvertised}
                .agentId=${this.agentId}
              ></openclaw-memory-promotions>`
            : this.activeView === "knowledge"
              ? this.knowledgeModuleReady
                ? html`<platformclaw-memory-knowledge-management
                    @knowledge-eligibility-change=${(event: CustomEvent<boolean>) => {
                      this.knowledgeEligible = event.detail;
                      if (!event.detail) {
                        this.activeView = "sharing";
                      }
                    }}
                    .client=${this.client}
                    .connected=${this.connected}
                    .methodAdvertised=${this.knowledgeAdvertised}
                    .generateAdvertised=${this.knowledgeGenerateAdvertised}
                    .decideAdvertised=${this.knowledgeDecideAdvertised}
                    .applyAdvertised=${this.knowledgeApplyAdvertised}
                    .agentId=${this.agentId}
                  ></platformclaw-memory-knowledge-management>`
                : html`<p role="status">${t("platformClaw.memory.knowledge.loading")}</p>`
              : this.graphModuleReady
                ? html`<platformclaw-organization-memory-graph
                    .client=${this.client}
                    .connected=${this.connected}
                    .methodAdvertised=${this.graphAdvertised}
                    .inventoryAdvertised=${this.lifecycleAdvertised}
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
