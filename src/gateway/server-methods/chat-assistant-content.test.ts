import { describe, expect, it } from "vitest";
import {
  hasAssistantDisplayMediaContent,
  replaceAssistantContentTextBlocks,
} from "./chat-assistant-content.js";

describe("attachment failure display", () => {
  it("keeps an actionable download failure when transcript text is restored", () => {
    const failure = {
      type: "text",
      attachmentError: true,
      text: "[Attachment unavailable] Attach it again.",
    };
    const result = replaceAssistantContentTextBlocks([failure], {
      content: [{ type: "text", text: "Document reply" }],
    });
    expect(result).toContainEqual(failure);
    expect(hasAssistantDisplayMediaContent(result)).toBe(true);
  });
});
