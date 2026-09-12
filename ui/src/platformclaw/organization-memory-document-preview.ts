import { formatErrorMessage } from "@openclaw/normalization-core";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { OrganizationMemoryDocument } from "../../../packages/platformclaw-control-plane/src/contracts.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { toSanitizedMarkdownHtml } from "../components/markdown.ts";
import "../components/modal-dialog.ts";
import "../styles/dreams.css";
import { redactToolDetail } from "../lib/browser-redact.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { loadPlatformClawLocale, platformClawT as t } from "./i18n.ts";

type BrowserOrganizationMemoryDocument = Pick<
  OrganizationMemoryDocument,
  | "path"
  | "title"
  | "content"
  | "fromLine"
  | "lineCount"
  | "verification"
  | "totalLines"
  | "textTruncated"
> & {
  kind: OrganizationMemoryDocument["scopeKind"];
  provenanceLabel: string;
  updatedAt: string;
};

export function isOrganizationMemoryPath(path: string): boolean {
  return /^organization\/(?:part|group|team|global)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(path);
}

export function renderOrganizationMemoryDocumentPreview(
  props: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    getAdvertised: boolean;
    agentId: string | null;
  },
  path: string | null,
  onClose: () => void,
) {
  return html`<platformclaw-organization-memory-document-preview
    .client=${props.client}
    .connected=${props.connected}
    .getAdvertised=${props.getAdvertised}
    .agentId=${props.agentId}
    .path=${path}
    @document-preview-close=${onClose}
  ></platformclaw-organization-memory-document-preview>`;
}

