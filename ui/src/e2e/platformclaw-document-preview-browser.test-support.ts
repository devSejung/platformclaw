import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { DocumentPreviewFixture } from "./platformclaw-document-preview.test-fixtures.ts";

const FAILURE_SCREENSHOT_TIMEOUT_MS = 1_000;

export async function expectRenderedPage(
  viewer: Locator,
  current: number,
  total: number,
  expectAnnotation: boolean,
  pageUnit: "page" | "slide" = "page",
): Promise<void> {
  await expect
    .poll(() =>
      viewer.evaluate((element, annotationRequired) => {
        const canvas = element.shadowRoot?.querySelector("canvas.current-page");
        if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) {
          return null;
        }
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("document viewer has no rendered canvas context");
        }
        // Both independent fixtures contain teal: a PDF rectangle or a slide
        // background. An empty canvas and correct metadata cannot satisfy this.
        let teal = false;
        let magenta = false;
        for (let y = 1; y < 12; y++) {
          for (let x = 1; x < 12; x++) {
            const pixel = context.getImageData(
              Math.floor((canvas.width * x) / 12),
              Math.floor((canvas.height * y) / 12),
              1,
              1,
            ).data;
            const [red = 255, green = 0, blue = 0, alpha = 0] = pixel;
            if (alpha > 240 && red < 70 && green > 90 && blue > 80 && green - red > 70) {
              teal = true;
            }
            if (alpha > 240 && red > 230 && green < 30 && blue > 230) {
              magenta = true;
            }
          }
        }
        return {
          state: element.getAttribute("data-render-state"),
          current: Number(canvas.getAttribute("data-rendered-page")),
          total: Number(canvas.getAttribute("data-page-count")),
          teal,
          annotation: !annotationRequired || magenta,
        };
      }, expectAnnotation),
    )
    .toEqual({ state: "ready", current, total, teal: true, annotation: true });
  const position = viewer.locator(".position");
  expect(await position.textContent()).toBe(`${current} / ${total}`);
  expect(await position.getAttribute("aria-label")).toBe(
    `${pageUnit === "slide" ? "Slide" : "Page"} ${current} of ${total}`,
  );
  expect(await viewer.locator(".pagination").textContent()).toContain(
    pageUnit === "slide" ? "Slide" : "Page",
  );
}

async function canvasWidth(viewer: Locator): Promise<number> {
  return viewer
    .locator("canvas.current-page")
    .evaluate((canvas) => canvas.getBoundingClientRect().width);
}

export async function expectFittedPage(viewer: Locator, fit: "width" | "page"): Promise<void> {
  await expect
    .poll(() =>
      viewer.evaluate((element, requestedFit) => {
        const stage = element.shadowRoot?.querySelector(".stage");
        const canvas = element.shadowRoot?.querySelector("canvas.current-page");
        if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
          return false;
        }
        const style = getComputedStyle(stage);
        const availableWidth =
          stage.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight);
        const availableHeight =
          stage.clientHeight -
          Number.parseFloat(style.paddingTop) -
          Number.parseFloat(style.paddingBottom);
        const bounds = canvas.getBoundingClientRect();
        const fillsWidth = Math.abs(bounds.width - availableWidth) <= 2;
        const fillsHeight = Math.abs(bounds.height - availableHeight) <= 2;
        return (
          element.getAttribute("data-render-state") === "ready" &&
          (requestedFit === "width"
            ? fillsWidth
            : bounds.width <= availableWidth + 2 &&
              bounds.height <= availableHeight + 2 &&
              (fillsWidth || fillsHeight))
        );
      }, fit),
    )
    .toBe(true);
}

async function expectInlinePageGeometry(
  viewer: Locator,
  format: "pdf" | "powerpoint",
): Promise<void> {
  await expect
    .poll(() =>
      viewer.evaluate((element, presentation) => {
        const stage = element.shadowRoot?.querySelector(".stage");
        const canvas = element.shadowRoot?.querySelector("canvas.current-page");
        if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
          return false;
        }
        const style = getComputedStyle(stage);
        const padding =
          Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        const page = canvas.getBoundingClientRect();
        // Independent fixture dimensions: landscape 4:3 slides and portrait
        // 612x792 PDF pages must retain their proportions at every inline width.
        const aspect = presentation ? 4 / 3 : 612 / 792;
        return (
          element.getAttribute("data-render-state") === "ready" &&
          Math.abs(page.width / page.height - aspect) < 0.005 &&
          Math.abs(stage.clientHeight - page.height - padding) <= 2 &&
          stage.scrollHeight <= stage.clientHeight + 1
        );
      }, format === "powerpoint"),
    )
    .toBe(true);
}

