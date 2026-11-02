import { html, nothing, type PropertyValues } from "lit";
import { property, query, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import {
  DocumentViewerRequestController,
  type DocumentChangeHandler,
} from "./document-viewer-request.ts";
import { createDocumentSelectionTargets } from "./document-viewer-selection.ts";
import { documentViewerStyles } from "./document-viewer.styles.ts";
import { toolIcons } from "./icons-tools.ts";
import type {
  PdfDocumentHandle,
  PDFDocumentProxy,
  PDFPageProxy,
  RenderTask,
} from "./pdf-document.runtime.ts";
import "./modal-dialog.ts";
import "./document-viewer-contents.ts";

const DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;
const PAGE_MAX_PIXELS = 16_000_000;
const PAGE_MAX_DIMENSION = 16_384;
const PAGE_TEXT_MAX_CHARACTERS = 65_536;
const DOCUMENT_OPERATION_TIMEOUT_MS = 30_000;

type FitMode = "page" | "width" | "custom";
type RenderState = "loading" | "ready" | "error";

class OpenClawDocumentViewer extends OpenClawLitElement {
  @property({ attribute: false }) bytes: Uint8Array | ArrayBuffer | undefined;
  @property() documentTitle = "";
  @property() pageUnit: "page" | "slide" = "page";
  @property({ attribute: false }) requestChanges: DocumentChangeHandler | undefined;
  @query(".stage") private stage?: HTMLDivElement;
  @query("canvas.current-page") private canvas?: HTMLCanvasElement;
  @state() private renderState: RenderState = "loading";
  @state() private pageNumber = 1;
  @state() private pageCount = 0;
  @state() private renderedPage = 0;
  @state() private pageText = "";
  @state() private fitMode: FitMode = "width";
  @state() private customScale = 1;
  @state() private displayScale = 1;
  @state() private expanded = false;
  @state() private contentsOpen = false;
  @state() private failureKind: "password" | "unavailable" = "unavailable";

  private engine: typeof import("./pdf-document.runtime.ts") | undefined;
  private handle: PdfDocumentHandle | undefined;
  private pdf: PDFDocumentProxy | undefined;
  private pdfPage: PDFPageProxy | undefined;
  private renderTask: RenderTask | undefined;
  private generation = 0;
  private renderGeneration = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private observer: ResizeObserver | undefined;
  private observedStage: HTMLDivElement | undefined;
  private lastCanvas: HTMLCanvasElement | undefined;
  private waitingForStage = false;
  private selectionTargets: ReturnType<typeof createDocumentSelectionTargets> = [];
  private stageWidth = 0;
  private stageHeight = 0;
  private readonly changeRequest = new DocumentViewerRequestController({
    requestUpdate: () => this.requestUpdate(),
    currentPage: () =>
      this.renderState === "ready" &&
      this.renderedPage === this.pageNumber &&
      this.canvas &&
      this.isConnected
        ? { number: this.renderedPage, canvas: this.canvas, targets: this.selectionTargets }
        : undefined,
    handler: () => this.requestChanges,
  });

  static override styles = documentViewerStyles;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("resize", this.handleViewportResize);
    if (this.hasUpdated) {
      void this.loadDocument();
    }
  }

  override disconnectedCallback(): void {
    window.removeEventListener("resize", this.handleViewportResize);
    this.observer?.disconnect();
    this.observedStage = undefined;
    this.expanded = false;
    void this.retireDocument();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues): void {
    if (changed.has("bytes")) {
      void this.loadDocument();
      return;
    }
    if (this.stage !== this.observedStage) {
      this.observer?.disconnect();
      this.observedStage = this.stage;
      this.observer ??= new ResizeObserver(() => {
        const stage = this.stage;
        if (
          stage &&
          stage.clientWidth > 0 &&
          (!this.expanded || stage.clientHeight > 0) &&
          (this.waitingForStage ||
            (this.fitMode !== "custom" && stage.clientWidth !== this.stageWidth) ||
            (this.expanded && this.fitMode === "page" && stage.clientHeight !== this.stageHeight))
        ) {
          this.waitingForStage = false;
          void this.renderPage();
        }
      });
      if (this.stage) {
        this.observer.observe(this.stage);
      }
    }
    if (
      changed.has("pageNumber") ||
      changed.has("fitMode") ||
      changed.has("customScale") ||
      changed.has("expanded")
    ) {
      void this.renderPage();
    }
  }

  private clearDeadline(): void {
    clearTimeout(this.deadline);
    this.deadline = undefined;
  }

  private handleViewportResize = (): void => {
    if (!this.expanded && this.fitMode === "page") {
      void this.renderPage();
    }
  };

  private ensureDeadline(): void {
    this.deadline ??= setTimeout(() => this.fail("unavailable"), DOCUMENT_OPERATION_TIMEOUT_MS);
  }

  private async retireDocument(): Promise<void> {
    this.waitingForStage = false;
    this.selectionTargets = [];
    this.changeRequest.reset();
    this.generation++;
    this.renderGeneration++;
    this.clearDeadline();
    this.renderTask?.cancel();
    this.renderTask = undefined;
    this.pdf = undefined;
    this.pdfPage = undefined;
    const handle = this.handle;
    this.handle = undefined;
    if (this.canvas) {
      this.canvas.width = this.canvas.height = 0;
    }
    if (this.lastCanvas && this.lastCanvas !== this.canvas) {
      this.lastCanvas.width = this.lastCanvas.height = 0;
    }
    this.lastCanvas = undefined;
    await handle?.destroy();
  }

  private async loadDocument(): Promise<void> {
    const retired = this.retireDocument();
    const generation = this.generation;
    const bytes = this.bytes;
    this.renderState = "loading";
    this.setAttribute("data-render-state", "loading");
    this.pageCount = this.renderedPage = 0;
    this.pageNumber = 1;
    this.pageText = "";
    this.fitMode = "width";
    this.customScale = 1;
    this.contentsOpen = false;
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > DOCUMENT_MAX_BYTES) {
      this.fail("unavailable");
      return;
    }
    this.ensureDeadline();
    try {
      await retired;
      const engine = await import("./pdf-document.runtime.ts");
      if (!this.isConnected || generation !== this.generation) {
        return;
      }
      this.engine = engine;
      const handle = engine.openPdfDocument(bytes, (kind) => {
        if (generation === this.generation && this.isConnected) {
          this.fail(kind);
        }
      });
      this.handle = handle;
      const pdf = await handle.promise;
      if (!this.isConnected || generation !== this.generation) {
        return;
      }
      this.pdf = pdf;
      this.pageCount = pdf.numPages;
      await this.updateComplete;
      await this.renderPage();
    } catch {
      if (generation === this.generation && this.isConnected) {
        this.fail("unavailable");
      }
    }
  }

  private fail(kind: "password" | "unavailable"): void {
    this.failureKind = kind;
    this.renderState = "error";
    this.renderedPage = 0;
    this.pageText = "";
    this.setAttribute("data-render-state", "error");
    void this.retireDocument();
    this.dispatchEvent(new CustomEvent("document-viewer-error", { bubbles: true, composed: true }));
  }

  private async renderPage(): Promise<void> {
    const pdf = this.pdf;
    const engine = this.engine;
    const canvas = this.canvas;
    const stage = this.stage;
    if (!pdf || !engine || !canvas || !stage || !this.isConnected) {
      return;
    }
    this.changeRequest.closeContextMenu();
    const generation = this.generation;
    const renderGeneration = ++this.renderGeneration;
    this.waitingForStage = false;
    this.stageWidth = stage.clientWidth;
    this.stageHeight = stage.clientHeight;
    const current = () =>
      this.isConnected &&
      generation === this.generation &&
      renderGeneration === this.renderGeneration &&
      canvas === this.canvas;
    const previous = this.renderTask;
    this.renderTask = undefined;
    previous?.cancel();
    this.renderState = "loading";
    this.renderedPage = 0;
    this.pageText = "";
    this.selectionTargets = [];
    this.setAttribute("data-render-state", "loading");
    this.ensureDeadline();
    try {
      await previous?.promise.catch(() => undefined);
      if (!current()) {
        return;
      }
      if (this.lastCanvas && this.lastCanvas !== canvas) {
        this.lastCanvas.width = this.lastCanvas.height = 0;
      }
      this.lastCanvas = canvas;
      const pageNumber = this.pageNumber;
      const page = await pdf.getPage(pageNumber);
      if (!current()) {
        return;
      }
      if (this.pdfPage && this.pdfPage !== page) {
        this.pdfPage.cleanup();
      }
      this.pdfPage = page;
      const base = page.getViewport({ scale: 1 });
      const style = getComputedStyle(stage);
      const availableWidth =
        stage.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const availableHeight =
        (this.expanded ? stage.clientHeight : window.innerHeight) -
        Number.parseFloat(style.paddingTop) -
        Number.parseFloat(style.paddingBottom);
      if (availableWidth <= 0 || (this.expanded && availableHeight <= 0)) {
        // A top-layer dialog can mount before its slotted stage is measurable.
        // Resume once after visibility changes, including at a custom zoom.
        this.waitingForStage = true;
        return;
      }
      const scale =
        this.fitMode === "custom"
          ? this.customScale
          : Math.min(
              availableWidth / base.width,
              this.fitMode === "page" ? availableHeight / base.height : Infinity,
            );
      const width = base.width * scale;
      const height = base.height * scale;
      if (!Number.isFinite(width + height) || width <= 0 || height <= 0) {
        throw new Error("Invalid PDF page dimensions");
      }
      const pixelScale = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(PAGE_MAX_PIXELS / (width * height)),
        PAGE_MAX_DIMENSION / width,
        PAGE_MAX_DIMENSION / height,
      );
      const viewport = page.getViewport({ scale: scale * pixelScale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const task = engine.renderPdfPage(page, canvas, viewport);
      this.renderTask = task;
      await task.promise;
      if (!current()) {
        return;
      }
      const text = await page.getTextContent();
      if (!current()) {
        return;
      }
      let pageText = "";
      for (const item of text.items) {
        if ("str" in item) {
          pageText += item.str + (item.hasEOL ? "\n" : " ");
          if (pageText.length >= PAGE_TEXT_MAX_CHARACTERS) {
            break;
          }
        }
      }
      this.pageText = pageText.slice(0, PAGE_TEXT_MAX_CHARACTERS);
      this.selectionTargets = createDocumentSelectionTargets(text, base);
      this.displayScale = scale;
      this.renderedPage = pageNumber;
      this.renderState = "ready";
      await this.updateComplete;
      if (!current()) {
        return;
      }
      this.setAttribute("data-render-state", "ready");
      this.clearDeadline();
      this.dispatchEvent(
        new CustomEvent("document-viewer-load", { bubbles: true, composed: true }),
      );
    } catch {
      if (current()) {
        this.fail("unavailable");
      }
    }
  }

  private changePage(value: number): void {
    if (Number.isFinite(value) && !this.changeRequest.busy) {
      this.pageNumber = Math.max(1, Math.min(this.pageCount, Math.floor(value)));
      this.changeRequest.changePage(this.pageNumber);
    }
  }

  private changeZoom(delta: number): void {
    this.customScale = Math.min(
      3,
      Math.max(0.5, Math.round((this.displayScale + delta) * 100) / 100),
    );
    this.fitMode = "custom";
  }

  private collapse = (): void => {
    this.changeRequest.reset();
    this.expanded = false;
    void this.updateComplete.then(() => {
      this.shadowRoot
        ?.querySelector<HTMLElement>(".preview-options > summary")
        ?.focus({ preventScroll: true });
    });
  };

  private handleKeydown = (event: KeyboardEvent): void => {
    if (this.expanded && event.key === "Escape") {
      event.stopPropagation();
    }
    if (
      event.composedPath()[0] instanceof HTMLInputElement ||
      event.composedPath()[0] instanceof HTMLTextAreaElement ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      this.changePage(this.pageNumber + (event.key === "PageDown" ? 1 : -1));
    }
  };

  override render() {
    const ready = this.pageCount > 0 && this.renderState !== "error";
    const navigationReady = ready && !this.changeRequest.busy;
    const slide = this.pageUnit === "slide";
    const position = { current: String(this.pageNumber), total: String(this.pageCount) };
    const content = html` <section
      class=${this.expanded ? "viewer expanded" : "viewer"}
      data-request-mode=${this.changeRequest.active ? "select" : "off"}
      @keydown=${this.handleKeydown}
    >
      ${this.expanded
        ? html`<header class="header">
            <strong class="document-title">${this.documentTitle}</strong>
          </header>`
        : nothing}
      <div class="page-layout">
        ${this.contentsOpen && this.pdf && this.engine
          ? html`<openclaw-document-contents
              .pdf=${this.pdf}
              .renderPage=${this.engine.renderPdfPage}
              .currentPage=${this.pageNumber}
              .pageUnit=${this.pageUnit}
              .disabled=${this.changeRequest.busy}
              @document-page-select=${(event: CustomEvent<number>) => this.changePage(event.detail)}
            ></openclaw-document-contents>`
          : nothing}
        <div
          class="stage"
          tabindex="0"
          role="region"
          aria-label=${this.documentTitle}
          aria-busy=${this.renderState === "loading"}
        >
          ${this.renderState === "error"
            ? html`<div class="notice" role="alert">
                ${t(
                  this.failureKind === "password"
                    ? "chat.documentViewer.passwordProtected"
                    : "chat.documentViewer.loadError",
                )}
              </div>`
            : nothing}
          ${this.renderState === "loading"
            ? html`<div class="notice" role="status">${t("common.loading")}</div>`
            : nothing}
          <div
            class=${this.changeRequest.active ? "page-surface selection-active" : "page-surface"}
            @pointerdown=${this.changeRequest.pointerDown}
            @pointermove=${this.changeRequest.pointerMove}
            @pointerup=${this.changeRequest.pointerUp}
            @pointercancel=${this.changeRequest.pointerCancel}
            @contextmenu=${this.changeRequest.contextMenu}
          >
            <canvas
              class="current-page"
              role="img"
              aria-hidden=${this.renderState !== "ready"}
              data-rendered-page=${this.renderedPage || nothing}
              data-page-count=${this.pageCount}
              aria-label=${t(
                slide ? "chat.documentViewer.slideLabel" : "chat.documentViewer.pageLabel",
                { title: this.documentTitle, ...position },
              )}
            ></canvas>
            ${this.changeRequest.renderOverlay()}
          </div>
          ${this.changeRequest.renderPopover()} ${this.changeRequest.renderContextMenu()}
        </div>
      </div>
      <footer class="toolbar">
        <div class="pagination">
          <span class="page-unit"
            >${t(slide ? "chat.documentViewer.slideUnit" : "chat.documentViewer.pageUnit")}</span
          >
          <button
            type="button"
            aria-label=${t(
              slide ? "chat.documentViewer.previousSlide" : "chat.documentViewer.previousPage",
            )}
            ?disabled=${!navigationReady || this.pageNumber <= 1}
            @click=${() => this.changePage(this.pageNumber - 1)}
          >
            ‹
          </button>
          <span
            class="position"
            role="status"
            aria-label=${t(
              slide ? "chat.documentViewer.slidePosition" : "chat.documentViewer.pagePosition",
              position,
            )}
            >${this.pageNumber} / ${this.pageCount}</span
          >
          <button
            type="button"
            aria-label=${t(
              slide ? "chat.documentViewer.nextSlide" : "chat.documentViewer.nextPage",
            )}
            ?disabled=${!navigationReady || this.pageNumber >= this.pageCount}
            @click=${() => this.changePage(this.pageNumber + 1)}
          >
            ›
          </button>
        </div>
        <div class="controls">
          <button
            type="button"
            class="contents-toggle"
            ?disabled=${!ready}
            aria-expanded=${this.contentsOpen}
            @click=${() => {
              this.contentsOpen = !this.contentsOpen;
            }}
          >
            ${t("chat.documentViewer.contents")}
          </button>
          ${this.requestChanges
            ? html`<button
                type="button"
                class="request-changes"
                aria-pressed=${this.changeRequest.active}
                ?disabled=${this.renderState !== "ready" || this.changeRequest.busy}
                @click=${() => {
                  if (this.changeRequest.active) {
                    this.changeRequest.reset();
                  } else {
                    this.changeRequest.begin();
                    if (this.changeRequest.active) {
                      this.contentsOpen = false;
                    }
                  }
                }}
              >
                <span class="request-icon" aria-hidden="true">${toolIcons.penLine}</span>
                ${t("chat.documentViewer.requestChanges")}
              </button>`
            : nothing}
          <details class="preview-options">
            <summary aria-label=${t("chat.documentViewer.previewOptions")}>⋯</summary>
            <div class="options-panel">
              <div class="option-controls">
                <button
                  type="button"
                  aria-label=${t("chat.imageLightbox.zoomOut")}
                  ?disabled=${!ready || this.displayScale <= 0.5}
                  @click=${() => this.changeZoom(-0.25)}
                >
                  −
                </button>
                <span class="zoom-level">${Math.round(this.displayScale * 100)}%</span>
                <button
                  type="button"
                  aria-label=${t("chat.imageLightbox.zoomIn")}
                  ?disabled=${!ready || this.displayScale >= 3}
                  @click=${() => this.changeZoom(0.25)}
                >
                  +
                </button>
                <button
                  type="button"
                  ?disabled=${!ready}
                  aria-pressed=${this.fitMode === "width"}
                  @click=${() => {
                    this.fitMode = "width";
                  }}
                >
                  ${t("chat.documentViewer.fitWidth")}
                </button>
                <button
                  type="button"
                  ?disabled=${!ready}
                  aria-pressed=${this.fitMode === "page"}
                  @click=${() => {
                    this.fitMode = "page";
                  }}
                >
                  ${t("chat.documentViewer.fitPage")}
                </button>
                <button
                  type="button"
                  class="expand"
                  @click=${this.expanded
                    ? this.collapse
                    : () => {
                        this.expanded = true;
                      }}
                >
                  ${t(
                    this.expanded ? "chat.documentViewer.collapse" : "chat.documentViewer.expand",
                  )}
                </button>
              </div>
              <details class="text-alternative">
                <summary>
                  ${t(
                    slide
                      ? "chat.documentViewer.slideTextAlternative"
                      : "chat.documentViewer.textAlternative",
                  )}
                </summary>
                <div class="page-text">${this.pageText}</div>
              </details>
              ${slide
                ? html`<p class="option-note">${t("chat.attachments.powerPointStaticPreview")}</p>`
                : nothing}
            </div>
          </details>
        </div>
      </footer>
      ${this.changeRequest.active
        ? html`<div class="selection-hint">${t("chat.documentViewer.requestHint")}</div>`
        : nothing}
      ${this.changeRequest.renderStatus()}
    </section>`;
    return this.expanded
      ? html`<openclaw-modal-dialog label=${this.documentTitle} @modal-cancel=${this.collapse}
          >${content}</openclaw-modal-dialog
        >`
      : content;
  }
}

if (!customElements.get("openclaw-document-viewer")) {
  customElements.define("openclaw-document-viewer", OpenClawDocumentViewer);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-document-viewer": OpenClawDocumentViewer;
  }
}
