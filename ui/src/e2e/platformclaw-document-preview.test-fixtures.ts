import { deflateSync } from "node:zlib";
import JSZip from "jszip";

export type DocumentPreviewFormat = "image" | "pdf" | "powerpoint";

export type DocumentPreviewFixture = {
  format: DocumentPreviewFormat;
  filename: string;
  mimeType: string;
  bytes: Buffer;
};

function createPreviewPng(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const width = 320;
  const height = 180;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      pixels[offset] = x < width / 2 ? 15 : 232;
      pixels[offset + 1] = y < height / 2 ? 166 : 110;
      pixels[offset + 2] = 155;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function createPdf(objects: readonly (string | Buffer)[]): Buffer {
  const header = Buffer.from("%PDF-1.4\n% PlatformClaw document fixture\n");
  const chunks: Buffer[] = [header];
  let length = header.length;
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const objectChunks = [
      Buffer.from(`${index + 1} 0 obj\n`),
      typeof object === "string" ? Buffer.from(object) : object,
      Buffer.from("\nendobj\n"),
    ];
    chunks.push(...objectChunks);
    length += objectChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...chunks, Buffer.from(xref)]);
}

function pdfStream(dictionary: string, content: string | Buffer): Buffer {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    Buffer.from("\nendstream"),
  ]);
}

function createPreviewPdf(): Buffer {
  const content =
    "0.06 0.65 0.61 rg 50 560 500 100 re f\nBT /F1 24 Tf 50 700 Td (Owned document preview) Tj 0 -40 Td (PDF snapshot from the selected runtime) Tj ET\n";
  return createPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    pdfStream("", content),
    // Magenta exists only in this static appearance, so disabling annotation
    // rendering cannot pass the real browser's independent pixel assertion.
    "<< /Type /Annot /Subtype /Square /Rect [80 360 300 440] /F 4 /AP << /N 7 0 R >> >>",
    pdfStream(
      "/Type /XObject /Subtype /Form /BBox [0 0 220 80] /Resources << >>",
      "1 0 1 rg 0 0 220 80 re f",
    ),
  ]);
}

/** Uniform grayscale compresses well while preserving the requested decoded-image dimensions. */
export function createScanPreviewPdf(width: number, height: number): Buffer {
  const compressed = deflateSync(Buffer.alloc(width * height, 128));
  return createPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 700] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>",
    pdfStream("", "q 500 0 0 700 0 0 cm /Scan Do Q"),
    pdfStream(
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
      compressed,
    ),
  ]);
}

async function createPreviewPresentation(): Promise<Buffer> {
  const archive = new JSZip();
  const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
  const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
  archive.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
  );
  archive.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  archive.file(
    "ppt/presentation.xml",
    `<?xml version="1.0"?><p:presentation xmlns:p="${presentation}" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  archive.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${office}/slide" Target="slides/slide2.xml"/></Relationships>`,
  );
  for (const slide of [1, 2]) {
    archive.file(
      `ppt/slides/slide${slide}.xml`,
      `<?xml version="1.0"?><p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0FA69B"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Owned slide ${slide}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="914400"/><a:ext cx="8229600" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>Owned presentation slide ${slide}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
  }
  return archive.generateAsync({ type: "nodebuffer" });
}

export async function createDocumentPreviewFixtures(
  formats: readonly DocumentPreviewFormat[],
): Promise<DocumentPreviewFixture[]> {
  return Promise.all(
    formats.map(async (format) => {
      switch (format) {
        case "image":
          return {
            format,
            filename: "owned-chart.png",
            mimeType: "image/png",
            bytes: createPreviewPng(),
          };
        case "pdf":
          return {
            format,
            filename: "owned-report.pdf",
            mimeType: "application/pdf",
            bytes: createPreviewPdf(),
          };
        case "powerpoint":
          return {
            format,
            filename: "owned-slides.pptx",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            bytes: await createPreviewPresentation(),
          };
      }
      throw new Error("Unsupported document preview fixture format");
    }),
  );
}
