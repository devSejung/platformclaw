/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import type { PDFPageProxy } from "./pdf-document.runtime.ts";
import "./document-viewer.ts";

type TestText = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
type TestPage = {
  getViewport: ReturnType<
    typeof vi.fn<
      (options: { scale: number }) => { width: number; height: number; transform: number[] }
    >
  >;
  getTextContent: ReturnType<typeof vi.fn<() => Promise<TestText>>>;
  cleanup: ReturnType<typeof vi.fn>;
};
type TestRenderTask = { promise: Promise<void>; cancel: ReturnType<typeof vi.fn> };
type TestHandle = { promise: Promise<unknown>; destroy: () => Promise<void> };

const runtime = vi.hoisted(() => ({
  openPdfDocument:
    vi.fn<
      (
        bytes: Uint8Array | ArrayBuffer,
        onFailure: (kind: "password" | "unavailable") => void,
      ) => TestHandle
    >(),
  renderPdfPage:
    vi.fn<
      (
        page: TestPage,
        canvas: HTMLCanvasElement,
        viewport: { width: number; height: number },
      ) => TestRenderTask
    >(),
}));

const resizeObservers: TestResizeObserver[] = [];

class TestResizeObserver {
  target: Element | undefined;
  constructor(private readonly callback: () => void) {
    resizeObservers.push(this);
  }
  observe(target: Element): void {
    this.target = target;
  }
  unobserve(): void {
    this.target = undefined;
  }
  disconnect(): void {
    this.target = undefined;
  }
  notify(): void {
    if (this.target) {
      this.callback();
    }
  }
}

// Pixel/font/worker integration belongs to the real browser scenario. Only the
// narrow PDF runtime is replaced here to control otherwise nondeterministic races.
vi.mock("./pdf-document.runtime.ts", () => runtime);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createPdf(pageCount = 2) {
  const pages: TestPage[] = Array.from({ length: pageCount }, (_, index) => ({
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
      transform: [scale, 0, 0, -scale, 0, 792 * scale],
    })),
    getTextContent: vi.fn(async () => pageText(`Page ${index + 1} text`)),
    cleanup: vi.fn(),
  }));
  return {
    pages,
    numPages: pageCount,
    getPage: vi.fn(async (number: number) => {
      const page = pages[number - 1];
      if (!page) {
        throw new Error("requested page is outside the test document");
      }
      return page;
    }),
  };
}

function pageText(text: string): TestText {
  return {
    items: [
      {
        str: text,
        hasEOL: true,
        dir: "ltr",
        transform: [16, 0, 0, 16, 50, 700],
        width: 100,
        height: 16,
        fontName: "body",
      },
    ],
    styles: { body: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: "sans-serif" } },
    lang: "en",
  };
}

function createHandle() {
  const loading = deferred<ReturnType<typeof createPdf>>();
  const destroy = vi.fn(async () => {});
  return { loading, destroy, handle: { promise: loading.promise, destroy } };
}

