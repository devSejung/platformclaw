import { css, html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

export type ImageLightboxImage = {
  src: string;
  title: string;
};

export type ImageLightboxItem = ImageLightboxImage & {
  gallery?: readonly ImageLightboxImage[];
  release?: () => void;
};

const SAFE_DATA_IMAGE_BLOB_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function mimeTypeEssence(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function dataUrlMimeType(source: string): string | undefined {
  const mediaType = /^data:([^,]*)/i.exec(source)?.[1];
  return mediaType === undefined ? undefined : mimeTypeEssence(mediaType);
}

class OpenClawImageLightbox extends OpenClawLitElement {
  @property() src = "";
  @property() override title = "";
  @property({ attribute: false }) gallery: readonly ImageLightboxImage[] = [];
  @query(".stage") private stage?: HTMLDivElement;
  @query(".image") private image?: HTMLImageElement;
  @state() private openOriginalUrl = "";
  @state() private activeIndex = 0;
  @state() private zoom = 1;
  @state() private panX = 0;
  @state() private panY = 0;
  @state() private dragging = false;

  private drag?: { pointerId: number; x: number; y: number; panX: number; panY: number };

  private originalBlobUrl = "";
  private originalUrlRequest = 0;

  static override styles = css`
    :host {
      display: contents;
    }

    openclaw-modal-dialog {
      --openclaw-modal-width: min(1280px, calc(100vw - 40px));
      --openclaw-modal-max-width: calc(100vw - 40px);
      --openclaw-modal-max-height: calc(100dvh - 40px);
    }

    .lightbox {
      width: min(1280px, calc(100vw - 40px));
      height: min(900px, calc(100dvh - 40px));
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--border-strong) 80%, transparent);
      border-radius: var(--radius-lg);
      /* Deliberately darker than any theme surface: the lightbox is a
         photo-viewer chrome that stays near-black in light mode too, so the
         white text and white-alpha borders below assume this literal. */
      background: #07090f;
      box-shadow: 0 28px 90px rgba(0, 0, 0, 0.6);
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 54px;
      padding: 10px 12px 10px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
    }

    .title {
      min-width: 0;
      overflow: hidden;
      font-size: 13px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
    }

    .action {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 650;
      text-decoration: none;
    }

    .action:hover {
      border-color: rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.14);
    }

    .action:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }

    .action:disabled {
      opacity: 0.35;
      cursor: default;
    }

    .toolbar {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 12px;
      color: #fff;
    }

    .zoom-level,
    .position {
      min-width: 48px;
      text-align: center;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    .icon-action {
      width: 36px;
      padding: 0;
      font-size: 22px;
    }

    .icon-action svg {
      width: 18px;
      height: 18px;
    }

    .close {
      width: 36px;
      padding: 0;
      color: rgba(255, 255, 255, 0.82);
    }

    .close svg {
      width: 17px;
      height: 17px;
      /* Shadow DOM: global icon stroke rules don't reach in here; without a
         stroke the open-path x icon renders invisible. */
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .stage {
      min-width: 0;
      min-height: 0;
      display: grid;
      place-items: center;
      padding: 20px;
      overflow: hidden;
    }

    .stage[data-zoomed] {
      touch-action: none;
      cursor: grab;
    }

    .stage[data-dragging] {
      cursor: grabbing;
    }

    .stage:focus-visible {
      outline: 2px solid #fff;
      outline-offset: -4px;
    }

    .image {
      display: block;
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: auto;
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.04);
      object-fit: contain;
      user-select: none;
    }

    @media (max-width: 720px), (max-height: 520px) and (orientation: landscape) {
      openclaw-modal-dialog {
        --openclaw-modal-width: calc(100vw - 24px);
        --openclaw-modal-max-width: calc(100vw - 24px);
        --openclaw-modal-max-height: 100dvh;
      }

      .lightbox {
        width: calc(100vw - 24px);
        height: 90dvh;
        border: 0;
        border-radius: 0;
      }

      .header {
        padding-top: calc(10px + env(safe-area-inset-top));
        padding-right: calc(12px + env(safe-area-inset-right));
        padding-left: calc(16px + env(safe-area-inset-left));
      }

      .stage {
        padding-right: calc(12px + env(safe-area-inset-right));
        padding-bottom: calc(12px + env(safe-area-inset-bottom));
        padding-left: calc(12px + env(safe-area-inset-left));
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("resize", this.clampPan);
    if (this.hasUpdated) {
      void this.resolveOriginalUrl();
    }
  }

  override disconnectedCallback() {
    window.removeEventListener("resize", this.clampPan);
    this.stopDrag();
    this.originalUrlRequest += 1;
    this.revokeOriginalBlobUrl();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("src") || changed.has("gallery")) {
      this.activeIndex = Math.max(
        0,
        this.gallery.findIndex((item) => item.src === this.src && item.title === this.title),
      );
      this.resetView();
    }
  }

  protected override updated(changed: PropertyValues) {
    if (changed.has("src") || changed.has("gallery") || changed.has("activeIndex")) {
      void this.resolveOriginalUrl();
    }
  }

  private get currentImage(): ImageLightboxImage {
    return this.gallery[this.activeIndex] ?? { src: this.src, title: this.title };
  }

  override render() {
    const title = this.currentImage.title.trim() || t("chat.imageLightbox.untitled");
    const percent = Math.round(this.zoom * 100);
    return html`
      <openclaw-modal-dialog
        label=${t("chat.imageLightbox.label", { title })}
        @modal-cancel=${this.emitClose}
        @keydown=${this.handleKeydown}
      >
        <section class="lightbox">
          <header class="header">
            <strong class="title">${title}</strong>
            <div class="actions">
              ${this.openOriginalUrl
                ? html`
                    <a
                      class="action open-original"
                      href=${this.openOriginalUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      ${t("chat.imageLightbox.openOriginal")}
                    </a>
                  `
                : nothing}
              <button
                class="action close"
                type="button"
                autofocus
                aria-label=${t("chat.imageLightbox.close")}
                @click=${this.emitClose}
              >
                ${icons.x}
              </button>
            </div>
          </header>
          <div class="toolbar">
            <div class="actions">
              <button
                class="action icon-action zoom-out"
                type="button"
                aria-label=${t("chat.imageLightbox.zoomOut")}
                aria-keyshortcuts="-"
                ?disabled=${this.zoom === 1}
                @click=${() => this.changeZoom(1 / 1.25)}
              >
                −
              </button>
              <span
                class="zoom-level"
                role="status"
                aria-label=${t("chat.imageLightbox.zoomLevel", { percent: String(percent) })}
                >${percent}%</span
              >
              <button
                class="action icon-action zoom-in"
                type="button"
                aria-label=${t("chat.imageLightbox.zoomIn")}
                aria-keyshortcuts="="
                ?disabled=${this.zoom === 5}
                @click=${() => this.changeZoom(1.25)}
              >
                +
              </button>
              <button
                class="action reset-zoom"
                type="button"
                aria-keyshortcuts="0 Home"
                @click=${this.resetView}
              >
                ${t("chat.imageLightbox.resetZoom")}
              </button>
            </div>
            ${this.gallery.length > 1
              ? html` <div class="actions">
                  <button
                    class="action icon-action previous"
                    type="button"
                    aria-label=${t("chat.imageLightbox.previous")}
                    aria-keyshortcuts="PageUp"
                    ?disabled=${this.activeIndex === 0}
                    @click=${() => this.changeImage(-1)}
                  >
                    ${icons.chevronLeft}
                  </button>
                  <span
                    class="position"
                    role="status"
                    aria-label=${t("chat.imageLightbox.position", {
                      current: String(this.activeIndex + 1),
                      total: String(this.gallery.length),
                    })}
                    >${this.activeIndex + 1} / ${this.gallery.length}</span
                  >
                  <button
                    class="action icon-action next"
                    type="button"
                    aria-label=${t("chat.imageLightbox.next")}
                    aria-keyshortcuts="PageDown"
                    ?disabled=${this.activeIndex === this.gallery.length - 1}
                    @click=${() => this.changeImage(1)}
                  >
                    ${icons.chevronRight}
                  </button>
                </div>`
              : nothing}
          </div>
          <div
            class="stage"
            tabindex="0"
            role="region"
            aria-label=${title}
            ?data-zoomed=${this.zoom > 1}
            ?data-dragging=${this.dragging}
            @pointerdown=${this.handlePointerDown}
            @pointermove=${this.handlePointerMove}
            @pointerup=${this.stopDrag}
            @pointercancel=${this.stopDrag}
            @lostpointercapture=${this.stopDrag}
            @wheel=${this.handleWheel}
            @dblclick=${this.handleDoubleClick}
          >
            <img
              class="image"
              src=${this.currentImage.src}
              alt=${title}
              draggable="false"
              style=${styleMap({
                transform: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`,
              })}
              @load=${this.clampPan}
            />
          </div>
        </section>
      </openclaw-modal-dialog>
    `;
  }

  private revokeOriginalBlobUrl() {
    if (!this.originalBlobUrl) {
      return;
    }
    URL.revokeObjectURL(this.originalBlobUrl);
    this.originalBlobUrl = "";
  }

  private async resolveOriginalUrl() {
    const request = ++this.originalUrlRequest;
    this.revokeOriginalBlobUrl();
    const source = this.currentImage.src.trim();
    if (!source) {
      this.openOriginalUrl = "";
      return;
    }
    if (source.slice(0, 5).toLowerCase() !== "data:") {
      this.openOriginalUrl = source;
      return;
    }
    this.openOriginalUrl = "";
    const sourceType = dataUrlMimeType(source);
    // Top-level blob documents inherit the app origin. Only inert raster formats
    // may be promoted from opaque-origin data URLs into an original-image link.
    if (!sourceType || !SAFE_DATA_IMAGE_BLOB_TYPES.has(sourceType)) {
      return;
    }
    try {
      const response = await fetch(source);
      const blob = await response.blob();
      if (
        !this.isConnected ||
        request !== this.originalUrlRequest ||
        !SAFE_DATA_IMAGE_BLOB_TYPES.has(mimeTypeEssence(blob.type))
      ) {
        return;
      }
      this.originalBlobUrl = URL.createObjectURL(blob);
      this.openOriginalUrl = this.originalBlobUrl;
    } catch {
      // The image remains viewable inline; omit an unusable original-link action.
    }
  }

  private handleKeydown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.key === "Tab") {
      const controls = this.shadowRoot?.querySelectorAll<HTMLElement>(
        ".action:not(:disabled), .stage",
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      const source = event.composedPath()[0];
      if (event.shiftKey && source === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && source === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.key === "+" || event.key === "=") {
      this.changeZoom(1.25);
    } else if (event.key === "-") {
      this.changeZoom(1 / 1.25);
    } else if (event.key === "0" || event.key === "Home") {
      this.resetView();
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      this.changeImage(event.key === "PageDown" ? 1 : -1);
    } else if (event.key.startsWith("Arrow")) {
      if (this.zoom === 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        this.changeImage(event.key === "ArrowRight" ? 1 : -1);
      } else {
        const distance = event.shiftKey ? 120 : 40;
        this.panX +=
          event.key === "ArrowLeft" ? distance : event.key === "ArrowRight" ? -distance : 0;
        this.panY += event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0;
        this.clampPan();
      }
    } else {
      return;
    }
    event.preventDefault();
  };

  private changeImage(direction: number) {
    const index = Math.min(this.gallery.length - 1, Math.max(0, this.activeIndex + direction));
    if (index < 0 || index === this.activeIndex) {
      return;
    }
    this.activeIndex = index;
    this.resetView();
    this.stage?.focus({ preventScroll: true });
  }

  private resetView = () => {
    this.stopDrag();
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  };

  private changeZoom(factor: number) {
    this.stopDrag();
    this.zoom = Math.min(5, Math.max(1, this.zoom * factor));
    this.clampPan();
    this.stage?.focus({ preventScroll: true });
  }

  private clampPan = () => {
    const stage = this.stage;
    const image = this.image;
    if (!stage || !image) {
      return;
    }
    const limitX = Math.max(0, (image.clientWidth * this.zoom - stage.clientWidth) / 2);
    const limitY = Math.max(0, (image.clientHeight * this.zoom - stage.clientHeight) / 2);
    this.panX = Math.min(limitX, Math.max(-limitX, this.panX));
    this.panY = Math.min(limitY, Math.max(-limitY, this.panY));
  };

  private handlePointerDown = (event: PointerEvent) => {
    if (this.zoom === 1 || event.button !== 0 || this.drag) {
      return;
    }
    event.preventDefault();
    this.drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: this.panX,
      panY: this.panY,
    };
    this.dragging = true;
    this.stage?.setPointerCapture(event.pointerId);
  };

  private handlePointerMove = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    this.panX = drag.panX + event.clientX - drag.x;
    this.panY = drag.panY + event.clientY - drag.y;
    this.clampPan();
  };

  private stopDrag = () => {
    const pointerId = this.drag?.pointerId;
    this.drag = undefined;
    this.dragging = false;
    if (pointerId !== undefined && this.stage?.hasPointerCapture(pointerId)) {
      this.stage.releasePointerCapture(pointerId);
    }
  };

  private handleWheel = (event: WheelEvent) => {
    if (event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    this.changeZoom(event.deltaY < 0 ? 1.25 : 1 / 1.25);
  };

  private handleDoubleClick = () => {
    if (this.zoom > 1) {
      this.resetView();
    } else {
      this.changeZoom(2);
    }
  };

  private emitClose = () => {
    this.dispatchEvent(
      new CustomEvent("image-lightbox-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

if (!customElements.get("openclaw-image-lightbox")) {
  customElements.define("openclaw-image-lightbox", OpenClawImageLightbox);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-image-lightbox": OpenClawImageLightbox;
  }
}
