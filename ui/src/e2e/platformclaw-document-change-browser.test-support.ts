import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import {
  clickDocumentPreviewOption,
  expectFittedPage,
  expectRenderedPage,
} from "./platformclaw-document-preview-browser.test-support.ts";
import type { DocumentPreviewFixture } from "./platformclaw-document-preview.test-fixtures.ts";

async function scrollDocumentToTop(viewer: Locator): Promise<void> {
  const stage = viewer.locator(".stage");
  await stage.scrollIntoViewIfNeeded();
  await stage.evaluate((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  });
}

async function dragDocumentRegion(page: Page, viewer: Locator): Promise<void> {
  await scrollDocumentToTop(viewer);
  const bounds = await viewer.locator("canvas.current-page").boundingBox();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error("selection requires a visible rendered document");
  }
  await page.mouse.move(bounds.x + bounds.width * 0.15, bounds.y + bounds.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.55, {
    steps: 5,
  });
  await page.mouse.up();
}

async function clickDocumentTitle(
  page: Page,
  viewer: Locator,
  presentation: boolean,
): Promise<void> {
  await scrollDocumentToTop(viewer);
  const point = await viewer.locator("canvas.current-page").evaluate((element, whiteInk) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error("document title has no canvas");
    }
    const context = element.getContext("2d");
    if (!context) {
      throw new Error("document title has no pixels");
    }
    const pixels = context.getImageData(0, 0, element.width, Math.ceil(element.height * 0.3));
    // Independent fixture paint: PDF title ink is teal; PPT title ink is white
    // on teal. Hit the actual rendered glyph, not private computed text boxes.
    for (let y = Math.floor(element.height * 0.03); y < pixels.height; y++) {
      for (let x = Math.floor(element.width * 0.04); x < element.width * 0.9; x++) {
        const offset = (y * element.width + x) * 4;
        const red = pixels.data[offset] ?? 0;
        const green = pixels.data[offset + 1] ?? 0;
        const blue = pixels.data[offset + 2] ?? 0;
        const alpha = pixels.data[offset + 3] ?? 0;
        const ink = whiteInk
          ? red > 240 && green > 240 && blue > 240
          : red < 70 && green > 90 && blue > 80 && green - red > 70;
        if (alpha > 240 && ink) {
          const bounds = element.getBoundingClientRect();
          return {
            x: bounds.x + ((x + 0.5) * bounds.width) / element.width,
            y: bounds.y + ((y + 0.5) * bounds.height) / element.height,
          };
        }
      }
    }
    throw new Error("rendered title ink was not found");
  }, presentation);
  await page.mouse.click(point.x, point.y);
}

async function expectPopoverInsideStage(viewer: Locator): Promise<void> {
  await expect
    .poll(() =>
      viewer.locator(".request-popover").evaluate((element) => {
        const stage = element.closest(".stage");
        if (!(stage instanceof HTMLElement)) {
          throw new Error("request popover lost its inline stage");
        }
        const popup = element.getBoundingClientRect();
        const bounds = stage.getBoundingClientRect();
        return (
          getComputedStyle(element).visibility !== "hidden" &&
          popup.width > 0 &&
          popup.height > 0 &&
          popup.left >= bounds.left - 1 &&
          popup.right <= bounds.right + 1 &&
          popup.top >= bounds.top - 1 &&
          popup.bottom <= bounds.bottom + 1
        );
      }),
    )
    .toBe(true);
}

