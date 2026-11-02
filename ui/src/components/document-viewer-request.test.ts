/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_CHANGE_CROP_MAX_BYTES,
  DOCUMENT_CHANGE_INSTRUCTION_MAX,
  DOCUMENT_CHANGE_TEXT_MAX,
  DocumentViewerRequestController,
  type DocumentChangeHandler,
  type DocumentChangeResult,
} from "./document-viewer-request.ts";
import type { DocumentSelectionTarget } from "./document-viewer-selection.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP3sAAAAASUVORK5CYII=";
const drawImage = vi.fn<(...args: unknown[]) => void>();
const resizeObservers: TestResizeObserver[] = [];
const requestControllers: DocumentViewerRequestController[] = [];
let originalGetContext: PropertyDescriptor | undefined;
class TestResizeObserver {
  disconnected = false;
  constructor(readonly notify: () => void) {
    resizeObservers.push(this);
  }
  observe() {}
  disconnect(): void {
    this.disconnected = true;
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function mountRequest(options: { stageBounds?: DOMRect; canvasBounds?: DOMRect } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const canvas = document.createElement("canvas");
  canvas.width = 1_200;
  canvas.height = 800;
  let pageNumber = 1;
  let available = true;
  let handlerAvailable = true;
  let targets: readonly DocumentSelectionTarget[] = [
    { region: { x: 0.1, y: 0.1, width: 0.7, height: 0.2 }, text: "A larger text run" },
    { region: { x: 0.2, y: 0.1, width: 0.2, height: 0.08 }, text: "Owned title" },
  ];
  const handler = vi
    .fn<DocumentChangeHandler>()
    .mockResolvedValue({ admitted: false, message: "Choose the current document." });
  const stageBounds = options.stageBounds ?? new DOMRect(80, 60, 640, 500);
  const canvasBounds = options.canvasBounds ?? new DOMRect(100, 80, 600, 400);
  let stage: HTMLDivElement | undefined;
  const measuredForms = new WeakSet<Element>();
  vi.spyOn(canvas, "getBoundingClientRect").mockImplementation(
    () =>
      new DOMRect(
        canvasBounds.x - (stage?.scrollLeft ?? 0),
        canvasBounds.y - (stage?.scrollTop ?? 0),
        canvasBounds.width,
        canvasBounds.height,
      ),
  );
  const refresh = () => {
    render(
      html`<div class="stage" tabindex="0">
          <div
            class="page-surface"
            @pointerdown=${controller.pointerDown}
            @pointermove=${controller.pointerMove}
            @pointerup=${controller.pointerUp}
            @pointercancel=${controller.pointerCancel}
            @contextmenu=${controller.contextMenu}
          >
            ${canvas}${controller.renderOverlay()}
          </div>
          ${controller.renderPopover()}${controller.renderContextMenu()}
        </div>
        ${controller.renderStatus()}`,
      container,
    );
    stage = container.querySelector<HTMLDivElement>(".stage") ?? undefined;
    const surface = container.querySelector<HTMLElement>(".page-surface");
    if (!stage || !surface) {
      throw new Error("Missing document stage");
    }
    // jsdom does not lay out canvases or provide native pointer capture. These
    // geometry/capture adapters let real DOM events exercise the controller;
    // pixel correctness and actual layout belong to the Chromium scenario.
    Object.defineProperties(stage, {
      clientWidth: { configurable: true, value: stageBounds.width },
      clientHeight: { configurable: true, value: stageBounds.height },
    });
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(stageBounds);
    surface.setPointerCapture = vi.fn();
    const form = container.querySelector("form");
    if (form && !measuredForms.has(form)) {
      measuredForms.add(form);
      vi.spyOn(form, "getBoundingClientRect").mockImplementation(
        () =>
          new DOMRect(
            stageBounds.x +
              Number.parseFloat(form.style.getPropertyValue("--request-popover-left") || "0") -
              (stage?.scrollLeft ?? 0),
            stageBounds.y +
              Number.parseFloat(form.style.getPropertyValue("--request-popover-top") || "0") -
              (stage?.scrollTop ?? 0),
            Number.parseFloat(form.style.getPropertyValue("--request-popover-width") || "300"),
            Math.min(
              160,
              Number.parseFloat(
                form.style.getPropertyValue("--request-popover-max-height") || "160",
              ),
            ),
          ),
      );
    }
  };
  const controller = new DocumentViewerRequestController({
    requestUpdate: () => {
      queueMicrotask(refresh);
    },
    currentPage: () =>
      container.isConnected && available ? { number: pageNumber, canvas, targets } : undefined,
    handler: () => (handlerAvailable ? handler : undefined),
  });
  requestControllers.push(controller);
  refresh();
  const pointer = (type: string, x: number, y: number) => {
    const bounds = canvas.getBoundingClientRect();
    container.querySelector(".page-surface")?.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        button: 0,
        clientX: bounds.left + bounds.width * x,
        clientY: bounds.top + bounds.height * y,
        bubbles: true,
      }),
    );
  };
  return {
    container,
    canvas,
    controller,
    handler,
    pointer,
    setAvailable: (value: boolean) => {
      available = value;
    },
    setHandlerAvailable: (value: boolean) => {
      handlerAvailable = value;
    },
    contextMenu: async (x = 0.25, y = 0.13) => {
      const bounds = canvas.getBoundingClientRect();
      const event = new MouseEvent("contextmenu", {
        button: 2,
        clientX: bounds.left + bounds.width * x,
        clientY: bounds.top + bounds.height * y,
        bubbles: true,
        cancelable: true,
      });
      container.querySelector(".page-surface")?.dispatchEvent(event);
      await Promise.resolve();
      await Promise.resolve();
      return event;
    },
    setTargets: (value: readonly DocumentSelectionTarget[]) => {
      targets = value;
    },
    select: async (x = 0.25, y = 0.13) => {
      pointer("pointerdown", x, y);
      pointer("pointerup", x, y);
      if (controller.active) {
        await vi.waitFor(() => expect(container.querySelector("form")).not.toBeNull());
      }
    },
    instruction: async (value: string) => {
      const input = container.querySelector("textarea");
      if (!input) {
        throw new Error("Missing explicit request input");
      }
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
      return input;
    },
    changePage: async (number: number) => {
      pageNumber = number;
      controller.changePage(number);
      await Promise.resolve();
    },
  };
}

