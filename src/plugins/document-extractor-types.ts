/** Image extracted from a document page. */
export type DocumentExtractedImage = {
  type: "image";
  data: string;
  mimeType: string;
  /** Original 1-based source page, when the extractor renders a page. */
  pageNumber?: number;
};

/** Request passed to plugin document extractors. */
export type DocumentExtractionRequest = {
  buffer: Buffer;
  mimeType: string;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  password?: string;
  pageNumbers?: number[];
  /** Render every selected page even when text is sufficient; fail if any image is unavailable. */
  renderImages?: boolean;
  onImageExtractionError?: (error: unknown) => void;
};

/** Text and image result returned by a document extractor. */
export type DocumentExtractionResult = {
  text: string;
  images: DocumentExtractedImage[];
};

/** Plugin document extractor capability contract. */
export type DocumentExtractorPlugin = {
  id: string;
  label: string;
  mimeTypes: readonly string[];
  autoDetectOrder?: number;
  extract: (request: DocumentExtractionRequest) => Promise<DocumentExtractionResult | null>;
};

/** Registered document extractor with owning plugin id. */
export type PluginDocumentExtractorEntry = DocumentExtractorPlugin & {
  pluginId: string;
};