async function exerciseWideDocumentLayout(params: {
  page: Page;
  viewer: Locator;
  fixture: DocumentPreviewFixture;
  proofDir: string;
}): Promise<void> {
  const { page, viewer, fixture, proofDir } = params;
  const originalViewport = page.viewportSize();
  if (!originalViewport || fixture.format === "image") {
    throw new Error("Wide document proof requires a document and fixed viewport");
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expectFittedPage(viewer, "width");
  await expectInlinePageGeometry(viewer, fixture.format);
  await expect
    .poll(() =>
      viewer.evaluate((element) => {
        const thread = element.closest<HTMLElement>(".chat-thread-inner");
        if (!thread) {
          throw new Error("Document preview lost its conversation column");
        }
        const maximum = 60 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        return (
          Math.abs(Number.parseFloat(getComputedStyle(thread).maxWidth) - maximum) <= 1 &&
          Math.abs(thread.getBoundingClientRect().width - maximum) <= 1
        );
      }),
    )
    .toBe(true);
  await viewer.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({
    path: path.join(proofDir, `platform_server-${fixture.format}-wide-1920.png`),
    fullPage: true,
  });

  if (fixture.format === "pdf") {
    await page.getByRole("button", { name: "Open split view", exact: true }).click();
    const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
    await expect.poll(() => panes.count()).toBe(2);
    const splitViewer = panes
      .first()
      .locator("openclaw-chat-document-attachment")
      .filter({ hasText: fixture.filename })
      .locator("openclaw-document-viewer");
    await expectFittedPage(splitViewer, "width");
    await expectInlinePageGeometry(splitViewer, "pdf");
    await expect
      .poll(() =>
        splitViewer.evaluate((element) => {
          const pane = element.closest("openclaw-chat-pane");
          const thread = element.closest(".chat-thread-inner");
          if (!pane || !thread) {
            throw new Error("Split preview lost its pane or conversation column");
          }
          const paneBounds = pane.getBoundingClientRect();
          const threadBounds = thread.getBoundingClientRect();
          const bounds = element.getBoundingClientRect();
          const maximum =
            60 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
          return (
            threadBounds.width < maximum - 1 &&
            bounds.left >= paneBounds.left - 1 &&
            bounds.right <= paneBounds.right + 1 &&
            pane.scrollWidth <= pane.clientWidth + 1
          );
        }),
      )
      .toBe(true);
    await splitViewer.evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.screenshot({
      path: path.join(proofDir, "platform_server-pdf-split-1920.png"),
      fullPage: true,
    });
    await panes.last().getByRole("button", { name: "Close pane", exact: true }).click();
    await expect.poll(() => page.locator("openclaw-chat-pane").count()).toBe(1);
  }
  await page.setViewportSize(originalViewport);
  await expectFittedPage(viewer, "width");
}

export async function clickDocumentPreviewOption(viewer: Locator, name: string): Promise<void> {
  const summary = viewer.locator('summary[aria-label="Preview options"]');
  const isOpen = () =>
    summary.evaluate(
      (element) =>
        element.parentElement instanceof HTMLDetailsElement && element.parentElement.open,
    );
  if (!(await isOpen())) {
    await summary.click();
  }
  await viewer.getByRole("button", { name, exact: true }).click();
  // Expand/collapse can replace the menu along with its canvas. Read the new
  // menu instead of keeping hidden advanced controls open in the next proof.
  if (await isOpen()) {
    await summary.click();
  }
}

async function expectPageText(
  viewer: Locator,
  text: string,
  pageUnit: "page" | "slide",
): Promise<void> {
  const options = viewer.locator('summary[aria-label="Preview options"]');
  await options.click();
  const disclosure = viewer.getByText(pageUnit === "slide" ? "Slide text" : "Page text", {
    exact: true,
  });
  await disclosure.click();
  const pageText = viewer.locator(".page-text");
  await pageText.waitFor({ state: "visible" });
  expect(await pageText.textContent()).toContain(text);
  await disclosure.click();
  await options.click();
}

async function exerciseDocumentContents(params: {
  page: Page;
  viewer: Locator;
  target: string;
  fixture: DocumentPreviewFixture;
  total: number;
  proofDir: string;
  pageUnit: "page" | "slide";
}): Promise<void> {
  const { page, viewer, target, fixture, total, proofDir, pageUnit } = params;
  const contentsButton = viewer.getByRole("button", { name: "Contents", exact: true });
  expect(await contentsButton.getAttribute("aria-expanded")).toBe("false");
  expect(await viewer.locator("openclaw-document-contents").count()).toBe(0);
  await contentsButton.click();
  const contents = viewer.locator("openclaw-document-contents");
  await contents.getByRole("navigation", { name: "Contents", exact: true }).waitFor();
  const firstLabel = `${pageUnit === "slide" ? "Slide" : "Page"} 1`;
  expect(
    await contents
      .getByRole("button", { name: firstLabel, exact: true })
      .getAttribute("aria-current"),
  ).toBe("page");
  await expect
    .poll(() =>
      contents.locator("canvas").evaluateAll(
        (elements) =>
          elements.length > 0 &&
          elements.every((element) => {
            if (
              !(element instanceof HTMLCanvasElement) ||
              element.dataset.thumbnailState !== "ready" ||
              !element.width ||
              !element.height
            ) {
              return false;
            }
            const context = element.getContext("2d");
            if (!context) {
              return false;
            }
            for (let y = 1; y < 12; y++) {
              for (let x = 1; x < 12; x++) {
                const [red = 255, green = 0, blue = 0, alpha = 0] = context.getImageData(
                  Math.floor((element.width * x) / 12),
                  Math.floor((element.height * y) / 12),
                  1,
                  1,
                ).data;
                if (alpha > 240 && red < 70 && green > 90 && blue > 80 && green - red > 70) {
                  return true;
                }
              }
            }
            return false;
          }),
      ),
    )
    .toBe(true);
  expect(await contents.locator("canvas").count()).toBe(total);
  await expectFittedPage(viewer, "width");
  await expectInlinePageGeometry(viewer, fixture.format === "powerpoint" ? "powerpoint" : "pdf");
  expect(await viewer.getByRole("spinbutton").count()).toBe(0);
  if (total > 1) {
    const last = contents.getByRole("button", {
      name: `${pageUnit === "slide" ? "Slide" : "Page"} ${total}`,
      exact: true,
    });
    await last.click();
    await expectRenderedPage(viewer, total, total, fixture.format === "pdf", pageUnit);
    expect(await last.getAttribute("aria-current")).toBe("page");
  }
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-contents.png`),
    fullPage: true,
  });
  if (total > 1) {
    await contents.getByRole("button", { name: firstLabel, exact: true }).click();
    await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
    await viewer.locator(".stage").press("PageDown");
    await expectRenderedPage(viewer, 2, total, fixture.format === "pdf", pageUnit);
    await viewer.locator(".stage").press("PageUp");
    await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
  }
  await contentsButton.click();
  await contents.waitFor({ state: "detached" });
}

export type ObservedMediaResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
};

export async function exerciseDocumentPreview(params: {
  page: Page;
  fixture: DocumentPreviewFixture;
  target: string;
  phase: "initial" | "reloaded" | "recovered";
  proofDir: string;
  mediaResponses: readonly ObservedMediaResponse[];
  cspViolations: readonly string[];
}): Promise<void> {
  const { page, fixture, target, phase, proofDir, mediaResponses } = params;
  if (fixture.format === "image") {
    const image = page.locator(".chat-message-image");
    await expect
      .poll(() =>
        image.evaluate((element) =>
          element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
        ),
      )
      .toBe(320);
    await image.click();
    const lightbox = page.locator("openclaw-image-lightbox");
    await lightbox.locator(".image").waitFor();
    await expect
      .poll(() =>
        lightbox
          .locator(".image")
          .evaluate((element) =>
            element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
          ),
      )
      .toBe(320);
    await page.screenshot({
      path: path.join(proofDir, `${target}-image-${phase}.png`),
      fullPage: true,
    });
    await lightbox.getByRole("button", { name: "Close image preview" }).click();
    return;
  }
  const card = page
    .locator("openclaw-chat-document-attachment")
    .filter({ hasText: fixture.filename });
  const href = await card
    .getByRole("link", { name: "Download file", exact: true })
    .getAttribute("href");
  if (!href) {
    throw new Error("owned document has no original download URL");
  }
  const expectedUrl = new URL(href, page.url());
  if (fixture.format === "powerpoint") {
    expectedUrl.searchParams.set("preview", "1");
  }
  await card.scrollIntoViewIfNeeded();
  if (phase === "recovered") {
    await card.getByRole("button", { name: "Preview", exact: true }).click();
  }
  // Initial and reload proof must exercise visibility-triggered opening. The
  // response may precede this helper, so use the already-recorded real BFF bytes.
  await card.getByRole("button", { name: "Close preview", exact: true }).waitFor();
  await expect
    .poll(() => mediaResponses.findLast((candidate) => candidate.url === expectedUrl.href)?.status)
    .toBe(200);
  const observed = mediaResponses.findLast((candidate) => candidate.url === expectedUrl.href);
  if (!observed) {
    throw new Error("preview did not traverse the real owned BFF relay");
  }
  expect(observed.status).toBe(200);
  expect(observed.headers["content-type"]).toMatch(/^application\/pdf(?:;|$)/u);
  expect(new URL(observed.url).searchParams.get("preview")).toBe(
    fixture.format === "powerpoint" ? "1" : null,
  );
  const pdfBytes = observed.bytes;
  expect(pdfBytes.subarray(0, 5).toString()).toBe("%PDF-");
  if (fixture.format === "pdf") {
    expect(pdfBytes).toEqual(fixture.bytes);
  } else {
    expect(pdfBytes).not.toEqual(fixture.bytes);
  }
  const viewer = card.locator("openclaw-document-viewer");
  const total = fixture.format === "powerpoint" ? 2 : 1;
  const expectAnnotation = fixture.format === "pdf";
  const pageUnit = fixture.format === "powerpoint" ? "slide" : "page";
  try {
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    expect(await viewer.locator("canvas.current-page").getAttribute("aria-label")).toContain(
      fixture.filename,
    );
    await expectFittedPage(viewer, "width");
    await expectInlinePageGeometry(viewer, fixture.format);
    expect(await viewer.getByRole("button", { name: "Zoom in", exact: true }).isVisible()).toBe(
      false,
    );
    expect(await viewer.getByRole("button", { name: "Fit page", exact: true }).isVisible()).toBe(
      false,
    );
    const footer = await viewer.locator(".toolbar").evaluate((element) => {
      const layout = element.previousElementSibling;
      if (!(layout instanceof HTMLElement) || !layout.classList.contains("page-layout")) {
        throw new Error("document controls are not below the preview");
      }
      return {
        top: element.getBoundingClientRect().top,
        pageBottom: layout.getBoundingClientRect().bottom,
      };
    });
    expect(footer.top).toBeGreaterThanOrEqual(footer.pageBottom - 1);
    await expectPageText(
      viewer,
      fixture.format === "powerpoint" ? "Owned presentation slide 1" : "Owned document preview",
      pageUnit,
    );
    expect(
      await viewer.getByRole("button", { name: `Previous ${pageUnit}`, exact: true }).isDisabled(),
    ).toBe(true);
    const next = viewer.getByRole("button", { name: `Next ${pageUnit}`, exact: true });
    expect(await next.isDisabled()).toBe(total === 1);
    if (total > 1) {
      await next.click();
      await expectRenderedPage(viewer, 2, total, expectAnnotation, pageUnit);
      await expectPageText(viewer, "Owned presentation slide 2", pageUnit);
      expect(await next.isDisabled()).toBe(true);
      await page.screenshot({
        path: path.join(proofDir, `${target}-${fixture.format}-${phase}-page-2.png`),
        fullPage: true,
      });
      await viewer.getByRole("button", { name: `Previous ${pageUnit}`, exact: true }).click();
      await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    }
    if (phase === "initial") {
      await exerciseDocumentContents({ page, viewer, target, fixture, total, proofDir, pageUnit });
      await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    }
    expect(params.cspViolations).toEqual([]);
  } catch (error) {
    try {
      await page.screenshot({
        path: path.join(proofDir, `${target}-${fixture.format}-${phase}-viewer-unavailable.png`),
        fullPage: true,
        timeout: FAILURE_SCREENSHOT_TIMEOUT_MS,
      });
    } catch {
      console.log(
        "document-preview-failure-screenshot",
        JSON.stringify({ target, format: fixture.format, phase, outcome: "unavailable" }),
      );
    }
    throw error;
  }
  await card.scrollIntoViewIfNeeded();
  const layout = await viewer.evaluate((element) => {
    const column = element.closest(".chat-group-messages");
    const attachmentCard = element.closest(".chat-assistant-attachment-card");
    if (!(column instanceof HTMLElement) || !(attachmentCard instanceof HTMLElement)) {
      throw new Error("document preview lost its message column");
    }
    const style = getComputedStyle(attachmentCard);
    const inset = [
      "padding-left",
      "padding-right",
      "border-left-width",
      "border-right-width",
    ].reduce((sum, property) => sum + Number.parseFloat(style.getPropertyValue(property)), 0);
    return { width: element.getBoundingClientRect().width, available: column.clientWidth - inset };
  });
  expect(Math.abs(layout.width - layout.available)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-${phase}.png`),
    fullPage: true,
  });
  if (phase === "initial") {
    const desktopViewport = page.viewportSize();
    if (!desktopViewport) {
      throw new Error("document browser proof requires a fixed viewport");
    }
    const fittedWidth = await canvasWidth(viewer);
    await clickDocumentPreviewOption(viewer, "Zoom in");
    await expect.poll(() => canvasWidth(viewer)).toBeGreaterThan(fittedWidth);
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    const zoomedWidth = await canvasWidth(viewer);
    await clickDocumentPreviewOption(viewer, "Zoom out");
    await expect.poll(() => canvasWidth(viewer)).toBeLessThan(zoomedWidth);
    await clickDocumentPreviewOption(viewer, "Fit width");
    await expectFittedPage(viewer, "width");
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    const widthFit = await canvasWidth(viewer);
    await clickDocumentPreviewOption(viewer, "Fit page");
    await expectFittedPage(viewer, "page");
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    expect(await canvasWidth(viewer)).toBeLessThanOrEqual(widthFit + 1);

    await clickDocumentPreviewOption(viewer, "Expand document preview");
    const modal = viewer.locator("openclaw-modal-dialog");
    await modal.waitFor({ state: "attached" });
    await viewer.getByRole("dialog").waitFor({ state: "visible" });
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    const expanded = await viewer
      .locator(".stage")
      .evaluate((stage) => stage.getBoundingClientRect().width);
    expect(expanded).toBeGreaterThan(layout.width);
    expect(expanded).toBeGreaterThan(desktopViewport.width * 0.8);
    await page.screenshot({
      path: path.join(proofDir, `${target}-${fixture.format}-expanded.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "detached" });
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    await expect
      .poll(() =>
        viewer.locator('summary[aria-label="Preview options"]').evaluate((button) => {
          const root = button.getRootNode();
          return root instanceof ShadowRoot && root.activeElement === button;
        }),
      )
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    await clickDocumentPreviewOption(viewer, "Fit width");
    await expectFittedPage(viewer, "width");
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    const bounds = await viewer.boundingBox();
    await expectInlinePageGeometry(viewer, fixture.format);
    if (!bounds) {
      throw new Error("document preview disappeared at mobile width");
    }
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      391,
    );
    await page.screenshot({
      path: path.join(proofDir, `${target}-${fixture.format}-mobile.png`),
      fullPage: true,
    });
    await page.setViewportSize(desktopViewport);
    if (target === "platform_server") {
      await exerciseWideDocumentLayout({ page, viewer, fixture, proofDir });
    }
  }
  await card.getByRole("button", { name: "Close preview", exact: true }).click();
  // Click completion does not wait for the component's closed-state render.
  await card.getByRole("button", { name: "Preview", exact: true }).waitFor();
  expect(await card.locator("openclaw-document-viewer").count()).toBe(0);
  if (phase === "initial") {
    await card.getByRole("button", { name: "Preview", exact: true }).click();
    await expectRenderedPage(viewer, 1, total, expectAnnotation, pageUnit);
    await card.getByRole("button", { name: "Close preview", exact: true }).click();
    await card.getByRole("button", { name: "Preview", exact: true }).waitFor();
    expect(await card.locator("openclaw-document-viewer").count()).toBe(0);
  }
  expect(params.cspViolations).toEqual([]);
}
