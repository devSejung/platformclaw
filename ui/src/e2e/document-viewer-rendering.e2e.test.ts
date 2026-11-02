import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolvePlaywrightChromiumExecutablePath,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  installPlatformClawMockGateway,
  observePlatformClawPreviewCsp,
  startPlatformClawControlUiE2eServer,
} from "../test-helpers/platformclaw-control-ui-e2e.ts";
import { createScanPreviewPdf } from "./platformclaw-document-preview.test-fixtures.ts";

const proofDir = path.resolve(
  ".artifacts/control-ui-e2e/platformclaw-canvas/document-previews/rendering-boundaries",
);

describe("document viewer real PDF rendering failures", () => {
  let browser: Browser;
  let server: ControlUiE2eServer;

  beforeAll(async () => {
    await mkdir(proofDir, { recursive: true });
    server = await startPlatformClawControlUiE2eServer("document-rendering-boundaries");
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("renders an admissible scan and visibly rejects a compressed oversized scan", async () => {
    const sessionKey = "agent:document-rendering:main";
    const fixtures = [
      { filename: "readable-scan.pdf", bytes: createScanPreviewPdf(250, 350) },
      { filename: "oversized-scan.pdf", bytes: createScanPreviewPdf(5_000, 7_000) },
    ].map((fixture, index) => ({
      filename: fixture.filename,
      bytes: fixture.bytes,
      artifactId: `artifact_managed_media_11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
      source: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/scan-${index + 1}/full`,
    }));
    const readable = fixtures[0]!;
    const oversized = fixtures[1]!;
    expect(oversized.bytes.length).toBeLessThan(16 * 1024 * 1024);
    const context = await browser.newContext({
      acceptDownloads: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } }
        : {}),
    });
    try {
      // Only identity/history and attachment transport are synthetic. This test
      // exercises the real production CSP, worker and card/renderer failure path;
      // Basic/VM snapshot ownership is covered by the separate runtime scenario.
      await context.route("**/api/chat/media/outgoing/**", async (route) => {
        const url = new URL(route.request().url());
        const fixture = fixtures.find((candidate) => candidate.source === url.pathname);
        if (!fixture) {
          throw new Error("unexpected scan fixture request");
        }
        expect(url.searchParams.get("preview")).toBeNull();
        await route.fulfill({
          status: 200,
          body: fixture.bytes,
          contentType: "application/pdf",
          headers: { "Content-Disposition": `attachment; filename="${fixture.filename}"` },
        });
      });
      const page = await context.newPage();
      const mediaResponses = new Map<string, { status: number; body: Promise<Buffer> }>();
      page.on("response", (response) => {
        const pathname = new URL(response.url()).pathname;
        if (
          !response.request().isNavigationRequest() &&
          fixtures.some((fixture) => fixture.source === pathname)
        ) {
          mediaResponses.set(pathname, { status: response.status(), body: response.body() });
        }
      });
      const cspViolations = await observePlatformClawPreviewCsp(page);
      const gateway = await installPlatformClawMockGateway(page, {
        assistantAgentId: "document-rendering",
        defaultAgentId: "document-rendering",
        sessionKey,
        historyMessages: [
          {
            role: "assistant",
            content: fixtures.map((fixture) => ({
              type: "attachment",
              attachment: {
                kind: "document",
                label: fixture.filename,
                mimeType: "application/pdf",
                sizeBytes: fixture.bytes.length,
                artifactId: fixture.artifactId,
                url: fixture.source,
              },
            })),
            timestamp: 1,
          },
        ],
        methodResponses: {
          "artifacts.download": {
            cases: fixtures.map((fixture) => ({
              match: { sessionKey, artifactId: fixture.artifactId },
              response: {
                artifact: {
                  id: fixture.artifactId,
                  title: fixture.filename,
                  type: "file",
                  mimeType: "application/pdf",
                  download: { mode: "url" },
                },
                url: `${fixture.source}?mediaTicket=rendering-fixture`,
                expiresAt: new Date(Date.now() + 120_000).toISOString(),
              },
            })),
          },
        },
      });
      const documentResponse = await page.goto(`${server.baseUrl}chat`);
      expect(documentResponse?.headers()["content-security-policy"]).toContain(
        "default-src 'self'",
      );
      await gateway.waitForRequest("chat.startup");

      // A successful scan with the same image encoding rules out a broken worker,
      // font/asset setup or universal image rejection masquerading as the fix.
      const readableCard = page
        .locator("openclaw-chat-document-attachment")
        .filter({ hasText: readable.filename });
      await readableCard.scrollIntoViewIfNeeded();
      await readableCard.getByRole("button", { name: "Close preview", exact: true }).waitFor();
      const readableViewer = readableCard.locator("openclaw-document-viewer");
      await expect.poll(() => readableViewer.getAttribute("data-render-state")).toBe("ready");
      const scanPainted = await readableViewer
        .locator("canvas.current-page")
        .evaluate((element) => {
          if (!(element instanceof HTMLCanvasElement)) {
            throw new Error("readable scan has no canvas");
          }
          const pixel = element
            .getContext("2d")
            ?.getImageData(
              Math.floor(element.width / 2),
              Math.floor(element.height / 2),
              1,
              1,
            ).data;
          if (!pixel) {
            throw new Error("readable scan has no pixel context");
          }
          const [red = 0, green = 0, blue = 0, alpha = 0] = pixel;
          return (
            alpha === 255 &&
            red > 100 &&
            red < 170 &&
            Math.abs(red - green) < 3 &&
            Math.abs(red - blue) < 3
          );
        });
      expect(scanPainted).toBe(true);
      await readableCard.getByRole("button", { name: "Close preview", exact: true }).click();

      const oversizedCard = page
        .locator("openclaw-chat-document-attachment")
        .filter({ hasText: oversized.filename });
      await oversizedCard.scrollIntoViewIfNeeded();
      await oversizedCard.getByRole("button", { name: "Close preview", exact: true }).waitFor();
      await expect.poll(() => mediaResponses.has(oversized.source)).toBe(true);
      const response = mediaResponses.get(oversized.source);
      if (!response) {
        throw new Error("oversized scan did not load automatically");
      }
      expect(response.status).toBe(200);
      expect(await response.body).toEqual(oversized.bytes);
      const oversizedViewer = oversizedCard.locator("openclaw-document-viewer");
      await expect.poll(() => oversizedViewer.getAttribute("data-render-state")).toBe("error");
      const alert = oversizedCard.getByRole("alert");
      await alert.waitFor({ state: "visible" });
      expect(await alert.textContent()).toContain("download the original file");
      expect(await oversizedViewer.locator("canvas.current-page").isVisible()).toBe(false);
      expect(cspViolations).toEqual([]);
      await page.screenshot({
        path: path.join(proofDir, "oversized-scan-visible-error.png"),
        fullPage: true,
      });

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        oversizedCard.getByRole("link", { name: "Download file", exact: true }).click(),
      ]);
      expect(download.suggestedFilename()).toBe(oversized.filename);
      const saved = await download.path();
      if (!saved) {
        throw new Error("oversized scan original download did not complete");
      }
      expect(await readFile(saved)).toEqual(oversized.bytes);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await oversizedCard.getByRole("button", { name: "Close preview", exact: true }).click();
      await oversizedCard.getByRole("button", { name: "Preview", exact: true }).waitFor();
      expect(await oversizedCard.locator("openclaw-document-viewer").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("rejects public operator-stream failures and recovers an ordinary cancelled render", async () => {
    const displayPath = createRequire(import.meta.url).resolve("pdfjs-dist");
    const [displaySource, workerSource] = await Promise.all([
      readFile(displayPath),
      readFile(path.join(path.dirname(displayPath), "pdf.worker.mjs")),
    ]);
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
    });
    try {
      // These same-origin test assets are the installed package bytes, including
      // its approved patch. No fake worker, RPC observer or renderer mock is used.
      await context.route("**/__pdfjs_public_api/**", async (route) => {
        const filename = path.posix.basename(new URL(route.request().url()).pathname);
        if (filename !== "pdf.mjs" && filename !== "pdf.worker.mjs") {
          throw new Error("unexpected PDF public API test asset");
        }
        await route.fulfill({
          contentType: "text/javascript",
          body: filename === "pdf.mjs" ? displaySource : workerSource,
        });
      });
      const page = await context.newPage();
      const cspViolations = await observePlatformClawPreviewCsp(page);
      await installPlatformClawMockGateway(page);
      const response = await page.goto(`${server.baseUrl}chat`);
      expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
      const origin = new URL(page.url()).origin;
      await page.addScriptTag({
        type: "module",
        url: `${origin}/__pdfjs_public_api/pdf.mjs`,
      });
      const result = await page.evaluate(
        async ({ workerUrl, readable, oversized }) => {
          // The shipped module deliberately publishes this public namespace.
          // Loading its external module URL avoids Vitest rewriting a dynamic
          // import inside the serialized browser function into an SSR helper.
          const browserGlobal: typeof globalThis & {
            pdfjsLib?: Pick<typeof import("pdfjs-dist"), "PDFWorker" | "getDocument" | "version">;
          } = globalThis;
          const engine = browserGlobal.pdfjsLib;
          if (!engine) {
            throw new Error("PDF.js public module did not initialize");
          }
          type Outcome =
            | { state: "resolved" }
            | { state: "rejected"; name: string; message: string };
          const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
            promise.then(
              () => ({ state: "resolved" }),
              (reason: unknown) => ({
                state: "rejected",
                name: reason instanceof Error ? reason.name : "Unknown",
                message: reason instanceof Error ? reason.message : String(reason),
              }),
            );
          const withPdf = async <T>(
            bytes: number[],
            exercise: (pdf: import("pdfjs-dist").PDFDocumentProxy) => Promise<T>,
          ): Promise<T> => {
            const nativeWorker = new Worker(workerUrl, { type: "module" });
            let worker: import("pdfjs-dist").PDFWorker | undefined;
            let loading: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
            try {
              worker = engine.PDFWorker.create({ port: nativeWorker });
              loading = engine.getDocument({
                data: Uint8Array.from(bytes),
                worker,
                stopAtErrors: true,
                maxImageSize: 16_000_000,
                disableFontFace: true,
                useSystemFonts: false,
                enableXfa: false,
              });
              return await exercise(await loading.promise);
            } finally {
              try {
                await loading?.destroy();
              } finally {
                worker?.destroy();
                nativeWorker.terminate();
              }
            }
          };
          const canvasFor = (viewport: { width: number; height: number }) => {
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            return canvas;
          };
          const failures = await withPdf(oversized, async (pdf) => {
            const pdfPage = await pdf.getPage(1);
            const viewport = pdfPage.getViewport({ scale: 1 });
            const firstCanvas = canvasFor(viewport);
            const secondCanvas = canvasFor(viewport);
            const first = pdfPage.render({ canvas: firstCanvas, viewport });
            const parallel = pdfPage.render({ canvas: secondCanvas, viewport });
            const [firstRender, parallelRender] = await Promise.all([
              outcome(first.promise),
              outcome(parallel.promise),
            ]);
            const replayRender = await outcome(
              pdfPage.render({ canvas: firstCanvas, viewport }).promise,
            );
            // getOperatorList has its own public intent/cache. Exercise both its
            // first failed read and the cached rejected promise independently.
            const operatorList = await outcome(pdfPage.getOperatorList());
            const operatorListReplay = await outcome(pdfPage.getOperatorList());
            return {
              outcomes: {
                firstRender,
                parallelRender,
                replayRender,
                operatorList,
                operatorListReplay,
              },
              cleanup: pdfPage.cleanup(),
            };
          });
          const recovery = await withPdf(readable, async (pdf) => {
            const pdfPage = await pdf.getPage(1);
            const viewport = pdfPage.getViewport({ scale: 1 });
            const canvas = canvasFor(viewport);
            const first = pdfPage.render({ canvas, viewport });
            let cancelledFromContinue = false;
            first.onContinue = () => {
              cancelledFromContinue = true;
              first.cancel();
            };
            const cancellation = await outcome(first.promise);
            // Reuse the same page and canvas immediately, including the normal
            // delayed stream-cancellation window, without a cleanup/reset shortcut.
            await pdfPage.render({ canvas, viewport }).promise;
            const pixel = canvas
              .getContext("2d")
              ?.getImageData(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1,
                1,
              ).data;
            const red = pixel?.[0] ?? 0;
            return {
              cancelledFromContinue,
              cancellation,
              painted:
                pixel?.[3] === 255 &&
                red > 100 &&
                red < 170 &&
                Math.abs(red - (pixel?.[1] ?? 0)) < 3 &&
                Math.abs(red - (pixel?.[2] ?? 0)) < 3,
              cleanup: pdfPage.cleanup(),
            };
          });
          return { version: engine.version, failures, recovery };
        },
        {
          workerUrl: `${origin}/__pdfjs_public_api/pdf.worker.mjs`,
          readable: Array.from(createScanPreviewPdf(250, 350)),
          oversized: Array.from(createScanPreviewPdf(5_000, 7_000)),
        },
      );
      expect(result.version).toBe("6.4.299");
      for (const failure of Object.values(result.failures.outcomes)) {
        expect(failure).toMatchObject({ state: "rejected" });
        if (failure.state === "rejected") {
          expect(failure.message).toContain("Image exceeded maximum allowed size");
        }
      }
      expect(result.failures.cleanup).toBe(true);
      expect(result.recovery).toMatchObject({
        cancelledFromContinue: true,
        cancellation: { state: "rejected", name: "RenderingCancelledException" },
        painted: true,
        cleanup: true,
      });
      expect(cspViolations).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
