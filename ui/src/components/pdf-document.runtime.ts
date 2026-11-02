import {
  AnnotationMode,
  PDFWorker,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?worker&url";
import { pdfAssetUrls } from "virtual:openclaw-pdf-assets";

export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";

export type PdfDocumentHandle = {
  promise: Promise<PDFDocumentProxy>;
  destroy(): Promise<void>;
};

const PDF_MAX_IMAGE_PIXELS = 16_000_000;
const WORKER_CLEANUP_TIMEOUT_MS = 1_000;

function localUrl(value: string): string {
  const url = new URL(value, document.baseURI);
  if (url.origin !== location.origin || !/^https?:$/u.test(url.protocol)) {
    throw new Error("PDF assets must be served by this application");
  }
  return url.href;
}

/** The caller retains its source bytes; PDF.js takes ownership of this private copy. */
export function openPdfDocument(
  bytes: Uint8Array | ArrayBuffer,
  onFailure: (kind: "password" | "unavailable") => void,
): PdfDocumentHandle {
  const nativeWorker = new Worker(localUrl(workerUrl), {
    type: "module",
    name: "openclaw-document-preview",
  });
  let rejectWorkerFailure: (reason: Error) => void;
  const workerFailure = new Promise<never>((_resolve, reject) => {
    rejectWorkerFailure = reject;
  });
  let destroyed = false;
  const fail = (kind: "password" | "unavailable") => {
    if (!destroyed) {
      rejectWorkerFailure(new Error("PDF worker unavailable"));
      onFailure(kind);
    }
  };
  const onWorkerError = () => fail("unavailable");
  nativeWorker.addEventListener("error", onWorkerError);
  // PDF.js 6.4 display/api.js initializes a supplied port directly. Supplying
  // our native Worker prevents its automatic main-thread fake-worker fallback.
  let worker: PDFWorker | undefined;
  let task: ReturnType<typeof getDocument>;
  try {
    worker = PDFWorker.create({ port: nativeWorker });
    task = getDocument({
      data: bytes instanceof Uint8Array ? bytes.slice() : bytes.slice(0),
      worker,
      cMapUrl: localUrl(pdfAssetUrls.cMapUrl),
      cMapPacked: true,
      standardFontDataUrl: localUrl(pdfAssetUrls.standardFontDataUrl),
      wasmUrl: localUrl(pdfAssetUrls.wasmUrl),
      iccUrl: localUrl(pdfAssetUrls.iccUrl),
      useWorkerFetch: true,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      // PDF.js otherwise reports success after silently omitting oversized scans.
      stopAtErrors: true,
      maxImageSize: PDF_MAX_IMAGE_PIXELS,
      canvasMaxAreaInBytes: PDF_MAX_IMAGE_PIXELS * 4,
    });
  } catch (error) {
    nativeWorker.removeEventListener("error", onWorkerError);
    worker?.destroy();
    nativeWorker.terminate();
    throw error;
  }
  task.onPassword = () => fail("password");
  return {
    promise: Promise.race([task.promise, workerFailure]),
    async destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      rejectWorkerFailure(new Error("PDF preview retired"));
      nativeWorker.removeEventListener("error", onWorkerError);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        // A failed bootstrap may leave PDF.js's setup promise pending. Always
        // terminate our own port even when graceful task destruction cannot finish.
        await Promise.race([
          task.destroy().catch(() => undefined),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, WORKER_CLEANUP_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        worker?.destroy();
        nativeWorker.terminate();
      }
    },
  };
}

/** Preserve static annotation appearances without installing interactive or scripting layers. */
export function renderPdfPage(
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  viewport: PageViewport,
): RenderTask {
  return page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE });
}
