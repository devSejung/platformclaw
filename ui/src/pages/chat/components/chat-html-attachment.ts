import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { generateUUID } from "../../../lib/uuid.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";

const HTML_PREVIEW_READY_TIMEOUT_MS = 15_000;
const HTML_PREVIEW_MESSAGE_TYPE = "openclaw:html-attachment-preview";

export function isHtmlAttachment(mimeType: string | undefined, filename: string): boolean {
  return (
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/html" || /\.html?$/iu.test(filename)
  );
}

/** A preview never receives file paths, widget grants, or the parent application's origin. */
class ChatHtmlAttachment extends OpenClawLightDomElement {
  @property() src = "";
  @property() label = "";
  @property() sourceIdentity = "";
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  @state() private opened = false;
  @state() private status: "loading" | "ready" | "error" = "loading";
  @state() private error = "";

  private requestNonce = "";
  private previewUrl = "";
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onPreviewMessage);
    if (this.opened) {
      this.resetPreview();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener("message", this.onPreviewMessage);
    clearTimeout(this.readyTimer);
    this.requestNonce = "";
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("sourceIdentity")) {
      this.opened = false;
    }
    if (changed.has("src") || changed.has("sourceIdentity") || changed.has("embedSandboxMode")) {
      this.resetPreview();
    }
  }

  private resetPreview(): void {
    clearTimeout(this.readyTimer);
    this.requestNonce = "";
    this.previewUrl = "";
    this.status = "loading";
    this.error = "";
    if (!this.opened) {
      return;
    }
    const href = safeAttachmentHref(this.src);
    if (!href) {
      this.status = "error";
      return;
    }
    const url = new URL(href, window.location.href);
    // Only the managed attachment route implements the response CSP and readiness contract.
    // Never embed arbitrary external documents using this component's script permission.
    if (
      !/^https?:$/u.test(url.protocol) ||
      !/\/api\/chat\/media\/outgoing\/[^/]+\/[^/]+\/full$/u.test(url.pathname)
    ) {
      this.status = "error";
      return;
    }
    this.requestNonce = generateUUID();
    url.searchParams.set("preview", "1");
    url.searchParams.set("previewNonce", this.requestNonce);
    url.searchParams.set("previewMode", this.embedSandboxMode === "strict" ? "strict" : "scripts");
    this.previewUrl = url.toString();
    this.readyTimer = setTimeout(() => {
      this.status = "error";
      this.previewUrl = "";
      this.onMediaLoaded?.();
    }, HTML_PREVIEW_READY_TIMEOUT_MS);
  }

  private readonly togglePreview = (): void => {
    this.opened = !this.opened;
    this.resetPreview();
    this.onMediaLoaded?.();
  };

  private readonly onPreviewMessage = (event: MessageEvent): void => {
    const frame = this.querySelector<HTMLIFrameElement>("iframe");
    if (!this.opened || !this.requestNonce || !frame || event.source !== frame.contentWindow) {
      return;
    }
    // An opaque frame has no trusted origin. Its current window and request nonce bind
    // status only; transferred ports must never become a widget/host capability bridge.
    for (const port of event.ports) {
      port.close();
    }
    const data = event.data as Record<string, unknown> | null;
    if (
      !data ||
      data.type !== HTML_PREVIEW_MESSAGE_TYPE ||
      data.nonce !== this.requestNonce ||
      (data.status !== "ready" && data.status !== "error")
    ) {
      return;
    }
    clearTimeout(this.readyTimer);
    this.status = data.status;
    this.error = typeof data.message === "string" ? data.message.slice(0, 500) : "";
    if (this.status === "error") {
      this.previewUrl = "";
    }
    this.onMediaLoaded?.();
  };

  override render() {
    const href = safeAttachmentHref(this.src);
    return html`
      <div class="chat-assistant-attachment-card chat-html-attachment">
        <div class="chat-assistant-attachment-card__header">
          <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
          ${href
            ? html`<a
                class="chat-assistant-attachment-card__title chat-assistant-attachment-card__link"
                href=${href}
                target="_blank"
                rel="noreferrer"
                >${this.label}</a
              >`
            : html`<span class="chat-assistant-attachment-card__title">${this.label}</span>`}
          <div class="chat-assistant-attachment-card__actions">
            <button
              class="btn btn--sm"
              type="button"
              aria-expanded=${this.opened}
              @click=${this.togglePreview}
            >
              ${t(
                this.opened ? "chat.attachments.closeHtmlPreview" : "chat.attachments.previewHtml",
              )}
            </button>
            ${href
              ? html`<a
                  class="chat-assistant-attachment-card__link"
                  href=${href}
                  target="_blank"
                  rel="noreferrer"
                  >${t("chat.toolCards.downloadFile")}</a
                >`
              : nothing}
          </div>
        </div>
        ${this.opened
          ? html`
              ${this.status === "loading"
                ? html`<div role="status">${t("common.loading")}</div>`
                : nothing}
              ${this.status === "error"
                ? html`<div class="chat-assistant-attachment-card__reason" role="status">
                    ${this.error || t("chat.attachments.htmlPreviewUnavailable")}
                  </div>`
                : nothing}
              ${this.previewUrl
                ? keyed(
                    this.requestNonce,
                    html`<iframe
                      class=${`chat-html-attachment__frame${
                        this.status !== "ready" ? " chat-html-attachment__frame--loading" : ""
                      }`}
                      src=${this.previewUrl}
                      title=${this.label}
                      sandbox="allow-scripts"
                      referrerpolicy="no-referrer"
                      aria-hidden=${this.status !== "ready"}
                      ?inert=${this.status !== "ready"}
                    ></iframe>`,
                  )
                : nothing}
            `
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-html-attachment")) {
  customElements.define("openclaw-chat-html-attachment", ChatHtmlAttachment);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-html-attachment": ChatHtmlAttachment;
  }
}
