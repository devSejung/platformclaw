import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { redactToolDetail } from "../../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "../../platformclaw/i18n.ts";

type WikiSearchResult = {
  id?: string;
  path: string;
  title: string;
  snippet: string;
};

type WikiPage = {
  id?: string;
  path: string;
  title?: string;
  content: string;
  truncated?: boolean;
};

export type PersonalWikiSourceSelected = {
  lookup: string;
  title: string;
  content: string;
  path: string;
};

class MemoryPromotionSourcePickerElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) searchAdvertised = false;
  @property({ type: Boolean }) getAdvertised = false;
  @property() agentId: string | null = null;
  @state() private query = "";
  @state() private results: WikiSearchResult[] = [];
  @state() private selected: WikiPage | null = null;
  @state() private loading = false;
  @state() private searched = false;
  @state() private error: string | null = null;
  private searchRequest: object | null = null;
  private selectionRequest: object | null = null;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  protected override updated(changed: PropertyValues<this>) {
    if (
      changed.has("agentId") ||
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("searchAdvertised") ||
      changed.has("getAdvertised")
    ) {
      this.searchRequest = null;
      this.selectionRequest = null;
      this.query = "";
      this.results = [];
      this.selected = null;
      this.searched = false;
      this.error = null;
      this.loading = false;
    }
  }

  private async search(event: Event) {
    event.preventDefault();
    const query = this.query.trim();
    if (
      !this.client ||
      !this.connected ||
      !this.searchAdvertised ||
      !this.getAdvertised ||
      !this.agentId ||
      !query
    ) {
      return;
    }
    const request = {};
    this.searchRequest = request;
    this.loading = true;
    this.searched = true;
    this.error = null;
    try {
      const results = await this.client.request<WikiSearchResult[]>("wiki.search", {
        agentId: this.agentId,
        query,
        maxResults: 20,
      });
      if (this.searchRequest !== request) {
        return;
      }
      this.results = results;
    } catch (error) {
      if (this.searchRequest !== request) {
        return;
      }
      this.results = [];
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      if (this.searchRequest === request) {
        this.searchRequest = null;
        this.loading = false;
      }
    }
  }

  private async select(result: WikiSearchResult) {
    if (!this.client || !this.agentId) {
      return;
    }
    const request = {};
    this.selectionRequest = request;
    this.loading = true;
    this.error = null;
    try {
      const page = await this.client.request<WikiPage>("wiki.get", {
        agentId: this.agentId,
        lookup: result.id ?? result.path,
        fromLine: 1,
        lineCount: 5_000,
      });
      if (this.selectionRequest !== request) {
        return;
      }
      if (page.truncated) {
        throw new Error(t("memoryPage.promotions.sourceIncomplete"));
      }
      this.selected = page;
      this.dispatchEvent(
        new CustomEvent<PersonalWikiSourceSelected>("source-selected", {
          bubbles: true,
          composed: true,
          detail: {
            lookup: page.id ?? page.path,
            title: page.title ?? result.title,
            content: page.content,
            path: page.path,
          },
        }),
      );
    } catch (error) {
      if (this.selectionRequest !== request) {
        return;
      }
      this.selected = null;
      this.error = formatErrorMessage(error, { redact: redactToolDetail });
    } finally {
      if (this.selectionRequest === request) {
        this.selectionRequest = null;
        this.loading = false;
      }
    }
  }

  override render() {
    return html`<section class="memory-source-picker" aria-labelledby="memory-source-title">
      <h4 id="memory-source-title">${t("memoryPage.promotions.personalSourceTitle")}</h4>
      <p class="muted">${t("memoryPage.promotions.personalSourceHelp")}</p>
      ${!this.searchAdvertised || !this.getAdvertised
        ? html`<p class="memory-source-picker__state" role="status">
            ${t("memoryPage.promotions.wikiUnavailable")}
          </p>`
        : nothing}
      <form class="memory-source-picker__search" @submit=${this.search}>
        <label class="sr-only" for="memory-source-query"
          >${t("memoryPage.promotions.searchPersonalWiki")}</label
        >
        <input
          id="memory-source-query"
          class="settings-input"
          .value=${this.query}
          placeholder=${t("memoryPage.promotions.searchPersonalWiki")}
          @input=${(event: InputEvent) =>
            (this.query = (event.currentTarget as HTMLInputElement).value)}
        />
        <button
          class="btn btn--sm"
          ?disabled=${this.loading ||
          !this.searchAdvertised ||
          !this.getAdvertised ||
          !this.query.trim()}
        >
          ${t("memoryPage.promotions.search")}
        </button>
      </form>
      ${this.loading
        ? html`<p role="status">${t("memoryPage.promotions.sourceLoading")}</p>`
        : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${this.searched && !this.loading && !this.error && this.results.length === 0
        ? html`<p role="status">${t("memoryPage.promotions.sourceEmpty")}</p>`
        : nothing}
      ${this.results.length > 0
        ? html`<div class="memory-source-picker__results">
            ${this.results.map(
              (result) => html`<button
                type="button"
                class="settings-row settings-row--nav memory-source-picker__result"
                aria-pressed=${this.selected?.path === result.path ? "true" : "false"}
                @click=${() => void this.select(result)}
              >
                <strong>${result.title}</strong><span>${result.path}</span
                ><small>${result.snippet}</small>
              </button>`,
            )}
          </div>`
        : nothing}
      ${this.selected
        ? html`<article class="memory-source-picker__preview">
            <h5>${t("memoryPage.promotions.sourcePreview")}: ${this.selected.title}</h5>
            <pre>${this.selected.content}</pre>
          </article>`
        : nothing}
    </section>`;
  }
}

if (!customElements.get("openclaw-memory-promotion-source-picker")) {
  customElements.define(
    "openclaw-memory-promotion-source-picker",
    MemoryPromotionSourcePickerElement,
  );
}