async function mount() {
  const viewer = document.createElement("openclaw-document-viewer");
  viewer.bytes = new Uint8Array([1]);
  viewer.documentTitle = "Owned report.pdf";
  const loaded = vi.fn();
  const failed = vi.fn();
  viewer.addEventListener("document-viewer-load", loaded);
  viewer.addEventListener("document-viewer-error", failed);
  document.body.append(viewer);
  await vi.waitFor(() => expect(runtime.openPdfDocument).toHaveBeenCalledTimes(1));
  const stage = viewer.shadowRoot?.querySelector<HTMLElement>(".stage");
  if (!stage) {
    throw new Error("document viewer did not mount its page stage");
  }
  // jsdom has no layout/adopted stylesheet measurements. These fixed stage
  // dimensions merely allow the production render lifecycle to reach its runtime.
  stage.style.padding = "16px";
  Object.defineProperties(stage, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  await settleLitElement(viewer);
  return { viewer, loaded, failed };
}

async function ready(viewer: HTMLElementTagNameMap["openclaw-document-viewer"], page = 1) {
  await vi.waitFor(() => {
    expect(viewer.getAttribute("data-render-state")).toBe("ready");
    expect(viewer.shadowRoot?.querySelector("canvas")?.getAttribute("data-rendered-page")).toBe(
      String(page),
    );
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  resizeObservers.length = 0;
  runtime.renderPdfPage.mockImplementation(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("document viewer asynchronous ownership", () => {
  it("destroys a replaced load and ignores its late document and failure callback", async () => {
    const first = createHandle();
    const second = createHandle();
    runtime.openPdfDocument.mockReturnValueOnce(first.handle).mockReturnValueOnce(second.handle);
    const { viewer, loaded, failed } = await mount();
    viewer.bytes = new Uint8Array([2]);
    await vi.waitFor(() => expect(runtime.openPdfDocument).toHaveBeenCalledTimes(2));
    expect(first.destroy).toHaveBeenCalledTimes(1);
    const currentPdf = createPdf(3);
    second.loading.resolve(currentPdf);
    await ready(viewer);
    const oldPdf = createPdf();
    first.loading.resolve(oldPdf);
    runtime.openPdfDocument.mock.calls[0]![1]("password");
    await settleLitElement(viewer);
    expect(oldPdf.getPage).not.toHaveBeenCalled();
    expect(viewer.shadowRoot?.querySelector("canvas")?.getAttribute("data-page-count")).toBe("3");
    expect(viewer.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    viewer.remove();
    expect(second.destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys a disconnected pending load without publishing its late result", async () => {
    const pending = createHandle();
    runtime.openPdfDocument.mockReturnValueOnce(pending.handle);
    const { viewer, loaded, failed } = await mount();
    viewer.remove();
    expect(pending.destroy).toHaveBeenCalledTimes(1);
    const pdf = createPdf();
    pending.loading.resolve(pdf);
    await settleLitElement(viewer);
    expect(pdf.getPage).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });

  it.each(["replacement", "disconnect"] as const)(
    "cancels an active render on %s without late publication",
    async (action) => {
      const pending = createHandle();
      const replacement = createHandle();
      const rendering = deferred<void>();
      const cancel = vi.fn();
      runtime.openPdfDocument
        .mockReturnValueOnce(pending.handle)
        .mockReturnValueOnce(replacement.handle);
      runtime.renderPdfPage.mockReturnValueOnce({ promise: rendering.promise, cancel });
      const { viewer, loaded, failed } = await mount();
      const pdf = createPdf();
      pending.loading.resolve(pdf);
      await vi.waitFor(() => expect(runtime.renderPdfPage).toHaveBeenCalledTimes(1));
      const canvas = viewer.shadowRoot?.querySelector("canvas");
      expect(canvas?.width).toBeGreaterThan(0);
      if (action === "replacement") {
        viewer.bytes = new Uint8Array([2]);
        await vi.waitFor(() => expect(runtime.openPdfDocument).toHaveBeenCalledTimes(2));
      } else {
        viewer.remove();
      }
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pending.destroy).toHaveBeenCalledTimes(1);
      expect(canvas?.width).toBe(0);
      if (action === "replacement") {
        replacement.loading.resolve(createPdf(3));
        await ready(viewer);
      }
      rendering.resolve();
      await settleLitElement(viewer);
      expect(pdf.pages[0]?.getTextContent).not.toHaveBeenCalled();
      expect(loaded).toHaveBeenCalledTimes(action === "replacement" ? 1 : 0);
      if (action === "replacement") {
        expect(viewer.shadowRoot?.querySelector("canvas")?.getAttribute("data-page-count")).toBe(
          "3",
        );
      }
      expect(failed).not.toHaveBeenCalled();
    },
  );

  it.each(["password", "parse"] as const)(
    "retires a failed %s load with a safe visible outcome",
    async (failure) => {
      const document = createHandle();
      runtime.openPdfDocument.mockReturnValueOnce(document.handle);
      const { viewer, loaded, failed } = await mount();
      if (failure === "password") {
        runtime.openPdfDocument.mock.calls[0]![1]("password");
      } else {
        document.loading.reject(new Error("private parser diagnostic"));
      }
      await vi.waitFor(() => expect(viewer.getAttribute("data-render-state")).toBe("error"));
      await settleLitElement(viewer);
      const text = viewer.shadowRoot?.querySelector('[role="alert"]')?.textContent;
      expect(text).toContain(
        failure === "password" ? "requires a password" : "could not be displayed",
      );
      expect(text).not.toContain("private parser diagnostic");
      expect(document.destroy).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(loaded).not.toHaveBeenCalled();
    },
  );

  it("never publishes an older page whose text completes after a newer page", async () => {
    const document = createHandle();
    runtime.openPdfDocument.mockReturnValueOnce(document.handle);
    const pdf = createPdf();
    const oldText = deferred<TestText>();
    const firstPage = pdf.pages[0];
    if (!firstPage) {
      throw new Error("test document requires a first page");
    }
    firstPage.getTextContent.mockReturnValueOnce(oldText.promise);
    const firstCancel = vi.fn();
    runtime.renderPdfPage.mockReturnValueOnce({ promise: Promise.resolve(), cancel: firstCancel });
    const { viewer, loaded } = await mount();
    document.loading.resolve(pdf);
    await vi.waitFor(() => expect(firstPage.getTextContent).toHaveBeenCalledTimes(1));
    const nextPage = viewer.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[aria-label="Next page"]',
    );
    if (!nextPage || nextPage.disabled) {
      throw new Error("loaded document must permit page navigation during rendering");
    }
    nextPage.click();
    await ready(viewer, 2);
    expect(firstCancel).toHaveBeenCalledTimes(1);
    expect(firstPage.cleanup).toHaveBeenCalledTimes(1);
    oldText.resolve(pageText("Retired first page"));
    await settleLitElement(viewer);
    expect(viewer.shadowRoot?.querySelector("canvas")?.getAttribute("data-rendered-page")).toBe(
      "2",
    );
    expect(viewer.shadowRoot?.querySelector(".page-text")?.textContent).toContain("Page 2 text");
    expect(viewer.shadowRoot?.textContent).not.toContain("Retired first page");
    expect(loaded).toHaveBeenCalledTimes(1);
  });
});

describe("document viewer contents lifecycle", () => {
  async function mountReady(pageCount = 2) {
    const loading = createHandle();
    runtime.openPdfDocument.mockReturnValueOnce(loading.handle);
    const result = await mount();
    const pdf = createPdf(pageCount);
    loading.loading.resolve(pdf);
    await ready(result.viewer);
    return { ...result, pdf };
  }

  function button(viewer: HTMLElementTagNameMap["openclaw-document-viewer"], label: string) {
    const result = [...(viewer.shadowRoot?.querySelectorAll("button") ?? [])].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
    );
    if (!result) {
      throw new Error(`Missing document control: ${label}`);
    }
    return result;
  }

  it("opens at page width with minimal footer navigation and copy text inside closed options", async () => {
    const { viewer } = await mountReady();
    const root = viewer.shadowRoot;
    const canvas = root?.querySelector<HTMLCanvasElement>("canvas.current-page");
    const layout = root?.querySelector(".page-layout");
    const footer = root?.querySelector("footer.toolbar");
    const options = root?.querySelector<HTMLDetailsElement>("details.preview-options");
    if (!canvas || !layout || !footer || !options) {
      throw new Error("Missing inline document presentation");
    }
    expect(canvas.style.width).toBe("768px");
    expect(Number.parseFloat(canvas.style.height)).toBeGreaterThan(600);
    expect(layout.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(footer.querySelector(".position")?.textContent?.trim()).toBe("1 / 2");
    expect(footer.querySelector(".position")?.getAttribute("aria-label")).toBe("Page 1 of 2");
    expect(footer.querySelector(".page-unit")?.textContent).toBe("Page");
    expect(root?.querySelector('input[type="number"]')).toBeNull();
    expect(options.open).toBe(false);
    expect(options.querySelector(".page-text")?.textContent).toContain("Page 1 text");
    expect(root?.querySelector("form")).toBeNull();
  });

  it("reflows width-fit pages on width changes without repeated renders from height-only observations", async () => {
    const { viewer } = await mountReady();
    const stage = viewer.shadowRoot?.querySelector<HTMLElement>(".stage");
    const observer = resizeObservers.find((candidate) => candidate.target === stage);
    if (!stage || !observer) {
      throw new Error("Inline document stage must be observed");
    }
    expect(runtime.renderPdfPage).toHaveBeenCalledTimes(1);
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 900 });
    observer.notify();
    await settleLitElement(viewer);
    expect(runtime.renderPdfPage).toHaveBeenCalledTimes(1);
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 600 });
    observer.notify();
    observer.notify();
    await ready(viewer);
    expect(runtime.renderPdfPage).toHaveBeenCalledTimes(2);
    expect(
      viewer.shadowRoot?.querySelector<HTMLCanvasElement>("canvas.current-page")?.style.width,
    ).toBe("568px");
    observer.notify();
    await settleLitElement(viewer);
    expect(runtime.renderPdfPage).toHaveBeenCalledTimes(2);
  });

  it("keeps slide position accessible while PageDown and PageUp navigate the inline preview", async () => {
    const { viewer } = await mountReady();
    viewer.pageUnit = "slide";
    await settleLitElement(viewer);
    const stage = viewer.shadowRoot?.querySelector<HTMLElement>(".stage");
    if (!stage) {
      throw new Error("Missing keyboard navigation region");
    }
    stage.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, composed: true }),
    );
    await ready(viewer, 2);
    expect(viewer.shadowRoot?.querySelector(".position")?.textContent?.trim()).toBe("2 / 2");
    expect(viewer.shadowRoot?.querySelector(".position")?.getAttribute("aria-label")).toBe(
      "Slide 2 of 2",
    );
    expect(button(viewer, "Next slide").disabled).toBe(true);
    stage.dispatchEvent(
      new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, composed: true }),
    );
    await ready(viewer, 1);
    expect(button(viewer, "Previous slide").disabled).toBe(true);
  });

  it.each(["ordinary preview", "inline request"])(
    "resumes custom zoom when explicitly expanding an %s into a measurable modal stage",
    async (mode) => {
      const { viewer, pdf, failed } = await mountReady();
      const restoreDialog = installDialogPolyfill();
      try {
        if (mode === "inline request") {
          viewer.requestChanges = async () => ({ admitted: false });
          await settleLitElement(viewer);
        }
        button(viewer, "Zoom in").click();
        await settleLitElement(viewer);
        await ready(viewer);
        if (mode === "inline request") {
          button(viewer, "Request changes").click();
          await settleLitElement(viewer);
          expect(viewer.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
          expect(viewer.shadowRoot?.querySelector("form")).toBeNull();
          expect(viewer.shadowRoot?.querySelector(".selection-hint")).not.toBeNull();
          expect(
            viewer.shadowRoot?.querySelector(".viewer")?.getAttribute("data-request-mode"),
          ).toBe("select");
        }
        const customWidth =
          viewer.shadowRoot?.querySelector<HTMLCanvasElement>("canvas.current-page")?.style.width;
        const renders = runtime.renderPdfPage.mock.calls.length;
        const pageReads = pdf.getPage.mock.calls.length;
        const pendingPage = deferred<TestPage>();
        pdf.getPage.mockReturnValueOnce(pendingPage.promise);
        button(viewer, "Expand document preview").click();
        await vi.waitFor(() => expect(pdf.getPage).toHaveBeenCalledTimes(pageReads + 1));
        const stage = viewer.shadowRoot?.querySelector<HTMLElement>(".stage");
        const page = pdf.pages[0];
        if (!stage || !page) {
          throw new Error("Missing asynchronous modal stage");
        }
        stage.style.padding = "16px";
        Object.defineProperties(stage, {
          clientWidth: { configurable: true, value: 0 },
          clientHeight: { configurable: true, value: 0 },
        });
        pendingPage.resolve(page);
        await settleLitElement(viewer);
        expect(viewer.getAttribute("data-render-state")).toBe("loading");
        expect(runtime.renderPdfPage).toHaveBeenCalledTimes(renders);
        const observer = resizeObservers.find((candidate) => candidate.target === stage);
        if (!observer) {
          throw new Error("Modal stage visibility was not observed");
        }
        observer.notify();
        await settleLitElement(viewer);
        expect(runtime.renderPdfPage).toHaveBeenCalledTimes(renders);
        Object.defineProperties(stage, {
          clientWidth: { configurable: true, value: 1_000 },
          clientHeight: { configurable: true, value: 700 },
        });
        observer.notify();
        observer.notify();
        await ready(viewer);
        expect(runtime.renderPdfPage).toHaveBeenCalledTimes(renders + 1);
        expect(
          viewer.shadowRoot?.querySelector<HTMLCanvasElement>("canvas.current-page")?.style.width,
        ).toBe(customWidth);
        observer.notify();
        await settleLitElement(viewer);
        expect(runtime.renderPdfPage).toHaveBeenCalledTimes(renders + 1);
        expect(failed).not.toHaveBeenCalled();
        button(viewer, "Collapse document preview").click();
        await settleLitElement(viewer);
        expect(viewer.shadowRoot?.querySelector("openclaw-modal-dialog")).toBeNull();
        expect(viewer.shadowRoot?.querySelector("form")).toBeNull();
        expect(viewer.shadowRoot?.querySelector(".viewer")?.getAttribute("data-request-mode")).toBe(
          "off",
        );
        expect(viewer.shadowRoot?.activeElement).toBe(
          viewer.shadowRoot?.querySelector(".preview-options > summary"),
        );
      } finally {
        viewer.remove();
        restoreDialog();
      }
    },
  );

  it("renders only the requested six-page contents window and releases it on close", async () => {
    const { viewer, pdf } = await mountReady(20);
    expect(runtime.renderPdfPage).toHaveBeenCalledTimes(1);
    expect(viewer.shadowRoot?.querySelector("openclaw-document-contents")).toBeNull();
    button(viewer, "Contents").click();
    await settleLitElement(viewer);
    const contents = viewer.shadowRoot?.querySelector("openclaw-document-contents");
    if (!contents) {
      throw new Error("Missing open contents");
    }
    await vi.waitFor(() =>
      expect(contents.shadowRoot?.querySelectorAll('[data-thumbnail-state="ready"]')).toHaveLength(
        6,
      ),
    );
    expect(contents.shadowRoot?.querySelectorAll("canvas")).toHaveLength(6);
    expect(pdf.getPage.mock.calls.map(([number]) => number)).toEqual([1, 1, 2, 3, 4, 5, 6]);
    const oldCanvases = [...(contents.shadowRoot?.querySelectorAll("canvas") ?? [])];
    contents.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Next pages"]')?.click();
    await vi.waitFor(() => {
      expect(contents.shadowRoot?.querySelectorAll('[data-thumbnail-state="ready"]')).toHaveLength(
        6,
      );
      expect(contents.shadowRoot?.querySelector('canvas[data-page="7"]')).not.toBeNull();
    });
    expect(oldCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
    const currentCanvases = [...(contents.shadowRoot?.querySelectorAll("canvas") ?? [])];
    expect(pdf.getPage.mock.calls.slice(7).map(([number]) => number)).toEqual([
      7, 8, 9, 10, 11, 12,
    ]);
    button(viewer, "Contents").click();
    await settleLitElement(viewer);
    expect(currentCanvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true);
  });

  it("cancels a pending thumbnail and stops its closed window from starting more pages", async () => {
    const { viewer, pdf } = await mountReady(12);
    const rendering = deferred<void>();
    const cancel = vi.fn();
    runtime.renderPdfPage.mockReturnValueOnce({ promise: rendering.promise, cancel });
    button(viewer, "Contents").click();
    await vi.waitFor(() => expect(runtime.renderPdfPage).toHaveBeenCalledTimes(2));
    button(viewer, "Contents").click();
    await settleLitElement(viewer);
    expect(cancel).toHaveBeenCalledTimes(1);
    rendering.resolve();
    await settleLitElement(viewer);
    expect(pdf.getPage).toHaveBeenCalledTimes(2);
    expect(viewer.getAttribute("data-render-state")).toBe("ready");
  });
});
