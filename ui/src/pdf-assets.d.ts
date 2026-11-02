declare module "virtual:openclaw-pdf-assets" {
  export const pdfAssetUrls: {
    readonly cMapUrl: string;
    readonly standardFontDataUrl: string;
    readonly wasmUrl: string;
    readonly iccUrl: string;
  };
}

declare module "pdfjs-dist/build/pdf.worker.min.mjs?worker&url" {
  const workerUrl: string;
  export default workerUrl;
}
