import type {
  DocumentChangeRequest,
  DocumentChangeResult,
} from "../../components/document-viewer-request.ts";

export type ChatDocumentSource = {
  sessionKey: string;
  messageId: string;
  message: unknown;
  sourceIdentity: string;
  artifactId?: string;
  label: string;
  pageUnit: "page" | "slide";
};

export type ChatDocumentChangeHandler = (
  source: ChatDocumentSource,
  request: DocumentChangeRequest,
  signal: AbortSignal,
) => Promise<DocumentChangeResult>;
