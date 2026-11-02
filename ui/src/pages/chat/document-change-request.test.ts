/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentChangeRequest } from "../../components/document-viewer-request.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { createChatDocumentChangeHandler } from "./document-change-request.ts";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz1kAAAAASUVORK5CYII=";
const payloads: ChatAttachment[] = [];
afterEach(() => releaseChatAttachmentPayloads(payloads.splice(0)));

function isAttachment(value: unknown): value is ChatAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  );
}

function submission(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("onAdmitted" in value) ||
    !("isSubmissionCurrent" in value) ||
    !("attachments" in value) ||
    typeof value.onAdmitted !== "function" ||
    typeof value.isSubmissionCurrent !== "function" ||
    !Array.isArray(value.attachments)
  ) {
    throw new Error("Expected document request submission");
  }
  const attachments = value.attachments.filter(isAttachment);
  payloads.push(...attachments);
  return { onAdmitted: value.onAdmitted, isCurrent: value.isSubmissionCurrent, attachments };
}

function fixture(
  send: (text: string | undefined, options: unknown) => Promise<void>,
  sessionKey = "agent:employee:main",
) {
  const attachment = {
    url: "/api/chat/media/outgoing/agent%3Aemployee%3Amain/snapshot-id/full",
    kind: "document",
    label: "slides.pptx",
    artifactId: "owned-artifact",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  const message = {
    role: "assistant",
    id: "source-message",
    content: [{ type: "attachment", attachment }],
  };
  const state = {
    sessionKey,
    assistantAgentId: "employee",
    currentSessionId: "source-session",
    client: null,
    connectionEpoch: 1,
    chatMessages: [message],
    chatError: null,
    handleSendChat: vi.fn(send),
  };
  const source: Parameters<ReturnType<typeof createChatDocumentChangeHandler>>[0] = {
    sessionKey: state.sessionKey,
    messageId: message.id,
    message,
    sourceIdentity: attachment.url,
    artifactId: attachment.artifactId,
    label: attachment.label,
    pageUnit: "slide",
  };
  const request: DocumentChangeRequest = {
    pageNumber: 1,
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
    selectedText: "Quarterly revenue",
    instruction: "Make this heading clearer.",
    cropDataUrl: PNG,
  };
  const controller = new AbortController();
  let allowed = true;
  const handler = createChatDocumentChangeHandler({ state, isCurrent: () => allowed });
  return {
    state,
    source,
    request,
    controller,
    handler,
    attachment,
    deny: () => {
      allowed = false;
    },
  };
}

describe("document change request admission", () => {
  it("hands a bounded source reference and crop to the outbox before delivery finishes", async () => {
    let finish!: () => void;
    const delivery = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const test = fixture(async (_text, options) => {
      const queued = submission(options);
      expect(queued.isCurrent()).toBe(true);
      queued.onAdmitted();
      await delivery;
    });
    Object.assign(test.request.region!, { unrelated: "must not enter the prompt" });
    expect(await test.handler(test.source, test.request, test.controller.signal)).toEqual({
      admitted: true,
    });
    const [text, options] = test.state.handleSendChat.mock.calls[0]!;
    expect(text).toContain("slides.pptx");
    expect(text).toContain("Slide 1");
    expect(text).toContain("> Quarterly revenue");
    expect(text).toContain("Make this heading clearer.");
    expect(text).toContain("original document is referenced in the reply, not reattached");
    expect(text).not.toContain("/api/chat/media/outgoing/");
    expect(text).not.toContain("source-message");
    expect(text).not.toContain("owned-artifact");
    expect(text).not.toContain("Source:");
    expect(text).not.toContain("must not enter the prompt");
    expect(options).toMatchObject({
      literalMessage: true,
      ignoreReplyTarget: true,
      replyToId: "source-message",
    });
    const sent = submission(options);
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]).toMatchObject({
      fileName: "document-selection-slide-1.png",
      mimeType: "image/png",
    });
    expect(getChatAttachmentDataUrl(sent.attachments[0]!)).toBe(PNG);
    finish();
  });

  it.each([
    "source",
    "artifact",
    "message",
    "session",
    "transcript",
    "connection",
    "permission",
    "cancel",
  ])("refuses a stale %s without submitting", async (change) => {
    const test = fixture(async () => undefined);
    if (change === "source") {
      test.attachment.url = "/api/chat/media/outgoing/agent%3Aemployee%3Amain/replaced/full";
    }
    if (change === "artifact") {
      test.source.artifactId = "foreign-artifact";
    }
    if (change === "message") {
      test.state.chatMessages = [];
    }
    if (change === "session") {
      test.state.sessionKey = "agent:employee:other";
    }
    if (change === "transcript") {
      test.state.currentSessionId = "replacement-session";
    }
    if (change === "connection") {
      test.state.connectionEpoch++;
    }
    if (change === "permission") {
      test.deny();
    }
    if (change === "cancel") {
      test.controller.abort();
    }
    expect(await test.handler(test.source, test.request, test.controller.signal)).toMatchObject({
      admitted: false,
    });
    expect(test.state.handleSendChat).not.toHaveBeenCalled();
  });

  it.each([
    "missing coordinate",
    "oversized instruction",
    "oversized text",
    "wrong crop type",
    "oversized crop",
  ])("rejects %s before allocating an attachment", async (change) => {
    const test = fixture(async () => undefined);
    if (change === "missing coordinate") {
      Reflect.deleteProperty(test.request.region!, "width");
    }
    if (change === "oversized instruction") {
      test.request.instruction = "x".repeat(4097);
    }
    if (change === "oversized text") {
      test.request.selectedText = "x".repeat(1025);
    }
    if (change === "wrong crop type") {
      test.request.cropDataUrl = "data:image/jpeg;base64,aA==";
    }
    if (change === "oversized crop") {
      test.request.cropDataUrl = `data:image/png;base64,iVBORw0KGgo${"A".repeat(1_400_000)}`;
    }
    expect(await test.handler(test.source, test.request, test.controller.signal)).toMatchObject({
      admitted: false,
    });
    expect(test.state.handleSendChat).not.toHaveBeenCalled();
  });

  it("releases an unadmitted crop while retaining the viewer's retryable input", async () => {
    const test = fixture(async (_text, options) => {
      submission(options);
    });
    expect(await test.handler(test.source, test.request, test.controller.signal)).toMatchObject({
      admitted: false,
    });
    expect(getChatAttachmentDataUrl(payloads[0]!)).toBeNull();
    expect(test.request.cropDataUrl).toBe(PNG);
    expect(test.request.instruction).toBe("Make this heading clearer.");
  });

  it("rejects a global-alias Agent change even when the session spelling stays the same", async () => {
    const test = fixture(async () => undefined, "global");
    test.state.assistantAgentId = "other";
    expect(await test.handler(test.source, test.request, test.controller.signal)).toMatchObject({
      admitted: false,
    });
    expect(test.state.handleSendChat).not.toHaveBeenCalled();
  });
});
