import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  DOCUMENT_CHANGE_CROP_MAX_BYTES,
  DOCUMENT_CHANGE_INSTRUCTION_MAX,
  DOCUMENT_CHANGE_TEXT_MAX,
  type DocumentChangeRequest,
} from "../../components/document-viewer-request.ts";
import { t } from "../../i18n/index.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import {
  areUiSessionKeysEquivalent,
  resolveUiSelectedSessionAgentId,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { persistedMessageEntryId } from "./chat-thread-items.ts";
import { chatAttachmentFromDataUrl } from "./components/chat-attachments.ts";
import { extractTranscriptAttachments } from "./components/chat-message-media.ts";
import type { ChatDocumentChangeHandler, ChatDocumentSource } from "./document-change-contract.ts";

type DocumentChangeHost = UiSessionDefaultsHost &
  Pick<
    ChatPageHost,
    | "sessionKey"
    | "currentSessionId"
    | "client"
    | "connectionEpoch"
    | "chatMessages"
    | "handleSendChat"
  >;

function sourceIsCurrent(state: DocumentChangeHost, source: ChatDocumentSource): boolean {
  if (
    !source.messageId ||
    source.messageId.length > 256 ||
    (source.artifactId?.length ?? 0) > 256 ||
    !areUiSessionKeysEquivalent(state.sessionKey, source.sessionKey) ||
    !state.chatMessages.includes(source.message) ||
    persistedMessageEntryId(source.message) !== source.messageId
  ) {
    return false;
  }
  const attachments = [
    ...normalizeMessage(source.message).content.filter((item) => item.type === "attachment"),
    ...extractTranscriptAttachments(source.message),
  ];
  return attachments.some(
    ({ attachment }) =>
      attachment.url === source.sourceIdentity &&
      attachment.artifactId === source.artifactId &&
      attachment.label === source.label,
  );
}

function validRequest(request: DocumentChangeRequest): boolean {
  const { region, cropDataUrl, selectedText, instruction, pageNumber } = request;
  if (
    !Number.isSafeInteger(pageNumber) ||
    pageNumber < 1 ||
    !instruction.trim() ||
    instruction.length > DOCUMENT_CHANGE_INSTRUCTION_MAX ||
    (selectedText?.length ?? 0) > DOCUMENT_CHANGE_TEXT_MAX ||
    (!region && !selectedText?.trim())
  ) {
    return false;
  }
  if (
    region &&
    (![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
      region.x < 0 ||
      region.y < 0 ||
      region.width <= 0 ||
      region.height <= 0 ||
      region.x + region.width > 1 ||
      region.y + region.height > 1 ||
      !cropDataUrl)
  ) {
    return false;
  }
  if (cropDataUrl) {
    const maxCharacters = Math.ceil(DOCUMENT_CHANGE_CROP_MAX_BYTES / 3) * 4;
    const payload = cropDataUrl.slice("data:image/png;base64,".length);
    if (
      payload.length > maxCharacters ||
      !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u.test(cropDataUrl)
    ) {
      return false;
    }
    try {
      if (atob(payload).length > DOCUMENT_CHANGE_CROP_MAX_BYTES) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

/** The existing outbox owns the crop and Retry only after onAdmitted fires. */
export function createChatDocumentChangeHandler(params: {
  state: DocumentChangeHost;
  isCurrent: () => boolean;
}): ChatDocumentChangeHandler {
  const { state } = params;
  const sessionKey = state.sessionKey;
  const sessionId = state.currentSessionId;
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const agentId = resolveUiSelectedSessionAgentId(state);
  return async (source, request, signal) => {
    const isCurrent = () =>
      !signal.aborted &&
      params.isCurrent() &&
      state.sessionKey === sessionKey &&
      state.currentSessionId === sessionId &&
      state.client === client &&
      state.connectionEpoch === connectionEpoch &&
      resolveUiSelectedSessionAgentId(state) === agentId &&
      sourceIsCurrent(state, source);
    if (!isCurrent()) {
      return { admitted: false, message: t("chat.sendErrors.activeLeafChanged") };
    }
    if (!validRequest(request)) {
      return { admitted: false, message: t("chat.documentViewer.requestUnavailable") };
    }
    const attachment = request.cropDataUrl
      ? chatAttachmentFromDataUrl(
          request.cropDataUrl,
          `document-selection-${source.pageUnit}-${request.pageNumber}.png`,
        )
      : null;
    if (request.cropDataUrl && !attachment) {
      return { admitted: false, message: t("chat.documentViewer.requestUnavailable") };
    }
    const attachments = attachment ? [attachment] : [];
    const filename = truncateUtf16Safe(source.label.split(/[\\/]/u).at(-1) ?? "document", 256);
    const page = t(
      source.pageUnit === "slide"
        ? "chat.documentViewer.slideThumbnail"
        : "chat.documentViewer.pageThumbnail",
      { page: String(request.pageNumber) },
    );
    const parts = [
      t("chat.documentViewer.changeRequestTitle", { filename, page }),
      request.instruction.trim(),
    ];
    if (request.selectedText?.trim()) {
      const quoted = request.selectedText
        .trim()
        .split(/\r?\n/u)
        .map((line) => `> ${line}`)
        .join("\n");
      parts.push(`${t("chat.documentViewer.selectedText")}:\n${quoted}`);
    }
    if (request.region) {
      const percent = (value: number) => String(Math.round(value * 10_000) / 100);
      parts.push(
        t("chat.documentViewer.changeRequestRegion", {
          x: percent(request.region.x),
          y: percent(request.region.y),
          width: percent(request.region.width),
          height: percent(request.region.height),
        }),
      );
    }
    if (attachment) {
      parts.push(t("chat.documentViewer.changeRequestCrop"));
    }
    const text = parts.join("\n\n");
    let admitted = false;
    try {
      admitted = await new Promise<boolean>((resolve) => {
        void state
          .handleSendChat(text, {
            literalMessage: true,
            ignoreReplyTarget: true,
            replyToId: source.messageId,
            attachments,
            isSubmissionCurrent: isCurrent,
            onAdmitted: () => {
              admitted = true;
              resolve(true);
            },
          })
          .then(
            () => resolve(false),
            () => resolve(false),
          );
      });
      return admitted
        ? { admitted: true }
        : {
            admitted: false,
            message: t(
              isCurrent()
                ? "chat.documentViewer.requestUnavailable"
                : "chat.sendErrors.activeLeafChanged",
            ),
          };
    } finally {
      if (!admitted) {
        releaseChatAttachmentPayloads(attachments);
      }
    }
  };
}