beforeEach(() => {
  resizeObservers.length = 0;
  requestControllers.length = 0;
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  // The controller's Canvas2D boundary only needs drawImage. This narrow adapter
  // controls encoding success/failure; it does not claim to validate PDF pixels.
  originalGetContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(kind: string): Pick<CanvasRenderingContext2D, "drawImage"> | null {
      return kind === "2d" ? { drawImage } : null;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(PNG);
  drawImage.mockClear();
});

afterEach(() => {
  requestControllers.forEach((controller) => controller.reset());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  if (originalGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
  } else {
    Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
  }
  vi.unstubAllGlobals();
});

function submit(container: HTMLElement): void {
  container.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("inline document selection requests", () => {
  it("requires the right-click menu action before selecting the same title and submitting", async () => {
    const request = mountRequest();
    const bubbled = vi.fn();
    request.container.addEventListener("contextmenu", bubbled);
    const event = await request.contextMenu();
    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
    expect(request.controller.active).toBe(false);
    expect(request.container.querySelector("form")).toBeNull();
    const action = request.container.querySelector<HTMLButtonElement>('[role="menuitem"]');
    expect(action?.textContent?.trim()).toBe("Request changes");
    expect(document.activeElement).toBe(action);
    action?.click();
    await vi.waitFor(() => expect(request.container.querySelector("form")).not.toBeNull());
    expect(request.container.querySelector('[role="menu"]')).toBeNull();
    expect(request.container.querySelector(".selected-text")?.textContent).toContain("Owned title");
    expect(request.handler).not.toHaveBeenCalled();
    await request.instruction("Make this title shorter.");
    submit(request.container);
    await vi.waitFor(() => expect(request.handler).toHaveBeenCalledTimes(1));
    expect(request.handler.mock.calls[0]?.[0]).toMatchObject({
      pageNumber: 1,
      region: { x: 0.2, y: 0.1, width: 0.2, height: 0.08 },
      selectedText: "Owned title",
      instruction: "Make this title shorter.",
      cropDataUrl: PNG,
    });
  });

  it("dismisses transient menus without losing the existing selection or unsent draft", async () => {
    const request = mountRequest();
    request.controller.begin();
    await request.select();
    await request.instruction("Keep my draft.");
    const dismissals = [
      () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
      () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
      () => window.dispatchEvent(new Event("scroll")),
      () => window.dispatchEvent(new Event("resize")),
    ];
    for (const dismiss of dismissals) {
      await request.contextMenu(0.9, 0.9);
      expect(request.container.querySelector('[role="menu"]')).not.toBeNull();
      dismiss();
      await Promise.resolve();
      expect(request.container.querySelector('[role="menu"]')).toBeNull();
      expect(request.container.querySelector("textarea")?.value).toBe("Keep my draft.");
      expect(request.container.querySelector(".selected-text")?.textContent).toContain(
        "Owned title",
      );
    }
    expect(request.handler).not.toHaveBeenCalled();
  });

  it("retires menus with their page/document and leaves unavailable or pending previews alone", async () => {
    const request = mountRequest();
    await request.contextMenu();
    await request.changePage(2);
    expect(request.container.querySelector('[role="menu"]')).toBeNull();
    await request.contextMenu();
    request.controller.reset();
    await Promise.resolve();
    expect(request.container.querySelector('[role="menu"]')).toBeNull();
    request.setAvailable(false);
    expect((await request.contextMenu()).defaultPrevented).toBe(false);
    request.setAvailable(true);
    request.setHandlerAvailable(false);
    expect((await request.contextMenu()).defaultPrevented).toBe(false);
    request.setHandlerAvailable(true);
    const pending = deferred<DocumentChangeResult>();
    request.handler.mockReturnValueOnce(pending.promise);
    request.controller.begin();
    await request.select();
    await request.instruction("Pending request.");
    submit(request.container);
    expect((await request.contextMenu()).defaultPrevented).toBe(false);
    expect(request.container.querySelector('[role="menu"]')).toBeNull();
    pending.resolve({ admitted: false });
    await vi.waitFor(() => expect(request.controller.busy).toBe(false));
  });

  it("ignores ordinary clicks and only opens a popover after an explicit mode selection", async () => {
    const request = mountRequest();
    await request.select();
    expect(request.container.querySelector("form")).toBeNull();
    request.controller.begin();
    await Promise.resolve();
    expect(request.container.querySelector("form")).toBeNull();
    await request.select();
    expect(request.container.querySelector(".selected-text")?.textContent).toContain("Owned title");
    expect(request.container.querySelector(".request-popover")?.closest(".stage")).not.toBeNull();
    expect(request.handler).not.toHaveBeenCalled();
  });

  it("uses the smallest hit text box and retains a bounded refused request", async () => {
    const request = mountRequest();
    request.setTargets([
      {
        region: { x: 0.2, y: 0.1, width: 0.2, height: 0.08 },
        text: "A".repeat(DOCUMENT_CHANGE_TEXT_MAX + 100),
      },
    ]);
    request.controller.begin();
    await request.select();
    const input = await request.instruction("I".repeat(DOCUMENT_CHANGE_INSTRUCTION_MAX + 100));
    submit(request.container);
    await vi.waitFor(() =>
      expect(request.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Choose the current document.",
      ),
    );
    expect(input.value).toHaveLength(DOCUMENT_CHANGE_INSTRUCTION_MAX);
    expect(request.handler.mock.calls[0]?.[0]).toMatchObject({
      pageNumber: 1,
      region: { x: 0.2, y: 0.1, width: 0.2, height: 0.08 },
      cropDataUrl: PNG,
    });
    expect(request.handler.mock.calls[0]?.[0].selectedText).toHaveLength(DOCUMENT_CHANGE_TEXT_MAX);
    expect(request.handler.mock.calls[0]?.[0].instruction).toHaveLength(
      DOCUMENT_CHANGE_INSTRUCTION_MAX,
    );
    expect(request.container.querySelector(".selected-text")).not.toBeNull();
    expect(request.container.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("uses a clamped point crop on blank content and preserves actual drag regions", async () => {
    const request = mountRequest();
    request.controller.begin();
    await request.select(0.99, 0.99);
    await request.instruction("Change this corner.");
    submit(request.container);
    await vi.waitFor(() => expect(request.handler).toHaveBeenCalledTimes(1));
    expect(request.handler.mock.calls[0]?.[0]).toMatchObject({
      region: { width: 0.35, height: 0.18 },
    });
    expect(request.handler.mock.calls[0]?.[0].region?.x).toBeCloseTo(0.65);
    expect(request.handler.mock.calls[0]?.[0].region?.y).toBeCloseTo(0.82);
    expect(request.handler.mock.calls[0]?.[0].selectedText).toBeUndefined();
    await vi.waitFor(() => expect(request.controller.busy).toBe(false));
    request.pointer("pointerdown", 0.15, 0.15);
    request.pointer("pointermove", 0.65, 0.55);
    await Promise.resolve();
    expect(request.container.querySelector("form")).toBeNull();
    request.pointer("pointerup", 0.65, 0.55);
    await vi.waitFor(() => expect(request.container.querySelector("form")).not.toBeNull());
    submit(request.container);
    await vi.waitFor(() => expect(request.handler).toHaveBeenCalledTimes(2));
    expect(request.handler.mock.calls[1]?.[0].region?.width).toBeCloseTo(0.5);
    expect(request.handler.mock.calls[1]?.[0].region?.height).toBeCloseTo(0.4);
    expect(request.handler.mock.calls[1]?.[0].selectedText).toBeUndefined();
  });

  it("dismisses selection without ending the mode and releases popover layout listeners", async () => {
    const request = mountRequest();
    request.controller.begin();
    await request.select();
    await request.instruction("Discard this draft.");
    request.container.querySelector<HTMLButtonElement>('[aria-label="Cancel request"]')?.click();
    await Promise.resolve();
    expect(request.container.querySelector("form")).toBeNull();
    expect(request.controller.active).toBe(true);
    expect(resizeObservers.every((observer) => observer.disconnected)).toBe(true);
    await request.select();
    expect(request.container.querySelector("textarea")?.value).toBe("");
    request.controller.reset();
    await Promise.resolve();
    expect(request.controller.active).toBe(false);
    expect(request.container.querySelector("form")).toBeNull();
    expect(request.handler).not.toHaveBeenCalled();
  });

  it("hides stale page selection while preserving instructions for a new selection", async () => {
    const request = mountRequest();
    request.controller.begin();
    await request.select();
    await request.instruction("Keep these instructions.");
    await request.changePage(2);
    expect(request.container.querySelector("form")).toBeNull();
    await request.select();
    expect(request.container.querySelector("textarea")?.value).toBe("Keep these instructions.");
    expect(request.handler).not.toHaveBeenCalled();
  });

  it("clears an admitted request exactly once and ignores a retired pending completion", async () => {
    const request = mountRequest();
    const pending = deferred<DocumentChangeResult>();
    request.handler.mockReturnValueOnce(pending.promise);
    request.controller.begin();
    await request.select();
    await request.instruction("Make this title shorter.");
    submit(request.container);
    submit(request.container);
    expect(request.handler).toHaveBeenCalledTimes(1);
    pending.resolve({ admitted: true });
    await vi.waitFor(() => expect(request.container.querySelector("form")).toBeNull());
    expect(request.container.querySelector('[role="status"]')?.textContent).toContain(
      "Request sent",
    );
    const old = deferred<DocumentChangeResult>();
    request.handler.mockReturnValueOnce(old.promise);
    request.controller.begin();
    await request.select();
    await request.instruction("Old instructions.");
    submit(request.container);
    const signal = request.handler.mock.calls[1]?.[1];
    request.controller.reset();
    expect(signal?.aborted).toBe(true);
    request.controller.begin();
    await request.select();
    await request.instruction("New instructions.");
    old.resolve({ admitted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(request.container.querySelector("textarea")?.value).toBe("New instructions.");
    expect(request.container.querySelector('[role="status"]')).toBeNull();
  });

  it("retains the selected context and draft when PNG encoding exceeds the attachment bound", async () => {
    const request = mountRequest();
    request.controller.begin();
    await request.select();
    await request.instruction("Keep these instructions after capture failure.");
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValueOnce(
      "data:image/png;base64," +
        "A".repeat(Math.ceil((DOCUMENT_CHANGE_CROP_MAX_BYTES + 10) / 3) * 4),
    );
    submit(request.container);
    await vi.waitFor(() =>
      expect(request.container.querySelector('[role="alert"]')?.textContent).toContain(
        "could not be captured",
      ),
    );
    expect(request.container.querySelector("textarea")?.value).toContain("Keep these instructions");
    expect(request.container.querySelector(".selected-text")).not.toBeNull();
    expect(request.handler).not.toHaveBeenCalled();
  });

  it("keeps the measured mobile popover within the visible stage and updates it on scroll", async () => {
    vi.stubGlobal("innerWidth", 390);
    const request = mountRequest({
      stageBounds: new DOMRect(10, 30, 370, 220),
      canvasBounds: new DOMRect(20, 40, 350, 200),
    });
    request.controller.begin();
    await request.select(0.99, 0.99);
    const form = request.container.querySelector("form");
    const stage = request.container.querySelector<HTMLElement>(".stage");
    if (!form || !stage) {
      throw new Error("Missing anchored mobile popover");
    }
    const assertVisible = () => {
      const bounds = form.getBoundingClientRect();
      expect(form.style.visibility).toBe("visible");
      expect(bounds.left).toBeGreaterThanOrEqual(10);
      expect(bounds.right).toBeLessThanOrEqual(380);
      expect(bounds.top).toBeGreaterThanOrEqual(30);
      expect(bounds.bottom).toBeLessThanOrEqual(250);
    };
    await vi.waitFor(assertVisible);
    stage.scrollTop = 80;
    stage.dispatchEvent(new Event("scroll"));
    assertVisible();
    resizeObservers
      .filter((observer) => !observer.disconnected)
      .forEach((observer) => observer.notify());
    assertVisible();
  });
});
