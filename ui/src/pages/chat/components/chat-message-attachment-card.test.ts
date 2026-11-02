/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatDocumentChangeHandler } from "../document-change-contract.ts";
import { renderAssistantDocumentAttachment } from "./chat-message-attachment-card.ts";

vi.mock("../../../components/document-viewer.ts", () => ({}));
afterEach(() => document.body.replaceChildren());

describe("document attachment request owner", () => {
  it("binds the original message and locator rather than the temporary download grant", async () => {
    const callback = vi.fn<ChatDocumentChangeHandler>(async () => ({ admitted: true }));
    const source = "/api/chat/media/outgoing/agent%3Aemployee%3Amain/artifact/full";
    const message = { id: "owned-message", role: "assistant" };
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderAssistantDocumentAttachment({
        url: `${source}?mediaTicket=private-ticket`,
        attachment: {
          url: source,
          kind: "document",
          label: "slides.pptx",
          artifactId: "artifact",
          mimeType: "application/vnd.ms-powerpoint",
        },
        options: {
          sessionKey: "agent:employee:main",
          messageId: message.id,
          sourceMessage: message,
          onDocumentChangeRequest: callback,
        },
      }),
      container,
    );
    const card = container.querySelector("openclaw-chat-document-attachment");
    if (!card?.requestChanges) {
      throw new Error("Missing owned document request callback");
    }
    const request = { pageNumber: 2, selectedText: "Revenue", instruction: "Clarify this." };
    const signal = new AbortController().signal;
    await card.requestChanges(request, signal);
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      {
        sessionKey: "agent:employee:main",
        messageId: "owned-message",
        message,
        sourceIdentity: source,
        artifactId: "artifact",
        label: "slides.pptx",
        pageUnit: "slide",
      },
      request,
      signal,
    );
  });

  it("withholds requests when a row cannot identify its owning message", () => {
    const container = document.createElement("div");
    render(
      renderAssistantDocumentAttachment({
        url: "/api/chat/media/outgoing/agent%3Aemployee%3Amain/artifact/full",
        attachment: {
          url: "/api/chat/media/outgoing/agent%3Aemployee%3Amain/artifact/full",
          kind: "document",
          label: "report.pdf",
        },
        options: { onDocumentChangeRequest: vi.fn() },
      }),
      container,
    );
    const card = container.querySelector("openclaw-chat-document-attachment");
    expect(card).not.toBeNull();
    expect(card?.requestChanges).toBeUndefined();
  });
});
