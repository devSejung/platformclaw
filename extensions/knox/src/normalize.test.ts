import { describe, expect, it } from "vitest";
import { normalizeKnoxInbound } from "./normalize.js";

describe("normalizeKnoxInbound", () => {
  it("normalizes the v1 relay schema and preserves dotted Knox identity", () => {
    expect(
      normalizeKnoxInbound({
        schemaVersion: 1,
        eventId: "evt-1",
        messageId: "msg-1",
        occurredAt: "2026-07-31T00:00:00.000Z",
        sender: { knoxUserId: "user.name", displayName: "User Name" },
        conversation: {
          type: "dm",
          providerType: "SINGLE",
          conversationId: "42",
        },
        message: { type: "text", text: "hello" },
        agentId: "ignored-legacy-agent",
        sessionKey: "ignored-legacy-session",
      }),
    ).toMatchObject({
      sender: { knoxUserId: "user.name" },
      conversation: { type: "dm", conversationId: "42" },
      message: { text: "hello" },
    });
  });

  it("accepts the migration superset while deriving missing event metadata", () => {
    expect(
      normalizeKnoxInbound({
        messageId: "99",
        conversationId: "77",
        sentTime: 1_775_001_600_000,
        sender: { knoxUserId: "member.one", name: "Member" },
        chatType: "GROUP",
        text: "legacy text",
        clientInfo: { id: "knox-adapter" },
      }),
    ).toMatchObject({
      eventId: "77:99",
      sender: { knoxUserId: "member.one" },
      conversation: { type: "room", providerType: "GROUP", conversationId: "77" },
      message: { type: "text", text: "legacy text" },
    });
  });

  it("refuses routing without raw knoxUserId", () => {
    expect(() =>
      normalizeKnoxInbound({
        eventId: "evt",
        messageId: "msg",
        occurredAt: "2026-07-31T00:00:00.000Z",
        sender: { employeeId: "legacy" },
        conversation: { type: "dm", conversationId: "42" },
        message: { type: "text", text: "hello" },
      }),
    ).toThrow("missing required fields");
  });

  it("rejects unsupported or contradictory versioned envelopes", () => {
    const input = {
      schemaVersion: 2,
      eventId: "evt",
      messageId: "msg",
      occurredAt: "2026-07-31T00:00:00.000Z",
      sender: { knoxUserId: "user.name", displayName: "User" },
      conversation: { type: "dm", providerType: "SINGLE", conversationId: "42" },
      message: { type: "text", text: "hello" },
    };
    expect(() => normalizeKnoxInbound(input)).toThrow("schemaVersion");
    expect(() =>
      normalizeKnoxInbound({
        ...input,
        schemaVersion: 1,
        conversation: { ...input.conversation, providerType: "GROUP" },
      }),
    ).toThrow("type fields disagree");
    expect(() =>
      normalizeKnoxInbound({
        ...input,
        schemaVersion: 1,
        text: "must not be used",
        message: { type: "text", text: "" },
      }),
    ).toThrow("missing required fields");
  });

  it("preserves sender identity and message bytes without underscore or whitespace rewriting", () => {
    const result = normalizeKnoxInbound({
      schemaVersion: 1,
      eventId: "evt",
      messageId: "msg",
      occurredAt: "2026-07-31T00:00:00.000Z",
      sender: { knoxUserId: "user_name.with.dot", displayName: "User" },
      conversation: { type: "dm", providerType: "SINGLE", conversationId: "42" },
      message: { type: "text", text: "  keep this spacing  " },
    });

    expect(result.sender.knoxUserId).toBe("user_name.with.dot");
    expect(result.message.text).toBe("  keep this spacing  ");
  });

  it("rejects non-canonical version 1 timestamps", () => {
    expect(() =>
      normalizeKnoxInbound({
        schemaVersion: 1,
        eventId: "evt",
        messageId: "msg",
        occurredAt: "2026-02-30T00:00:00Z",
        sender: { knoxUserId: "user.name", displayName: "User" },
        conversation: { type: "dm", providerType: "SINGLE", conversationId: "42" },
        message: { type: "text", text: "hello" },
      }),
    ).toThrow("ISO 8601 UTC");
  });

  it.each(["2026-07-31T12:00:00.123456Z", "2026-07-31T12:00:00+00:00"])(
    "accepts contract-valid UTC timestamp %s",
    (occurredAt) => {
      expect(
        normalizeKnoxInbound({
          schemaVersion: 1,
          eventId: "evt",
          messageId: "msg",
          occurredAt,
          sender: { knoxUserId: "user.name", displayName: "User" },
          conversation: { type: "dm", providerType: "SINGLE", conversationId: "42" },
          message: { type: "text", text: "hello" },
        }).occurredAt,
      ).toBe(occurredAt);
    },
  );
});
