import { describe, expect, it } from "vitest";
import { markInboundContextLabel } from "../auto-reply/reply/inbound-context-marker.js";
import type { SessionEntry } from "../config/sessions.js";
import { deriveSessionTitle } from "./session-utils-core.js";

const senderMetadata = `${markInboundContextLabel("Sender:")}
\`\`\`json
{"label":"gateway-client","id":"gateway-client"}
\`\`\``;
const entry: SessionEntry = {
  sessionId: "abcd1234-rest-of-session",
  updatedAt: Date.parse("2026-09-02T00:00:00Z"),
};

describe("session titles without a session id fallback", () => {
  const cases: Array<{
    name: string;
    fields?: Partial<SessionEntry>;
    firstUserMessage?: string;
    externalDisplayName?: string;
    expected?: string;
  }> = [
    { name: "keeps an empty unnamed thread untitled" },
    { name: "keeps whitespace-only content untitled", firstUserMessage: "  \n  " },
    { name: "keeps metadata-only content untitled", firstUserMessage: senderMetadata },
    {
      name: "uses normalized user content",
      firstUserMessage: `${senderMetadata}\n\nPlan the quarterly release`,
      expected: "Plan the quarterly release",
    },
    {
      name: "prefers an explicit label",
      fields: { label: "Saved label", displayName: "Generated name" },
      firstUserMessage: "First message",
      expected: "Saved label",
    },
    {
      name: "keeps a generated display name for an empty transcript",
      fields: { displayName: "Generated name" },
      expected: "Generated name",
    },
    {
      name: "keeps a computed Gateway display name",
      externalDisplayName: "Group display name",
      firstUserMessage: senderMetadata,
      expected: "Group display name",
    },
    {
      name: "keeps an explicit subject",
      fields: { subject: "Group subject" },
      expected: "Group subject",
    },
  ];

  it.each(cases)("$name", ({ fields, firstUserMessage, externalDisplayName, expected }) => {
    expect(
      deriveSessionTitle({ ...entry, ...fields }, firstUserMessage, externalDisplayName, {
        includeSessionIdFallback: false,
      }),
    ).toBe(expected);
  });

  it.each([undefined, senderMetadata])(
    "preserves the default session id fallback for content %s",
    (firstUserMessage) => {
      expect(deriveSessionTitle(entry, firstUserMessage)).toBe("abcd1234 (2026-09-02)");
    },
  );
});
