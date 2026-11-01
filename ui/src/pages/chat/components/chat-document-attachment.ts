import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";

const PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 30_000;

export function documentPreviewKind(
  mimeType: string | undefined,
  filename: string,
): "pdf" | "powerpoint" | undefined {
  const mime = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "application/pdf") {
    return "pdf";
  }
  if (
    mime === "application/vnd.ms-powerpoint" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "powerpoint";
  }
  if (mime && mime !== "application/octet-stream") {
    return undefined;
  }
  return /\.pdf$/iu.test(filename) ? "pdf" : /\.pptx?$/iu.test(filename) ? "powerpoint" : undefined;
}

async function readPreviewPdf(response: Response): Promise<ArrayBuffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (!response.body || declaredLength > PREVIEW_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(t("chat.attachments.documentPreviewTooLarge"));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      length += result.value.byteLength;
      if (length > PREVIEW_MAX_BYTES) {
        throw new Error(t("chat.attachments.documentPreviewTooLarge"));
      }
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error(t("chat.attachments.documentPreviewUnavailable"));
  }
  return bytes.buffer;
}

/** Both execution targets display only the authorized managed attachment snapshot. */
class ChatDocumentAttachment extends OpenClawLightDomElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property({ attribute: false }) onMediaLoaded: (() => void) | undefined;

  @state() private opened = false;
  @state() private previewUrl = "";
  @state() private error = "";

  private controller: AbortController | undefined;

  override disconnectedCallback(): void {
    this.opened = false;
    this.releasePreview();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("sourceIdentity") || changed.has("mimeType")) {
      this.opened = false;
      this.releasePreview();
    } else if (changed.has("src") && this.opened) {
      // A replacement grant must succeed before any previously downloaded bytes reappear.
      void this.loadPreview();
    }
  }

  private releasePreview(): void {
    this.controller?.abort();
    this.controller = undefined;
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = "";
    }
  }

  private async loadPreview(): Promise<void> {
    this.releasePreview();
    this.error = "";
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
    try {
      const href = safeAttachmentHref(this.src);
      if (!href) {
        throw new Error(t("chat.attachments.documentPreviewUnavailable"));
      }
      const url = new URL(href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        !/\/api\/chat\/media\/outgoing\/[^/]+\/[^/]+\/full$/u.test(url.pathname)
      ) {
        throw new Error(t("chat.attachments.documentPreviewUnavailable"));
      }
      const kind = documentPreviewKind(this.mimeType, this.label);
      if (!kind) {
        throw new Error(t("chat.attachments.documentPreviewUnavailable"));
      }
      if (this.sizeBytes !== undefined && this.sizeBytes > PREVIEW_MAX_BYTES) {
        throw new Error(t("chat.attachments.documentPreviewTooLarge"));
      }
      if (kind === "powerpoint") {
        url.searchParams.set("preview", "1");
      }
      const response = await fetch(url, {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (this.controller !== controller || !this.opened || !this.isConnected) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (this.controller === controller && this.opened && this.isConnected) {
          this.error = t(
            kind === "powerpoint" && response.status === 503
              ? "chat.attachments.powerPointPreviewUnavailable"
              : "chat.attachments.documentPreviewUnavailable",
          );
        }
        return;
      }
      if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/pdf") {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(t("chat.attachments.documentPreviewUnavailable"));
      }
      const bytes = await readPreviewPdf(response);
      if (this.controller !== controller || !this.opened || !this.isConnected) {
        return;
      }
      controller.signal.throwIfAborted();
      // The browser's PDF reader receives PDF bytes only, never a remote URL or HTML.
      this.previewUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    } catch (error) {
      if (this.controller === controller && this.opened && this.isConnected) {
        this.error =
          error instanceof Error && error.message === t("chat.attachments.documentPreviewTooLarge")
            ? error.message
            : t("chat.attachments.documentPreviewUnavailable");
      }
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) {
        this.onMediaLoaded?.();
      }
    }
  }

  private readonly togglePreview = (): void => {
    this.opened = !this.opened;
    if (this.opened) {
      void this.loadPreview();
    } else {
      this.releasePreview();
    }
    this.onMediaLoaded?.();
  };

  override render() {
    const href = safeAttachmentHref(this.src);
    return html`
      <div class="chat-assistant-attachment-card chat-document-attachment">
        <div class="chat-assistant-attachment-card__header">
          <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
          <span class="chat-assistant-attachment-card__title">${this.label}</span>
          <div class="chat-assistant-attachment-card__actions">
            <button
              type="button"
              class="btn btn--sm"
              aria-expanded=${this.opened}
              @click=${this.togglePreview}
            >
              ${t(
                this.opened
                  ? "chat.attachments.closeHtmlPreview"
                  : "chat.attachments.previewDocument",
              )}
            </button>
            ${href
              ? html`<a href=${href} target="_blank" rel="noreferrer"
                  >${t("chat.toolCards.downloadFile")}</a
                >`
              : nothing}
          </div>
        </div>
        ${this.opened && documentPreviewKind(this.mimeType, this.label) === "powerpoint"
          ? html`<div class="chat-assistant-attachment-card__reason">
              ${t("chat.attachments.powerPointStaticPreview")}
            </div>`
          : nothing}
        ${this.opened
          ? this.error
            ? html`<div class="chat-assistant-attachment-card__reason" role="alert">
                ${this.error}
              </div>`
            : this.previewUrl
              ? html`<iframe
                  class="chat-document-attachment__frame"
                  src=${this.previewUrl}
                  title=${this.label}
                  referrerpolicy="no-referrer"
                  @error=${() => {
                    this.error = t("chat.attachments.documentPreviewUnavailable");
                    this.releasePreview();
                  }}
                ></iframe>`
              : html`<div role="status">${t("common.loading")}</div>`
          : nothing}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-document-attachment")) {
  customElements.define("openclaw-chat-document-attachment", ChatDocumentAttachment);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-document-attachment": ChatDocumentAttachment;
  }
}