/** Run only after the snapshot/download/foreign-owner proof has made no chat requests. */
export async function exerciseDocumentChangeRequest(params: {
  page: Page;
  fixture: DocumentPreviewFixture;
  target: string;
  proofDir: string;
  sessionKey: string;
  gateway: Pick<MockGatewayControls, "getRequests" | "waitForRequest">;
  source: { messageId: string; artifactId: string };
}): Promise<void> {
  const { page, fixture, target, proofDir, sessionKey, gateway, source } = params;
  const originalViewport = page.viewportSize();
  if (!originalViewport) {
    throw new Error("document request proof requires a fixed viewport");
  }
  // A legitimate tall viewport retains the inline preview and surrounding chat.
  const desktopViewport = {
    width: originalViewport.width,
    height: Math.max(originalViewport.height, 1200),
  };
  await page.setViewportSize(desktopViewport);
  const card = page
    .locator("openclaw-chat-document-attachment")
    .filter({ hasText: fixture.filename });
  const viewer = card.locator("openclaw-document-viewer");
  const pageUnit = fixture.format === "powerpoint" ? "slide" : "page";
  const total = fixture.format === "powerpoint" ? 2 : 1;
  const toggle = viewer.getByRole("button", { name: "Request changes", exact: true });
  const popover = viewer.locator(".request-popover");
  const instructionInput = viewer.getByRole("textbox", {
    name: "Describe the change",
    exact: true,
  });
  const expectInline = async () => {
    expect(await viewer.locator("openclaw-modal-dialog").count()).toBe(0);
    expect(await viewer.locator('summary[aria-label="Preview options"]').isVisible()).toBe(true);
    expect(
      await viewer
        .locator("details.preview-options")
        .evaluate((element) => element instanceof HTMLDetailsElement && !element.open),
    ).toBe(true);
  };
  const open = async () => {
    await card.getByRole("button", { name: "Preview", exact: true }).click();
    await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
    await expectFittedPage(viewer, "width");
    await expectInline();
  };
  const expectModeOff = async () => {
    expect(await viewer.locator(".viewer").getAttribute("data-request-mode")).toBe("off");
    expect(await popover.count()).toBe(0);
    expect(await viewer.locator(".selection-region").count()).toBe(0);
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  };
  const begin = async () => {
    await toggle.click();
    await expect
      .poll(() => viewer.locator(".viewer").getAttribute("data-request-mode"))
      .toBe("select");
    await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
    await expectFittedPage(viewer, "width");
    await expectInline();
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    expect(await popover.count()).toBe(0);
  };
  const selectRegion = async () => {
    await begin();
    await dragDocumentRegion(page, viewer);
    await viewer.locator(".selection-region").waitFor({ state: "visible" });
    await popover.waitFor({ state: "visible" });
    await expectPopoverInsideStage(viewer);
    expect(await viewer.locator(".selected-text").count()).toBe(0);
    expect(await instructionInput.inputValue()).toBe("");
  };
  await open();
  await clickDocumentTitle(page, viewer, fixture.format === "powerpoint");
  await dragDocumentRegion(page, viewer);
  await expectModeOff();

  await begin();
  await clickDocumentTitle(page, viewer, fixture.format === "powerpoint");
  await popover.waitFor({ state: "visible" });
  const selectedText = viewer.locator(".selected-text");
  await selectedText.waitFor({ state: "visible" });
  expect(await selectedText.textContent()).toContain("Owned");
  await expectPopoverInsideStage(viewer);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  await instructionInput.fill("제목을 ‘2026 실행 계획’으로 바꿔줘");
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-request-text-selection.png`),
    fullPage: true,
  });
  await instructionInput.fill("Discard this clicked title draft");
  await toggle.click();
  await popover.waitFor({ state: "detached" });
  await expectModeOff();
  await expectInline();

  await selectRegion();
  await instructionInput.fill("Discard this cancelled draft");
  await viewer.getByRole("button", { name: "Cancel request", exact: true }).click();
  await popover.waitFor({ state: "detached" });
  expect(await viewer.locator(".viewer").getAttribute("data-request-mode")).toBe("select");
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  await toggle.click();
  await expectModeOff();

  await selectRegion();
  await instructionInput.fill("Discard this closed preview draft");
  await clickDocumentPreviewOption(viewer, "Expand document preview");
  await viewer.getByRole("dialog").waitFor({ state: "visible" });
  await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
  await expectFittedPage(viewer, "width");
  await expectPopoverInsideStage(viewer);
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-request-expanded.png`),
    fullPage: true,
  });
  await clickDocumentPreviewOption(viewer, "Collapse document preview");
  await viewer.locator("openclaw-modal-dialog").waitFor({ state: "detached" });
  await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
  await expectModeOff();
  await expectInline();
  await card.getByRole("button", { name: "Close preview", exact: true }).click();
  await viewer.waitFor({ state: "detached" });
  await open();
  await expectModeOff();

  const instruction = "Change the selected teal region to blue and keep the surrounding text.";
  await selectRegion();
  await instructionInput.fill(instruction);
  await expectInline();
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-request-selection.png`),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
  await expectFittedPage(viewer, "width");
  await expectInline();
  await expectPopoverInsideStage(viewer);
  await viewer.locator(".stage").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-request-mobile-document.png`),
    fullPage: true,
  });
  await popover.scrollIntoViewIfNeeded();
  const mobileBox = await viewer.boundingBox();
  if (!mobileBox) {
    throw new Error("mobile inline preview disappeared");
  }
  expect(mobileBox.x).toBeGreaterThanOrEqual(0);
  expect(mobileBox.x + mobileBox.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-request-mobile-form.png`),
    fullPage: true,
  });
  await page.setViewportSize(desktopViewport);
  await expectRenderedPage(viewer, 1, total, fixture.format === "pdf", pageUnit);
  await expectFittedPage(viewer, "width");
  await expectInline();
  await expectPopoverInsideStage(viewer);
  const canvasSize = await viewer.locator("canvas.current-page").evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) {
      throw new Error("document selection lost its rendered canvas");
    }
    return { width: element.width, height: element.height };
  });
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  await viewer.getByRole("button", { name: "Send request", exact: true }).click();
  const request = await gateway.waitForRequest("chat.send");
  const sent = request.params;
  if (!isRecord(sent) || typeof sent.message !== "string") {
    throw new Error("document request did not use the canonical chat payload");
  }
  expect(sent).toMatchObject({ sessionKey, replyToId: source.messageId, deliver: false });
  const pageLabel = `${pageUnit === "slide" ? "Slide" : "Page"} 1`;
  expect(sent.message).toContain(`Requested changes to ${fixture.filename} — ${pageLabel}`);
  expect(sent.message).toContain(instruction);
  expect(sent.message).not.toContain("Selected text:");
  expect(sent.message).toContain("The attached image shows the selected region.");
  expect(sent.message).toContain(
    "The original document is referenced in the reply, not reattached.",
  );
  expect(sent.message).not.toMatch(
    /Source:|sourceReference|previewRevision|messageId|artifactId|mediaTicket|https?:\/\/|data:image\/|\/api\/chat\/media\//u,
  );
  expect(sent.message).not.toContain(source.messageId);
  expect(sent.message).not.toContain(source.artifactId);
  const region =
    /^Selected region: left ([\d.]+)%, top ([\d.]+)%, width ([\d.]+)%, height ([\d.]+)%\.$/mu.exec(
      sent.message,
    );
  if (!region) {
    throw new Error("document request has no human-readable region context");
  }
  expect(Number(region[1])).toBeCloseTo(15, 0);
  expect(Number(region[2])).toBeCloseTo(15, 0);
  expect(Number(region[3])).toBeCloseTo(50, 0);
  expect(Number(region[4])).toBeCloseTo(40, 0);
  expect(sent.attachments).toHaveLength(1);
  if (!Array.isArray(sent.attachments) || !isRecord(sent.attachments[0])) {
    throw new Error("document request has no crop attachment");
  }
  const attachment = sent.attachments[0];
  const cropContent = attachment.content;
  if (typeof cropContent !== "string") {
    throw new Error("document request crop has no encoded image bytes");
  }
  expect(attachment).toMatchObject({
    type: "image",
    mimeType: "image/png",
    fileName: `document-selection-${pageUnit}-1.png`,
  });
  const cropBytes = Buffer.from(cropContent, "base64");
  expect(cropBytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(cropBytes.length).toBeLessThanOrEqual(1024 * 1024);
  await writeFile(path.join(proofDir, `${target}-${fixture.format}-request-crop.png`), cropBytes);
  // Decode the actual outbound image in Chromium: metadata or a canned blank PNG
  // cannot prove that the selected production canvas supplied the attachment.
  const crop = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("crop image has no pixel context");
      }
      context.drawImage(image, 0, 0);
      let teal = false;
      for (let y = 1; y < 12; y++) {
        for (let x = 1; x < 12; x++) {
          const [red = 255, green = 0, blue = 0, alpha = 0] = context.getImageData(
            Math.floor((canvas.width * x) / 12),
            Math.floor((canvas.height * y) / 12),
            1,
            1,
          ).data;
          teal ||= alpha > 240 && red < 70 && green > 90 && blue > 80 && green - red > 70;
        }
      }
      return { width: image.width, height: image.height, teal };
    } finally {
      image.close();
    }
  }, cropContent);
  expect(crop.teal).toBe(true);
  expect(crop.width).toBeGreaterThan(0);
  expect(crop.height).toBeGreaterThan(0);
  expect(crop.width).toBeLessThan(canvasSize.width);
  expect(crop.height).toBeLessThan(canvasSize.height);
  expect(crop.width / crop.height).toBeCloseTo(
    (canvasSize.width * 0.5) / (canvasSize.height * 0.4),
    1,
  );
  await viewer.getByText("Request sent", { exact: true }).waitFor();
  expect(await viewer.locator(".viewer").getAttribute("data-request-mode")).toBe("off");
  expect(await viewer.locator(".request-popover").count()).toBe(0);
  expect(await viewer.locator(".selection-region").count()).toBe(0);
  await expectInline();
  await page.screenshot({
    path: path.join(proofDir, `${target}-${fixture.format}-request-sent.png`),
    fullPage: true,
  });
  expect(await gateway.getRequests("chat.send")).toHaveLength(1);
  console.log(
    "document-change-request-proof",
    JSON.stringify({
      target,
      format: fixture.format,
      pageUnit,
      pageNumber: 1,
      ownedSession: true,
      sourceReplyBound: true,
      explicitOptIn: true,
      pointClickText: true,
      inlineRequest: true,
      retiredDraftsSent: false,
      sends: 1,
      cropBytes: cropBytes.length,
      cropWidth: crop.width,
      cropHeight: crop.height,
    }),
  );
  await page.setViewportSize(originalViewport);
}