class OrganizationMemoryDocumentPreview extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) getAdvertised = false;
  @property() agentId: string | null = null;
  @property() path: string | null = null;
  @state() private document: BrowserOrganizationMemoryDocument | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private fromLine = 1;
  private epoch = 0;

  override connectedCallback() {
    super.connectedCallback();
    void loadPlatformClawLocale().then(() => this.requestUpdate());
  }

  override willUpdate(changed: PropertyValues) {
    if (
      ["client", "connected", "getAdvertised", "agentId", "path"].some((key) => changed.has(key))
    ) {
      this.fromLine = 1;
      void this.load();
    }
  }
  override disconnectedCallback() {
    this.epoch += 1;
    super.disconnectedCallback();
  }
  private async load() {
    const epoch = ++this.epoch;
    this.document = null;
    this.error = null;
    this.loading = false;
    const { client, agentId, path } = this;
    if (
      !client ||
      !agentId ||
      !this.connected ||
      !this.getAdvertised ||
      !path ||
      !isOrganizationMemoryPath(path)
    ) {
      this.error = t("platformClaw.memory.organization.graphPreviewMissing");
      return;
    }
    this.loading = true;
    try {
      const document = await client.request<BrowserOrganizationMemoryDocument | null>(
        "platformclaw.memory.get",
        { agentId, path, fromLine: this.fromLine, lineCount: 200 },
      );
      if (epoch !== this.epoch) {
        return;
      }
      this.document = document;
      if (!document) {
        this.error = t("platformClaw.memory.organization.graphPreviewMissing");
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.error = formatErrorMessage(error, { redact: redactToolDetail });
      }
    } finally {
      if (epoch === this.epoch) {
        this.loading = false;
      }
    }
  }
  private close() {
    this.epoch += 1;
    this.dispatchEvent(new CustomEvent("document-preview-close", { bubbles: true }));
  }
  private selectPage(fromLine: number) {
    this.fromLine = fromLine;
    void this.load();
  }
  override render() {
    if (!this.path || !isOrganizationMemoryPath(this.path)) {
      return nothing;
    }
    const verification = this.document?.verification;
    return html`<openclaw-modal-dialog
      .label=${this.document?.title ?? t("platformClaw.memory.organization.graphPreview")}
      style="--openclaw-modal-width: 1120px"
      @modal-cancel=${(event: Event) => {
        event.stopPropagation();
        this.close();
      }}
    >
      <div class="organization-memory-graph__preview dreams-diary__preview-panel">
        <header class="dreams-diary__preview-header wiki-document__header">
          <div class="wiki-document__heading">
            <div class="dreams-diary__preview-title">
              ${this.document?.title ?? t("platformClaw.memory.organization.graphPreview")}
            </div>
            <div class="dreams-diary__preview-meta">
              ${this.document?.kind} · ${this.document?.provenanceLabel} ·
              ${t("platformClaw.memory.organization.readerReadOnly")}
            </div>
          </div>
          <div class="wiki-document__actions">
            <button
              class="btn btn--subtle btn--sm"
              type="button"
              aria-label=${t("common.close")}
              @click=${() => this.close()}
            >
              ${t("common.close")}
            </button>
          </div>
        </header>
        <div class="organization-memory-graph__preview-body dreams-diary__preview-body">
          ${this.loading
            ? html`<p role="status">
                ${t("platformClaw.memory.organization.graphPreviewLoading")}
              </p>`
            : this.error
              ? html`<p role="alert">${this.error}</p>`
              : html`<div class="organization-memory-graph__preview-meta">
                    ${this.document?.path}
                  </div>
                  ${verification
                    ? html`<p data-memory-verification>
                        ${t("platformClaw.memory.graph.approved")} ·
                        ${t("platformClaw.memory.graph.revision", {
                          revision: String(verification.revision),
                        })}
                        ·
                        ${t("platformClaw.memory.graph.sourceRevision", {
                          revision: String(verification.sourceRevision),
                        })}
                        · ${t(`platformClaw.memory.graph.${verification.sourceStatus}`)}
                      </p>`
                    : html`<p>${t("platformClaw.memory.graph.unverified")}</p>`}
                  <article
                    class="md-preview-dialog__reader sidebar-markdown wiki-document__reader"
                    @click=${(event: MouseEvent) => {
                      const anchor = (event.target as Element).closest<HTMLAnchorElement>(
                        "a[href], [data-wiki-lookup]",
                      );
                      if (!anchor) {
                        return;
                      }
                      const path = anchor.dataset.wikiLookup ?? anchor.getAttribute("href") ?? "";
                      if (!anchor.dataset.wikiLookup && /^(?:https?:|#)/iu.test(path)) {
                        return;
                      }
                      event.preventDefault();
                      if (isOrganizationMemoryPath(path)) {
                        this.path = path;
                      }
                    }}
                  >
                    ${unsafeHTML(
                      toSanitizedMarkdownHtml(this.document?.content ?? "", {
                        codeBlockChrome: "none",
                        fileLinks: false,
                        interactiveImages: false,
                        wikiLinks: true,
                      }),
                    )}
                  </article>`}
        </div>
        ${this.document &&
        (this.fromLine > 1 ||
          (this.document.totalLines ?? 0) > this.document.lineCount ||
          this.document.textTruncated)
          ? html`<footer class="organization-memory-graph__reader-pages">
              <span
                >${t("platformClaw.memory.organization.readerExcerpt", {
                  from: String(this.document.fromLine),
                  to: String(this.document.fromLine + this.document.lineCount - 1),
                  total: String(this.document.totalLines ?? "?"),
                })}</span
              >
              ${this.document.textTruncated
                ? html`<span>${t("platformClaw.memory.organization.readerTextTruncated")}</span>`
                : nothing}
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${this.loading || this.fromLine === 1}
                @click=${() => this.selectPage(Math.max(1, this.fromLine - 200))}
              >
                ${t("platformClaw.memory.organization.readerPrevious")}
              </button>
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${this.loading ||
                this.fromLine + this.document.lineCount > (this.document.totalLines ?? 0)}
                @click=${() => this.selectPage(this.fromLine + this.document!.lineCount)}
              >
                ${t("platformClaw.memory.organization.readerNext")}
              </button>
            </footer>`
          : nothing}
      </div>
    </openclaw-modal-dialog>`;
  }
}
if (!customElements.get("platformclaw-organization-memory-document-preview")) {
  customElements.define(
    "platformclaw-organization-memory-document-preview",
    OrganizationMemoryDocumentPreview,
  );
}
