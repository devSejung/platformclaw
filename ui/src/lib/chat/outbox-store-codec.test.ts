import { describe, expect, it } from "vitest";
import { normalizeStoredQueueItem } from "./outbox-store-codec.ts";

describe("contextual outbox targets", () => {
  const item = {
    id: "item",
    text: "Continue.",
    createdAt: 1,
    sendRunId: "run",
    sessionKey: "agent:main:main",
    agentId: "main",
  };

  it.each([null, "source-leaf"])(
    "preserves the exact target with leaf %s",
    (expectedLeafEntryId) => {
      const sendTarget = {
        sessionId: "source-session",
        expectedLeafEntryId,
        requireExactLeaf: true,
      };
      expect(normalizeStoredQueueItem({ ...item, sendTarget })?.sendTarget).toEqual(sendTarget);
    },
  );

  it.each([
    null,
    {},
    { sessionId: "source-session", requireExactLeaf: true },
    { sessionId: "source-session", expectedLeafEntryId: "source-leaf", requireExactLeaf: false },
  ])("never restores a malformed target as an unrestricted send: %j", (sendTarget) => {
    expect(normalizeStoredQueueItem({ ...item, sendTarget })).toBeNull();
  });

  it("accepts the canonical session owner after storage removes a redundant agent field", () => {
    const sendTarget = {
      sessionId: "source-session",
      expectedLeafEntryId: "source-leaf",
      requireExactLeaf: true,
    };
    expect(
      normalizeStoredQueueItem({ ...item, agentId: undefined, sendTarget })?.sendTarget,
    ).toEqual(sendTarget);
    expect(
      normalizeStoredQueueItem({ ...item, sessionKey: "global", agentId: undefined, sendTarget }),
    ).toBeNull();
  });
});
