import { describe, expect, it } from "vitest";
import { createPdfDocumentExtractor } from "./document-extractor.js";

// A text-rich, vector-only specification exercises real PDFium rendering rather
// than embedded raster extraction. Late pages include a rotated diagram.
function specificationPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count 100 /Kids [${Array.from({ length: 100 }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let page = 1; page <= 100; page++) {
    const text = Array.from(
      { length: 8 },
      (_, line) =>
        `BT /F1 12 Tf 40 ${740 - line * 20} Td (Page ${page}: signal timing and register specification line ${line + 1}) Tj ET`,
    ).join("\n");
    const stream = `${text}\n1 w 40 400 150 80 re S 380 400 150 80 re S\n190 440 m 380 440 l S 370 445 m 380 440 l 370 435 l S\nBT /F1 16 Tf 55 430 Td (CLK source) Tj ET\nBT /F1 16 Tf 395 430 Td (REG 0x2A) Tj ET\n`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${page === 98 ? "/Rotate 90" : ""} /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (page - 1) * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

describe("PDF page rendering with PDFium", () => {
  it("renders original late vector pages despite sufficient text and preserves rotation", async () => {
    const extractor = createPdfDocumentExtractor();
    const request = {
      buffer: specificationPdf(),
      mimeType: "application/pdf",
      maxPages: 2,
      maxPixels: 4_000_000,
      minTextChars: 200,
      pageNumbers: [97, 98, 97],
    };
    const normal = await extractor.extract(request);
    expect(normal?.text.length).toBeGreaterThan(200);
    expect(normal?.images).toEqual([]);

    const visual = await extractor.extract({ ...request, renderImages: true });
    expect(visual?.text).toContain("Page 97");
    expect(visual?.text).toContain("Page 98");
    expect(visual?.images.map((image) => image.pageNumber)).toEqual([97, 98]);
    const dimensions = visual?.images.map((image) => {
      const png = Buffer.from(image.data, "base64");
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      expect(Math.min(width, height)).toBeGreaterThan(100);
      return { width, height };
    });
    expect(dimensions?.[0]?.width).toBe(dimensions?.[1]?.height);
    expect(dimensions?.[0]?.height).toBe(dimensions?.[1]?.width);
    expect(
      dimensions?.reduce((pixels, { width, height }) => pixels + width * height, 0),
    ).toBeLessThanOrEqual(4_000_000);
  });
});
