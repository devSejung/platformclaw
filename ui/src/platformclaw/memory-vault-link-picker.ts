import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { platformClawT } from "./i18n.ts";

type DocumentTarget = { documentId: string; title: string; logicalPath: string; link: string };
const t = (key: string) => platformClawT(`platformClaw.vault.${key}`);

/** Search and selection only. The author owns the draft and saved caret. */
class PlatformClawVaultLinkPicker extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() vaultId = "";
  @state() private query = "";
  @state() private items: DocumentTarget[] = [];
  @state() private hasMore = false;
  @state() private busy = false;
  @state() private error = "";
  private epoch = 0;

  protected override updated(changed: PropertyValues) {
    if (changed.has("client") || changed.has("vaultId")) {
      this.epoch++;
      this.query = "";
      this.items = [];
      if (this.client && this.vaultId) {
        void this.search();
      }
    }
  }
  override disconnectedCallback() {
    this.epoch++;
    super.disconnectedCallback();
  }
  private async search() {
    if (!this.client || !this.vaultId) {
      return;
    }
    const epoch = ++this.epoch;
    this.busy = true;
    this.error = "";
    try {
      const result = await this.client.request<{ items: DocumentTarget[]; hasMore: boolean }>(
        "platformclaw.vault.document.targets",
        { vaultId: this.vaultId, query: this.query.trim() },
      );
      if (epoch === this.epoch) {
        this.items = result.items;
        this.hasMore = result.hasMore;
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.busy = false;
      }
    }
  }
  override render() {
    return html`<section class="vaults__form" aria-label=${t("insertLink")}>
      <p class="vaults__hint">${t("linkPickerHint")}</p>
      <form
        class="vaults__actions"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          void this.search();
        }}
      >
        <input
          class="settings-input"
          type="search"
          maxlength="160"
          aria-label=${t("findLinkDocument")}
          placeholder=${t("findLinkDocument")}
          .value=${this.query}
          @input=${(event: Event) => (this.query = (event.currentTarget as HTMLInputElement).value)}
        />
        <button class="btn" ?disabled=${this.busy}>${t("searchTargets")}</button>
      </form>
      ${this.busy
        ? html`<p role="status">${t("loading")}</p>`
        : this.error
          ? html`<p class="callout danger" role="alert">${this.error}</p>
              <button class="btn" @click=${() => void this.search()}>
                ${platformClawT("memoryPage.memories.retry")}
              </button>`
          : html` ${this.items.length
              ? html`<div class="settings-group">
                  ${this.items.map(
                    (item) =>
                      html`<button
                        type="button"
                        class="settings-row settings-row--nav"
                        @click=${() =>
                          this.dispatchEvent(
                            new CustomEvent("link-selected", { bubbles: true, detail: item.link }),
                          )}
                      >
                        <span class="settings-row__text"
                          ><span class="settings-row__title">${item.title}</span
                          ><span class="settings-row__desc">${item.logicalPath}</span></span
                        ><span class="settings-row__control">${t("insertLinkAction")}</span>
                      </button>`,
                  )}
                </div>`
              : html`<p role="status">${t("noLinkDocuments")}</p>`}
            ${this.hasMore ? html`<p class="vaults__hint">${t("linkMoreResults")}</p>` : nothing}`}
      <button
        class="btn"
        type="button"
        @click=${() => this.dispatchEvent(new CustomEvent("link-cancel", { bubbles: true }))}
      >
        ${t("backToDraft")}
      </button>
    </section>`;
  }
}
if (!customElements.get("platformclaw-vault-link-picker")) {
  customElements.define("platformclaw-vault-link-picker", PlatformClawVaultLinkPicker);
}
