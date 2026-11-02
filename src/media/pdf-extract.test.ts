// PDF extraction tests cover text extraction adapter selection and failures.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { extractDocumentContentMock } = vi.hoisted(() => ({
  extractDocumentContentMock: vi.fn(),
}));

vi.mock("./document-extractors.runtime.js", () => ({
  extractDocumentContent: extractDocumentContentMock,
}));

import { extractPdfContent } from "./pdf-extract.js";

describe("extractPdfContent", () => {
  beforeEach(() => {
    extractDocumentContentMock.mockReset();
  });

  it("dispatches PDF extraction through document extractors", async () => {
    extractDocumentContentMock.mockResolvedValue({
      text: "extracted pdf",
      images: [],
      extractor: "pdf",
    });

    await expect(
      extractPdfContent({
        buffer: Buffer.from("%PDF-1.4"),
        maxPages: 2,
        maxPixels: 100,
        minTextChars: 10,
      }),
    ).resolves.toEqual({ text: "extracted pdf", images: [] });
    expect(extractDocumentContentMock).toHaveBeenCalledWith({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
    });
  });

  it("preserves forced rendering and original page provenance", async () => {
    const images = [{ type: "image", data: "cG5n", mimeType: "image/png", pageNumber: 97 }];
    extractDocumentContentMock.mockResolvedValue({ text: "diagram", images, extractor: "pdf" });

    await expect(
      extractPdfContent({
        buffer: Buffer.from("pdf"),
        maxPages: 2,
        maxPixels: 100,
        minTextChars: 200,
        pageNumbers: [97],
        renderImages: true,
      }),
    ).resolves.toEqual({ text: "diagram", images });
    expect(extractDocumentContentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumbers: [97],
        renderImages: true,
      }),
    );
  });

  it("passes PDF passwords through to document extractors", async () => {
    extractDocumentContentMock.mockResolvedValue({
      text: "encrypted pdf",
      images: [],
      extractor: "pdf",
    });

    await extractPdfContent({
      buffer: Buffer.from("%PDF-1.4"),
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
      password: "secret",
    });

    expect(extractDocumentContentMock).toHaveBeenCalledWith({
      buffer: Buffer.from("%PDF-1.4"),
      mimeType: "application/pdf",
      maxPages: 2,
      maxPixels: 100,
      minTextChars: 10,
      password: "secret",
    });
  });

  it("throws a clear disabled error when no document extractor is available", async () => {
    extractDocumentContentMock.mockResolvedValue(null);

    await expect(
      extractPdfContent({
        buffer: Buffer.from("%PDF-1.4"),
        maxPages: 2,
        maxPixels: 100,
        minTextChars: 10,
      }),
    ).rejects.toThrow("PDF extraction disabled or unavailable");
  });
});
