import { describe, expect, it } from "vitest";
import { buildAssistantAttachmentMetaUrl } from "./chat-message-attachment-availability.ts";
import { buildAssistantAttachmentUrl } from "./chat-message-local-media.ts";

describe("assistant attachment URLs", () => {
  it("binds mounted PlatformClaw media requests to the active session", () => {
    const source = "media://inbound/upload-1";
    const sessionKey = "agent:employee-one:main";

    expect(buildAssistantAttachmentMetaUrl(source, "/platformclaw/app", sessionKey)).toBe(
      "/platformclaw/app/__openclaw__/assistant-media?source=media%3A%2F%2Finbound%2Fupload-1&sessionKey=agent%3Aemployee-one%3Amain&meta=1",
    );
    expect(buildAssistantAttachmentUrl(source, "/platformclaw/app", "ticket-1", sessionKey)).toBe(
      "/platformclaw/app/__openclaw__/assistant-media?source=media%3A%2F%2Finbound%2Fupload-1&mediaTicket=ticket-1&sessionKey=agent%3Aemployee-one%3Amain",
    );
  });

  it("leaves remote attachment URLs unchanged", () => {
    expect(
      buildAssistantAttachmentUrl(
        "https://files.example/report.pdf",
        "/platformclaw/app",
        "ignored-ticket",
        "agent:employee-one:main",
      ),
    ).toBe("https://files.example/report.pdf");
  });
});
