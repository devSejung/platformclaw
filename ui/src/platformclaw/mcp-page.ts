import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
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
          display: flex;
          gap: 8px;
          margin-bottom: 20px;
          border-bottom: 1px solid var(--border);
          padding-bottom: 10px;
        }
        .platformclaw-mcp-tabs button {
          padding: 8px 12px;
          border: 1px solid transparent;
          border-radius: var(--radius-md);
          background: transparent;
          color: var(--muted);
          font: inherit;
          cursor: pointer;
        }
        .platformclaw-mcp-tabs button[aria-selected="true"] {
          background: var(--accent-subtle);
          color: var(--accent);
          border-color: var(--border);
        }
        .platformclaw-mcp-tabs button:focus-visible {
          outline: none;
          box-shadow: var(--focus-ring);
        }
      </style>
      ${this.admin
        ? html`<div
              class="platformclaw-mcp-tabs"
              role="tablist"
              aria-label=${t("platformClaw.mcp.title")}
            >
              ${(["administration", "settings"] as const).map(
                (tab) =>
                  html`<button
                    id=${`mcp-tab-${tab}`}
                    type="button"
                    role="tab"
                    tabindex=${this.tab === tab ? "0" : "-1"}
                    aria-selected=${String(this.tab === tab)}
                    aria-controls=${`mcp-panel-${tab}`}
                    @click=${() => {
                      this.tab = tab;
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                        return;
                      }
                      event.preventDefault();
                      this.tab =
                        event.key === "Home"
                          ? "administration"
                          : event.key === "End"
                            ? "settings"
                            : this.tab === "administration"
                              ? "settings"
                              : "administration";
                      void this.updateComplete.then(() =>
                        this.querySelector<HTMLElement>(`#mcp-tab-${this.tab}`)?.focus(),
                      );
                    }}
                  >
                    ${t(
                      tab === "administration"
                        ? "platformClaw.mcp.adminTab"
                        : "platformClaw.mcp.mySettingsTab",
                    )}
                  </button>`,
              )}
            </div>
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
