import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { documentContentsStyles } from "./document-viewer-contents.styles.ts";
import type {
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
  renderPdfPage,
} from "./pdf-document.runtime.ts";

const CONTENTS_WINDOW_PAGES = 6;
const THUMBNAIL_MAX_DIMENSION = 144;
const THUMBNAIL_WINDOW_TIMEOUT_MS = 30_000;

/** Only the open six-page window renders thumbnails, serially on the existing PDF worker. */
class OpenClawDocumentContents extends OpenClawLitElement {
  @property({ attribute: false }) pdf: PDFDocumentProxy | undefined;
  @property({ attribute: false }) renderPage: typeof renderPdfPage | undefined;
  @property({ type: Number }) currentPage = 1;
  @property() pageUnit: "page" | "slide" = "page";
  @property({ type: Boolean }) disabled = false;
  @state() private windowStart = 1;
  @state() private completed = new Set<number>();
  @state() private failed = new Set<number>();
  private task: RenderTask | undefined;
  private generation = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private readonly canvases = new Set<HTMLCanvasElement>();

  static override styles = documentContentsStyles;

  override disconnectedCallback(): void {
    void this.retireWindow();
    super.disconnectedCallback();
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) {
      void this.renderWindow();
    }
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("pdf")) {
      this.windowStart = 1;
    }
    if (
      changed.has("currentPage") &&
      (this.currentPage < this.windowStart ||
        this.currentPage >= this.windowStart + CONTENTS_WINDOW_PAGES)
    ) {
      this.windowStart =
        Math.floor((this.currentPage - 1) / CONTENTS_WINDOW_PAGES) * CONTENTS_WINDOW_PAGES + 1;
    }
  }

  protected override updated(changed: PropertyValues): void {
    if (
      changed.has("pdf") ||
      changed.has("renderPage") ||
      changed.has("windowStart") ||
      (changed.has("currentPage") &&
        !this.completed.has(this.currentPage) &&
        !this.failed.has(this.currentPage))
    ) {
      void this.renderWindow();
    }
  }

  private async retireWindow(): Promise<void> {
    this.generation++;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    const task = this.task;
    this.task = undefined;
    task?.cancel();
    for (const canvas of this.canvases) {
      canvas.width = canvas.height = 0;
    }
    this.canvases.clear();
    await task?.promise.catch(() => undefined);
  }

  private pages(): number[] {
    const count = Math.min(CONTENTS_WINDOW_PAGES, (this.pdf?.numPages ?? 0) - this.windowStart + 1);
    return Array.from({ length: Math.max(0, count) }, (_, index) => this.windowStart + index);
  }

  private async renderWindow(): Promise<void> {
    const retired = this.retireWindow();
    const generation = this.generation;
    const pdf = this.pdf;
    const renderPage = this.renderPage;
    const pages = this.pages();
    const current = () => this.isConnected && generation === this.generation;
    this.completed = new Set();
    this.failed = new Set();
    if (!pdf || !renderPage || !pages.length) {
      return;
    }
    await retired;
    await this.updateComplete;
    if (!current()) {
      return;
    }
    let expired = false;
    this.deadline = setTimeout(() => {
      if (current()) {
        expired = true;
        this.task?.cancel();
        this.failed = new Set(pages.filter((number) => !this.completed.has(number)));
      }
    }, THUMBNAIL_WINDOW_TIMEOUT_MS);
    try {
      for (const number of pages) {
        const canvas = this.shadowRoot?.querySelector<HTMLCanvasElement>(
          `canvas[data-page="${number}"]`,
        );
        if (!current() || expired || !canvas) {
          return;
        }
        let page: PDFPageProxy | undefined;
        try {
          page = await pdf.getPage(number);
          if (!current() || expired) {
            return;
          }
          const base = page.getViewport({ scale: 1 });
          const scale = THUMBNAIL_MAX_DIMENSION / Math.max(base.width, base.height);
          if (!Number.isFinite(scale) || scale <= 0) {
            throw new Error("Invalid thumbnail dimensions");
          }
          const viewport = page.getViewport({ scale });
          this.canvases.add(canvas);
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          const task = renderPage(page, canvas, viewport);
          this.task = task;
          await task.promise;
          if (!current() || expired) {
            return;
          }
          this.task = undefined;
          this.completed = new Set([...this.completed, number]);
        } catch {
          if (!current() || expired) {
            return;
          }
          this.task = undefined;
          canvas.width = canvas.height = 0;
          this.failed = new Set([...this.failed, number]);
        } finally {
          // The main page owns its shared PDFPageProxy; other thumbnails release
          // parsed operators after their bounded canvas has retained the pixels.
          if (number !== this.currentPage) {
            page?.cleanup();
          }
        }
      }
    } finally {
      if (current()) {
        clearTimeout(this.deadline);
        this.deadline = undefined;
      }
    }
  }

  override render() {
    const total = this.pdf?.numPages ?? 0;
    return html`<nav aria-label=${t("chat.documentViewer.contents")}>
      <div class="window-controls">
        <button
          type="button"
          ?disabled=${this.disabled || this.windowStart <= 1}
          aria-label=${t("chat.documentViewer.previousContents")}
          @click=${() => {
            this.windowStart = Math.max(1, this.windowStart - CONTENTS_WINDOW_PAGES);
          }}
        >
          ‹
        </button>
        <span
          >${this.windowStart}–${Math.min(total, this.windowStart + CONTENTS_WINDOW_PAGES - 1)} /
          ${total}</span
        >
        <button
          type="button"
          ?disabled=${this.disabled || this.windowStart + CONTENTS_WINDOW_PAGES > total}
          aria-label=${t("chat.documentViewer.nextContents")}
          @click=${() => {
            this.windowStart += CONTENTS_WINDOW_PAGES;
          }}
        >
          ›
        </button>
      </div>
      <div class="thumbnail-list">
        ${repeat(
          this.pages(),
          (number) => number,
          (number) => html`<button
            type="button"
            class="thumbnail"
            ?disabled=${this.disabled}
            aria-label=${t(
              this.pageUnit === "slide"
                ? "chat.documentViewer.slideThumbnail"
                : "chat.documentViewer.pageThumbnail",
              { page: String(number) },
            )}
            aria-current=${number === this.currentPage ? "page" : nothing}
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent<number>("document-page-select", { detail: number }),
              )}
          >
            <canvas
              data-page=${number}
              data-thumbnail-state=${this.completed.has(number) ? "ready" : "loading"}
              aria-hidden="true"
            ></canvas>
            ${this.failed.has(number)
              ? html`<span class="thumbnail-error"
                  >${t("chat.documentViewer.thumbnailError")}</span
                >`
              : nothing}
            <span>${number}</span>
          </button>`,
        )}
      </div>
    </nav>`;
  }
}

if (!customElements.get("openclaw-document-contents")) {
  customElements.define("openclaw-document-contents", OpenClawDocumentContents);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-document-contents": OpenClawDocumentContents;
  }
}
