import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import "../components/web-awesome-tabs.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT as t } from "./i18n.ts";
import "./mcp-administration.ts";
import "./mcp-settings.ts";

class PlatformClawMcpPageElement extends OpenClawLightDomElement {
  @property({ type: Boolean }) admin = false;
  @property({ attribute: false }) fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);
  @property({ attribute: false }) onUnauthenticated: () => void = () => {};
  @state() private tab: "administration" | "settings" = "administration";
  protected override render() {
    return html`<style>
        platformclaw-mcp-page {
          display: block;
          min-width: 0;
        }
        platformclaw-mcp-page [hidden] {
          display: none !important;
        }
        .platformclaw-mcp-tabs {
          --track-color: var(--border);
          --indicator-color: var(--accent);
          margin-bottom: 20px;
        }
        .platformclaw-mcp-tabs::part(body) {
          display: none;
        }
        .platformclaw-mcp-tabs::part(tabs) {
          gap: 8px;
          padding-bottom: 10px;
        }
        .platformclaw-mcp-tabs wa-tab::part(base) {
          padding: 8px 12px;
          border: 1px solid transparent;
          border-radius: var(--radius-md);
          color: var(--muted);
          font: inherit;
        }
        .platformclaw-mcp-tabs wa-tab[active]::part(base) {
          background: var(--accent-subtle);
          color: var(--accent);
          border-color: var(--border);
        }
        .platformclaw-mcp-tabs wa-tab:focus-visible::part(base) {
          outline: none;
          box-shadow: var(--focus-ring);
        }
      </style>
      ${this.admin
        ? html`<wa-tab-group
              class="platformclaw-mcp-tabs"
              aria-label=${t("platformClaw.mcp.title")}
              .active=${this.tab}
              without-scroll-controls
              @wa-tab-show=${(event: CustomEvent<{ name: string }>) => {
                if (event.detail.name === "administration" || event.detail.name === "settings") {
                  this.tab = event.detail.name;
                }
              }}
            >
              ${(["administration", "settings"] as const).map(
                (tab) =>
                  html`<wa-tab
                    id=${`mcp-tab-${tab}`}
                    slot="nav"
                    panel=${tab}
                    ?active=${this.tab === tab}
                    aria-controls=${`mcp-panel-${tab}`}
                  >
                    ${t(
                      tab === "administration"
                        ? "platformClaw.mcp.adminTab"
                        : "platformClaw.mcp.mySettingsTab",
                    )}
                  </wa-tab>`,
              )}
            </wa-tab-group>
            <section
              id="mcp-panel-administration"
              role="tabpanel"
              aria-labelledby="mcp-tab-administration"
              ?hidden=${this.tab !== "administration"}
            >
              <platformclaw-mcp-administration
                .fetchImpl=${this.fetchImpl}
                .onUnauthenticated=${this.onUnauthenticated}
              ></platformclaw-mcp-administration>
            </section>`
        : nothing}
      <section
        id="mcp-panel-settings"
        role=${this.admin ? "tabpanel" : nothing}
        aria-labelledby=${this.admin ? "mcp-tab-settings" : nothing}
        ?hidden=${this.admin && this.tab !== "settings"}
      >
        <platformclaw-mcp-settings
          .fetchImpl=${this.fetchImpl}
          .onUnauthenticated=${this.onUnauthenticated}
        ></platformclaw-mcp-settings>
      </section>`;
  }
}
if (!customElements.get("platformclaw-mcp-page")) {
  customElements.define("platformclaw-mcp-page", PlatformClawMcpPageElement);
}
