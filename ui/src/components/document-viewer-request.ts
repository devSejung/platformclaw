import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import type { DocumentSelectionTarget } from "./document-viewer-selection.ts";
import { toolIcons } from "./icons-tools.ts";
import "./web-awesome.ts";

export const DOCUMENT_CHANGE_TEXT_MAX = 1_024;
export const DOCUMENT_CHANGE_INSTRUCTION_MAX = 4_096;
export const DOCUMENT_CHANGE_CROP_MAX_BYTES = 1024 * 1024;
const CROP_MAX_PIXELS = 256_000;
const CROP_MAX_DIMENSION = 768;
const POINT_REGION_WIDTH = 0.35;
const POINT_REGION_HEIGHT = 0.18;
const POPOVER_MARGIN = 12;
const POPOVER_GAP = 8;
const POPOVER_WIDTH = 300;

type DocumentChangeRegion = { x: number; y: number; width: number; height: number };
export type DocumentChangeRequest = {
  pageNumber: number;
  region?: DocumentChangeRegion;
  selectedText?: string;
  instruction: string;
  cropDataUrl?: string;
};
export type DocumentChangeResult = { admitted: true } | { admitted: false; message?: string };
export type DocumentChangeHandler = (
  request: DocumentChangeRequest,
  signal: AbortSignal,
) => Promise<DocumentChangeResult>;

type SelectionPage = {
  number: number;
  canvas: HTMLCanvasElement;
  targets?: readonly DocumentSelectionTarget[];
};
type RequestHost = {
  requestUpdate(): void;
  currentPage(): SelectionPage | undefined;
  handler(): DocumentChangeHandler | undefined;
};

/** Selection stays local until the current document owner admits an explicit request. */
export class DocumentViewerRequestController {
  active = false;
  busy = false;
  private pageNumber = 0;
  private region: DocumentChangeRegion | undefined;
  private selectedText = "";
  private instruction = "";
  private error = "";
  private sent = false;
  private drag: { pointerId: number; x: number; y: number; canvas: HTMLCanvasElement } | undefined;
  private submission: AbortController | undefined;
  private popover: HTMLFormElement | undefined;
  private popoverObserver: ResizeObserver | undefined;
  private selectionVersion = 0;
  private context:
    | {
        page: SelectionPage;
        point: { x: number; y: number };
        clientX: number;
        clientY: number;
      }
    | undefined;
  private menuListeners: AbortController | undefined;

  constructor(private readonly host: RequestHost) {}

  begin(): void {
    const page = this.host.currentPage();
    if (!page || !this.host.handler()) {
      return;
    }
    this.active = true;
    this.pageNumber = page.number;
    this.sent = false;
    this.host.requestUpdate();
  }

  private retireSelection(): void {
    this.closeContextMenu();
    this.selectionVersion++;
    this.submission?.abort();
    this.submission = undefined;
    this.busy = false;
    this.region = this.drag = undefined;
    this.selectedText = this.error = "";
    this.releasePopover();
  }

  reset(): void {
    this.retireSelection();
    this.active = this.sent = false;
    this.instruction = "";
    this.host.requestUpdate();
  }

  dismissSelection(): void {
    this.retireSelection();
    this.instruction = "";
    this.host.requestUpdate();
  }

  changePage(pageNumber: number): void {
    this.closeContextMenu();
    if (this.active && this.pageNumber !== pageNumber) {
      this.retireSelection();
      this.pageNumber = pageNumber;
      this.host.requestUpdate();
    }
  }

  private selectionPage(): SelectionPage | undefined {
    const page = this.host.currentPage();
    return this.active && page?.number === this.pageNumber ? page : undefined;
  }

