import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.js";

const uiAction = {
  version: 1,
  kind: "settings",
  feature: "sample.settings",
  requestId: "971a463c-d606-4cb6-b7fb-36477b749ce9",
  targetKey: "SYNTHETIC_KEY",
};

describe("bounded tool-result settings action projection", () => {
  it("preserves the exact routing fields in top-level and nested tool results", () => {
    const messages = sanitizeChatHistoryMessages([
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "sample_settings",
        content: [],
        details: { uiAction, privateValue: "discard", changed: true },
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolResult",
            toolCallId: "call-2",
            details: { uiAction, privateValue: "discard" },
          },
        ],
      },
    ]);
    expect(messages).toMatchObject([
      { details: { uiAction, changed: true } },
      { content: [{ details: { uiAction } }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain("discard");
    expect(JSON.stringify(messages)).not.toContain("privateValue");
  });

  it.each([
    { ...uiAction, value: "never-project" },
    { ...uiAction, url: "/settings" },
    { ...uiAction, version: 2 },
    { ...uiAction, kind: "navigate" },
    { ...uiAction, feature: "f".repeat(97) },
    { ...uiAction, requestId: "not-a-uuid" },
    { ...uiAction, targetKey: "https://example.invalid/key" },
    { ...uiAction, targetKey: "k".repeat(129) },
    [uiAction],
    null,
  ])("drops malformed or expanded action payloads: %j", (invalid) => {
    const [projected] = sanitizeChatHistoryMessages([
      { role: "toolResult", toolCallId: "call-1", content: [], details: { uiAction: invalid } },
    ]);
    expect(projected).not.toHaveProperty("details");
  });

  it("does not retain settings metadata on ordinary assistant messages", () => {
    const [projected] = sanitizeChatHistoryMessages([
      { role: "assistant", content: [{ type: "text", text: "Ready" }], details: { uiAction } },
    ]);
    expect(projected).not.toHaveProperty("details");
  });
});
