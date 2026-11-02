// Document Extract tests cover document extractor plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createEngineMock, openPdfMock, pdfDocument } = vi.hoisted(() => ({
  createEngineMock: vi.fn(),
  openPdfMock: vi.fn(),
  pdfDocument: {
    pageCount: 2,
    extract: vi.fn(),
    destroy: vi.fn(),
  },
}));

vi.mock("clawpdf", () => ({
  createEngine: createEngineMock,
}));

import { createPdfDocumentExtractor } from "./document-extractor.js";

function request(overrides = {}) {
  return {
    buffer: Buffer.from("%PDF-1.4"),
    mimeType: "application/pdf",
    maxPages: 2,
    maxPixels: 100,
    minTextChars: 10,
    ...overrides,
  };
}

function renderedPage(page: number) {
  return {
    bytes: Uint8Array.from(Buffer.from(`png${page}`)),
    mimeType: "image/png" as const,
    page,
    width: 5,
    height: 10,
  };
}

describe("PDF document extractor", () => {
  afterAll(() => {
    vi.doUnmock("clawpdf");
    vi.resetModules();
  });

  beforeEach(() => {
    createEngineMock.mockResolvedValue({ open: openPdfMock });
    openPdfMock.mockReset();
    openPdfMock.mockResolvedValue(pdfDocument);
    pdfDocument.pageCount = 2;
    pdfDocument.extract.mockReset();
    pdfDocument.destroy.mockReset();
  });

  it("declares PDF support", () => {
    const extractor = createPdfDocumentExtractor();
    const { extract, ...descriptor } = extractor;
    expect(extract).toBeInstanceOf(Function);
    expect(descriptor).toEqual({
      id: "pdf",
      label: "PDF",
      mimeTypes: ["application/pdf"],
      autoDetectOrder: 10,
    });
  });

  it("extracts text first and renders each fallback page with its own pixel budget", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({
        text: "",
        images: [renderedPage(1)],
      })
      .mockResolvedValueOnce({
        text: "",
        images: [renderedPage(2)],
      });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request());

    if (!result) {
      throw new Error("Expected PDF extraction result");
    }
    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(1, {
      mode: "text",
      maxPages: 2,
      maxTextChars: 200_000,
    });
    // Each page renders in its own extract() call, with the aggregate pixel cap
    // allocated across selected pages so later pages are not starved.
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(2, {
      mode: "images",
      pages: [1],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(3, {
      mode: "images",
      pages: [2],
      image: { maxDimension: 10_000, maxPixels: 50, forms: true },
    });
    expect(result).toEqual({
      text: "",
      images: [
        { type: "image", data: "cG5nMQ==", mimeType: "image/png", pageNumber: 1 },
        { type: "image", data: "cG5nMg==", mimeType: "image/png", pageNumber: 2 },
      ],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("skips image fallback when enough text is extracted", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ minTextChars: 5 }));

    expect(result).toEqual({ text: "enough text", images: [] });
    expect(pdfDocument.extract).toHaveBeenCalledTimes(1);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "text-rich pages", requested: [1, 2], pages: [1, 2] },
    { label: "late repeated pages", requested: [97, 98, 97], pages: [97, 98] },
  ])("renders $label when images are explicitly requested", async ({ requested, pages }) => {
    const text = "Readable specification text. ".repeat(10);
    pdfDocument.pageCount = 100;
    pdfDocument.extract.mockResolvedValueOnce({ text, images: [] });
    for (const page of pages) {
      pdfDocument.extract.mockResolvedValueOnce({ text: "", images: [renderedPage(page)] });
    }

    const result = await createPdfDocumentExtractor().extract(
      request({ renderImages: true, pageNumbers: requested, minTextChars: 200 }),
    );

    expect(pdfDocument.extract).toHaveBeenNthCalledWith(1, {
      mode: "text",
      pages,
      maxTextChars: 200_000,
    });
    for (const [index, page] of pages.entries()) {
      expect(pdfDocument.extract).toHaveBeenNthCalledWith(index + 2, {
        mode: "images",
        pages: [page],
        image: { maxDimension: 10_000, maxPixels: 50, forms: true },
      });
    }
    expect(result).toEqual({
      text,
      images: pages.map((pageNumber) => ({
        type: "image",
        data: Buffer.from(`png${pageNumber}`).toString("base64"),
        mimeType: "image/png",
        pageNumber,
      })),
    });
    expect(pdfDocument.extract).toHaveBeenCalledTimes(3);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "missing", pageNumbers: [1, 3], maxPages: 2 },
    { label: "invalid", pageNumbers: [0, 1], maxPages: 2 },
    { label: "over-limit", pageNumbers: [1, 2], maxPages: 1 },
  ])(
    "rejects $label visual page selections before extraction",
    async ({ pageNumbers, maxPages }) => {
      await expect(
        createPdfDocumentExtractor().extract(
          request({ renderImages: true, pageNumbers, maxPages }),
        ),
      ).rejects.toThrow(/page/i);

      expect(pdfDocument.extract).not.toHaveBeenCalled();
      expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("surfaces explicit image rendering failures despite extractable text", async () => {
    const failure = new Error("page render failed");
    const onImageExtractionError = vi.fn();
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "Readable text. ".repeat(30), images: [] })
      .mockRejectedValueOnce(failure);

    await expect(
      createPdfDocumentExtractor().extract(
        request({ renderImages: true, pageNumbers: [1], onImageExtractionError }),
      ),
    ).rejects.toThrow(/image|render/i);

    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "empty image output", firstImages: [], secondImages: [] },
    { label: "missing second page", firstImages: [renderedPage(1)], secondImages: [] },
    {
      label: "incorrect source page",
      firstImages: [renderedPage(1)],
      secondImages: [renderedPage(1)],
    },
  ])(
    "rejects $label instead of returning text-only visual success",
    async ({ firstImages, secondImages }) => {
      pdfDocument.extract
        .mockResolvedValueOnce({ text: "Readable text. ".repeat(30), images: [] })
        .mockResolvedValueOnce({ text: "", images: firstImages })
        .mockResolvedValueOnce({ text: "", images: secondImages });

      await expect(
        createPdfDocumentExtractor().extract(request({ renderImages: true, pageNumbers: [1, 2] })),
      ).rejects.toThrow(/image|render/i);

      expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
    },
  );

  it("opens encrypted PDFs with the request password", async () => {
    pdfDocument.extract.mockResolvedValueOnce({ text: "enough text", images: [] });
    const extractor = createPdfDocumentExtractor();

    await extractor.extract(request({ password: "secret" }));

    expect(openPdfMock).toHaveBeenCalledWith(expect.any(Uint8Array), { password: "secret" });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it("normalizes clawpdf password errors", async () => {
    openPdfMock.mockRejectedValueOnce(
      Object.assign(new Error("bad password"), { code: "password" }),
    );
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ password: "wrong" }))).rejects.toThrow(
      "PDF requires a password or password is incorrect.",
    );
    expect(pdfDocument.destroy).not.toHaveBeenCalled();
  });

  it("filters selected pages and renders them one page per image call", async () => {
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] })
      .mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ pageNumbers: [3, 2, 0, 1], maxPages: 2 }));

    expect(result).toEqual({ text: "", images: [] });
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mode: "text", pages: [2, 1] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mode: "images", pages: [2] }),
    );
    expect(pdfDocument.extract).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ mode: "images", pages: [1] }),
    );
  });

  it("rejects selected pages outside the PDF page count before extraction", async () => {
    pdfDocument.pageCount = 1;
    pdfDocument.extract.mockResolvedValueOnce({ text: "", images: [] });
    const extractor = createPdfDocumentExtractor();

    await expect(extractor.extract(request({ pageNumbers: [2] }))).rejects.toThrow(
      "No requested PDF pages exist in this 1-page document.",
    );
    expect(pdfDocument.extract).not.toHaveBeenCalled();
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);

    await expect(extractor.extract(request({ pageNumbers: [] }))).resolves.toEqual({
      text: "",
      images: [],
    });
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(2);
  });

  it("reports image fallback failures and returns extracted text", async () => {
    const onImageExtractionError = vi.fn();
    const failure = new Error("render failed");
    pdfDocument.extract
      .mockResolvedValueOnce({ text: "short", images: [] })
      .mockRejectedValueOnce(failure);
    const extractor = createPdfDocumentExtractor();

    const result = await extractor.extract(request({ onImageExtractionError }));

    expect(result).toEqual({ text: "short", images: [] });
    expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "empty", text: "", reportError: true },
    { label: "whitespace-only", text: " \t\n", reportError: false },
  ])("surfaces image fallback failures for $label PDF text", async ({ text, reportError }) => {
    const { PdfBudgetError } = await vi.importActual<typeof import("clawpdf")>("clawpdf");
    const onImageExtractionError = vi.fn();
    const failure = new PdfBudgetError("renderPixels", 100);
    pdfDocument.extract.mockResolvedValueOnce({ text, images: [] }).mockRejectedValueOnce(failure);
    const overrides = reportError ? { onImageExtractionError } : {};

    await expect(createPdfDocumentExtractor().extract(request(overrides))).rejects.toMatchObject({
      message: "PDF image extraction failed with no extractable text.",
      cause: failure,
    });
    expect(onImageExtractionError).toHaveBeenCalledTimes(reportError ? 1 : 0);
    if (reportError) {
      expect(onImageExtractionError).toHaveBeenCalledWith(failure);
    }
    expect(pdfDocument.destroy).toHaveBeenCalledTimes(1);
  });
});