  private point(event: MouseEvent, page: SelectionPage): { x: number; y: number } | undefined {
    const bounds = page.canvas.getBoundingClientRect();
    if (!page.canvas.isConnected || bounds.width <= 0 || bounds.height <= 0) {
      return undefined;
    }
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  contextMenu = (event: MouseEvent): void => {
    const page = this.host.currentPage();
    if (!page || this.busy || !this.host.handler()) {
      return;
    }
    const point = this.point(event, page);
    if (!point) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.closeContextMenu();
    this.context = { page, point, clientX: event.clientX, clientY: event.clientY };
    this.host.requestUpdate();
  };

  closeContextMenu = (): void => {
    this.menuListeners?.abort();
    this.menuListeners = undefined;
    if (this.context) {
      this.context = undefined;
      this.host.requestUpdate();
    }
  };

  private bindContextMenu = (element?: Element): void => {
    this.menuListeners?.abort();
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const listeners = new AbortController();
    this.menuListeners = listeners;
    const options = { capture: true, signal: listeners.signal };
    const outside = (event: Event) => {
      if (!event.composedPath().includes(element)) {
        this.closeContextMenu();
      }
    };
    document.addEventListener("pointerdown", outside, options);
    document.addEventListener("contextmenu", outside, options);
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            this.context?.page.canvas
              .closest<HTMLElement>(".stage")
              ?.focus({ preventScroll: true });
          }
          this.closeContextMenu();
        }
      },
      options,
    );
    window.addEventListener("resize", this.closeContextMenu, options);
    window.addEventListener("scroll", this.closeContextMenu, options);
  };

  renderContextMenu() {
    const context = this.context;
    const page = this.host.currentPage();
    if (
      !context ||
      !page ||
      page.canvas !== context.page.canvas ||
      page.number !== context.page.number
    ) {
      return nothing;
    }
    return keyed(
      context,
      html`<wa-dropdown
        class="request-context-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        size="s"
        aria-label=${t("chat.documentViewer.requestChanges")}
        @contextmenu=${(event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        ${ref(this.bindContextMenu)}
        @wa-after-hide=${() => {
          if (this.context === context) {
            this.closeContextMenu();
          }
        }}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          if (this.context !== context || event.detail.item.value !== "request-changes") {
            return;
          }
          const current = this.host.currentPage();
          this.closeContextMenu();
          if (
            !current ||
            current.canvas !== context.page.canvas ||
            current.number !== context.page.number ||
            this.busy ||
            !this.host.handler()
          ) {
            return;
          }
          this.begin();
          this.drag = undefined;
          this.selectPoint(current, context.point);
          this.selectionVersion++;
          this.host.requestUpdate();
        }}
      >
        <button
          slot="trigger"
          class="request-context-trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${t("chat.documentViewer.requestChanges")}
          style=${`left:${context.clientX}px;top:${context.clientY}px`}
        ></button>
        <wa-dropdown-item value="request-changes">
          <span slot="icon" class="request-icon" aria-hidden="true">${toolIcons.penLine}</span>
          ${t("chat.documentViewer.requestChanges")}
        </wa-dropdown-item>
      </wa-dropdown>`,
    );
  }

  private selectPoint(page: SelectionPage, point: { x: number; y: number }): void {
    let target: DocumentSelectionTarget | undefined;
    for (const candidate of page.targets ?? []) {
      const region = candidate.region;
      if (
        point.x >= region.x &&
        point.x <= region.x + region.width &&
        point.y >= region.y &&
        point.y <= region.y + region.height &&
        (!target || region.width * region.height < target.region.width * target.region.height)
      ) {
        target = candidate;
      }
    }
    this.selectedText = target ? truncateUtf16Safe(target.text, DOCUMENT_CHANGE_TEXT_MAX) : "";
    this.region = target
      ? { ...target.region }
      : {
          x: Math.max(0, Math.min(1 - POINT_REGION_WIDTH, point.x - POINT_REGION_WIDTH / 2)),
          y: Math.max(0, Math.min(1 - POINT_REGION_HEIGHT, point.y - POINT_REGION_HEIGHT / 2)),
          width: POINT_REGION_WIDTH,
          height: POINT_REGION_HEIGHT,
        };
    this.error = "";
  }

  pointerDown = (event: PointerEvent): void => {
    const page = this.selectionPage();
    if (!page || this.busy || event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    const point = this.point(event, page);
    if (!point) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    this.drag = { ...point, pointerId: event.pointerId, canvas: page.canvas };
    this.region = undefined;
    this.selectedText = this.error = "";
    this.host.requestUpdate();
  };

  pointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const page = this.selectionPage();
    if (!page || page.canvas !== drag.canvas) {
      this.pointerCancel();
      return;
    }
    const point = this.point(event, page);
    if (!point) {
      return;
    }
    this.region = {
      x: Math.min(drag.x, point.x),
      y: Math.min(drag.y, point.y),
      width: Math.abs(point.x - drag.x),
      height: Math.abs(point.y - drag.y),
    };
    this.host.requestUpdate();
  };

  pointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const page = this.selectionPage();
    if (!page || page.canvas !== drag.canvas) {
      this.pointerCancel();
      return;
    }
    const point = this.point(event, page);
    if (!point) {
      this.pointerCancel();
      return;
    }
    this.pointerMove(event);
    this.drag = undefined;
    const bounds = page.canvas.getBoundingClientRect();
    const distance = Math.hypot(
      (point.x - drag.x) * bounds.width,
      (point.y - drag.y) * bounds.height,
    );
    if (distance < 3) {
      this.selectPoint(page, point);
    } else if (this.region) {
      // Preserve real drags, including a thin horizontal/vertical gesture, with
      // a one-CSS-pixel minimum so the crop always has a nonempty source area.
      const width = Math.min(1, Math.max(this.region.width, 1 / bounds.width));
      const height = Math.min(1, Math.max(this.region.height, 1 / bounds.height));
      this.region = {
        x: Math.min(this.region.x, 1 - width),
        y: Math.min(this.region.y, 1 - height),
        width,
        height,
      };
    }
    this.selectionVersion++;
    this.host.requestUpdate();
  };

  pointerCancel = (): void => {
    if (this.drag) {
      this.region = undefined;
    }
    this.drag = undefined;
    this.host.requestUpdate();
  };

  private releasePopover(): void {
    this.popoverObserver?.disconnect();
    this.popoverObserver = undefined;
    window.removeEventListener("resize", this.positionPopover);
    window.removeEventListener("scroll", this.positionPopover, true);
    this.popover = undefined;
  }

  private bindPopover = (element?: Element): void => {
    this.releasePopover();
    if (!(element instanceof HTMLFormElement)) {
      return;
    }
    const stage = this.selectionPage()?.canvas.closest<HTMLElement>(".stage");
    if (!stage) {
      return;
    }
    this.popover = element;
    this.popoverObserver = new ResizeObserver(this.positionPopover);
    this.popoverObserver.observe(element);
    this.popoverObserver.observe(stage);
    window.addEventListener("resize", this.positionPopover);
    window.addEventListener("scroll", this.positionPopover, true);
    queueMicrotask(() => {
      if (this.popover === element && element.isConnected) {
        this.positionPopover();
        element.querySelector("textarea")?.focus({ preventScroll: true });
      }
    });
  };

  private positionPopover = (): void => {
    const form = this.popover;
    const page = this.selectionPage();
    const region = this.region;
    const stage = page?.canvas.closest<HTMLElement>(".stage");
    if (!form?.isConnected || !page?.canvas.isConnected || !region || !stage) {
      return;
    }
    const stageBounds = stage.getBoundingClientRect();
    const canvasBounds = page.canvas.getBoundingClientRect();
    let left = Math.max(stageBounds.left + stage.clientLeft, 0);
    let top = Math.max(stageBounds.top + stage.clientTop, 0);
    let right = Math.min(
      stageBounds.left + stage.clientLeft + stage.clientWidth,
      window.innerWidth,
    );
    let bottom = Math.min(
      stageBounds.top + stage.clientTop + stage.clientHeight,
      window.innerHeight,
    );
    // Intersect clipping ancestors too: inline previews may be in a scrolling
    // chat pane, with a visible stage smaller than its full document rectangle.
    let ancestor: Element | null = stage.parentElement;
    while (ancestor) {
      const style = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowX)) {
        left = Math.max(left, bounds.left + ancestor.clientLeft);
        right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/u.test(style.overflowY)) {
        top = Math.max(top, bounds.top + ancestor.clientTop);
        bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight);
      }
      const root = ancestor.getRootNode();
      ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }
    if (right <= left || bottom <= top) {
      form.style.visibility = "hidden";
      return;
    }
    const marginX = Math.min(POPOVER_MARGIN, (right - left) / 4);
    const marginY = Math.min(POPOVER_MARGIN, (bottom - top) / 4);
    left += marginX;
    right -= marginX;
    top += marginY;
    bottom -= marginY;
    const width = Math.min(POPOVER_WIDTH, right - left);
    const maxHeight = bottom - top;
    form.style.setProperty("--request-popover-width", `${width}px`);
    form.style.setProperty("--request-popover-max-height", `${maxHeight}px`);
    const height = Math.min(form.getBoundingClientRect().height, maxHeight);
    const selectionLeft = canvasBounds.left + region.x * canvasBounds.width;
    const selectionRight = selectionLeft + region.width * canvasBounds.width;
    const selectionTop = canvasBounds.top + region.y * canvasBounds.height;
    const selectionBottom = selectionTop + region.height * canvasBounds.height;
    const beside = selectionRight + POPOVER_GAP + width <= right;
    const preferredLeft = beside ? selectionRight + POPOVER_GAP : selectionLeft;
    let preferredTop = beside ? selectionTop : selectionBottom + POPOVER_GAP;
    if (preferredTop + height > bottom) {
      preferredTop = selectionTop - height - POPOVER_GAP;
    }
    const x = Math.max(left, Math.min(right - width, preferredLeft));
    const y = Math.max(top, Math.min(bottom - height, preferredTop));
    form.style.setProperty(
      "--request-popover-left",
      `${x - stageBounds.left - stage.clientLeft + stage.scrollLeft}px`,
    );
    form.style.setProperty(
      "--request-popover-top",
      `${y - stageBounds.top - stage.clientTop + stage.scrollTop}px`,
    );
    form.style.visibility = "visible";
  };

  renderOverlay() {
    const region = this.region;
    return this.active && region
      ? html`<div
          class="selection-region"
          aria-label=${t("chat.documentViewer.selectedRegion")}
          style=${`left:${region.x * 100}%;top:${region.y * 100}%;width:${region.width * 100}%;height:${region.height * 100}%`}
        ></div>`
      : nothing;
  }

  renderStatus() {
    return this.sent
      ? html`<div class="request-result" role="status">
          ${t("chat.documentViewer.requestSent")}
        </div>`
      : nothing;
  }

  renderPopover() {
    if (!this.selectionPage() || !this.region || this.drag) {
      return nothing;
    }
    return keyed(
      this.selectionVersion,
      html`<form
        class="request-popover"
        style="visibility:hidden"
        ${ref(this.bindPopover)}
        @submit=${this.submit}
      >
        <header class="request-popover-header">
          <strong>${t("chat.documentViewer.requestChanges")}</strong>
          <button
            type="button"
            aria-label=${t("chat.documentViewer.cancelRequest")}
            ?disabled=${this.busy}
            @click=${() => this.dismissSelection()}
          >
            ×
          </button>
        </header>
        ${this.selectedText
          ? html`<blockquote
              class="selected-text"
              aria-label=${t("chat.documentViewer.selectedText")}
            >
              ${this.selectedText}
            </blockquote>`
          : nothing}
        <textarea
          class="request-instruction"
          rows="2"
          maxlength=${DOCUMENT_CHANGE_INSTRUCTION_MAX}
          aria-label=${t("chat.documentViewer.instruction")}
          placeholder=${t("chat.documentViewer.instructionPlaceholder")}
          .value=${this.instruction}
          ?disabled=${this.busy}
          @input=${(event: Event) => {
            if (event.currentTarget instanceof HTMLTextAreaElement) {
              this.instruction = truncateUtf16Safe(
                event.currentTarget.value,
                DOCUMENT_CHANGE_INSTRUCTION_MAX,
              );
              this.host.requestUpdate();
            }
          }}
        ></textarea>
        ${this.error ? html`<div class="request-error" role="alert">${this.error}</div>` : nothing}
        <button
          type="submit"
          ?disabled=${this.busy || !this.instruction.trim() || !this.selectionPage()}
        >
          ${this.busy ? t("common.loading") : t("chat.documentViewer.submitRequest")}
        </button>
      </form>`,
    );
  }

  private captureCrop(canvas: HTMLCanvasElement, region: DocumentChangeRegion): string {
    const width = Math.max(1, Math.round(canvas.width * region.width));
    const height = Math.max(1, Math.round(canvas.height * region.height));
    const scale = Math.min(
      1,
      Math.sqrt(CROP_MAX_PIXELS / (width * height)),
      CROP_MAX_DIMENSION / width,
      CROP_MAX_DIMENSION / height,
    );
    const crop = document.createElement("canvas");
    try {
      crop.width = Math.max(1, Math.floor(width * scale));
      crop.height = Math.max(1, Math.floor(height * scale));
      const context = crop.getContext("2d");
      if (!context) {
        throw new Error("Canvas unavailable");
      }
      context.drawImage(
        canvas,
        canvas.width * region.x,
        canvas.height * region.y,
        width,
        height,
        0,
        0,
        crop.width,
        crop.height,
      );
      const data = crop.toDataURL("image/png");
      const encoded = data.slice("data:image/png;base64,".length);
      const bytes =
        Math.floor((encoded.length * 3) / 4) -
        (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
      if (!data.startsWith("data:image/png;base64,") || bytes > DOCUMENT_CHANGE_CROP_MAX_BYTES) {
        throw new Error("Crop exceeds attachment bound");
      }
      return data;
    } finally {
      crop.width = crop.height = 0;
    }
  }

  private submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    const page = this.host.currentPage();
    const handler = this.host.handler();
    const instruction = this.instruction.trim();
    if (
      !this.active ||
      this.busy ||
      !page ||
      page.number !== this.pageNumber ||
      !handler ||
      !instruction ||
      (!this.region && !this.selectedText)
    ) {
      return;
    }
    this.error = "";
    let cropDataUrl: string | undefined;
    if (this.region) {
      try {
        cropDataUrl = this.captureCrop(page.canvas, this.region);
      } catch {
        this.error = t("chat.documentViewer.requestCropError");
        this.host.requestUpdate();
        return;
      }
    }
    const submission = new AbortController();
    this.submission = submission;
    this.busy = true;
    this.host.requestUpdate();
    try {
      const result = await handler(
        {
          pageNumber: page.number,
          region: this.region,
          selectedText: this.selectedText || undefined,
          instruction,
          cropDataUrl,
        },
        submission.signal,
      );
      if (this.submission !== submission) {
        return;
      }
      if (result.admitted) {
        this.reset();
        this.sent = true;
      } else {
        this.error = result.message
          ? truncateUtf16Safe(result.message, 500)
          : t("chat.documentViewer.requestUnavailable");
      }
    } catch {
      if (this.submission === submission) {
        this.error = t("chat.documentViewer.requestUnavailable");
      }
    } finally {
      if (this.submission === submission) {
        this.submission = undefined;
        this.busy = false;
      }
      this.host.requestUpdate();
    }
  };
}
