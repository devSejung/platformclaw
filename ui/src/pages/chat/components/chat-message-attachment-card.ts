import { html } from "lit";
import type { DocumentChangeHandler } from "../../../components/document-viewer-request.ts";
import { icons } from "../../../components/icons.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { documentPreviewKind } from "./chat-document-attachment.ts";
import { isHtmlAttachment } from "./chat-html-attachment.ts";
import { isManagedOutgoingMediaSource } from "./chat-message-attachment-availability.ts";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

export function renderAssistantDocumentAttachment(params: {
  url: string;
  attachment: AttachmentItem["attachment"];
  sizeBytes?: number;
  options?: ImageRenderOptions;
}) {
  const { attachment, options } = params;
  if (isManagedOutgoingMediaSource(attachment.url)) {
    if (isHtmlAttachment(attachment.mimeType, attachment.label)) {
      return html`<openclaw-chat-html-attachment
        .src=${params.url}
        .sourceIdentity=${attachment.url}
        .label=${attachment.label}
        .embedSandboxMode=${options?.embedSandboxMode ?? "scripts"}
        .onMediaLoaded=${options?.onAssistantAttachmentLoaded}
      ></openclaw-chat-html-attachment>`;
    }
    if (documentPreviewKind(attachment.mimeType, attachment.label)) {
      const pageUnit =
        documentPreviewKind(attachment.mimeType, attachment.label) === "powerpoint"
          ? "slide"
          : "page";
      const requestChanges = options?.onDocumentChangeRequest;
      const source =
        options?.sessionKey && options.messageId && options.sourceMessage
          ? ({
              sessionKey: options.sessionKey,
              messageId: options.messageId,
              message: options.sourceMessage,
              sourceIdentity: attachment.url,
              artifactId: attachment.artifactId,
              label: attachment.label,
              pageUnit,
            } as const)
          : undefined;
      const handler: DocumentChangeHandler | undefined =
        requestChanges && source
          ? (request, signal) => requestChanges(source, request, signal)
          : undefined;
      return html`<openclaw-chat-document-attachment
        .src=${params.url}
        .sourceIdentity=${attachment.url}
        .label=${attachment.label}
        .mimeType=${attachment.mimeType ?? ""}
        .sizeBytes=${params.sizeBytes}
        .requestChanges=${handler}
        .onMediaLoaded=${options?.onAssistantAttachmentLoaded}
      ></openclaw-chat-document-attachment>`;
    }
  }
  const downloadHref = safeAttachmentHref(params.url);
  return html`
    <div class="chat-assistant-attachment-card">
      <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
      ${downloadHref
        ? html`<a
            class="chat-assistant-attachment-card__link"
            href=${downloadHref}
            target="_blank"
            rel="noreferrer"
            >${attachment.label}</a
          >`
        : html`<span class="chat-assistant-attachment-card__title">${attachment.label}</span>`}
    </div>
  `;
}
