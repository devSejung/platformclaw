import { describe, expect, it } from "vitest";
import {
  createSessionProjection,
  projectLiveSessionMessage,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionScope,
} from "./session-projection.js";

const primaryScope: SessionProjectionScope = {
  sessionKey: "agent:main:shared",
  sessionId: "session-1",
  agentId: "main",
  lifecycleRevision: 1,
  activeLeafEntryId: "leaf-1",
};

function createMessage(
  role: "user" | "assistant",
  text: string,
  metadata?: Record<string, unknown>,
) {
  return {
    role,
    content: [{ type: "text", text }],
    ...(metadata ? { __openclaw: metadata } : {}),
  };
}

describe("session projection attachment handoff", () => {
  it("carries pending user attachments until the authoritative media fact arrives", () => {
    const attachment = {
      type: "attachment",
      attachment: {
        url: "data:application/pdf;base64,JVBERg==",
        kind: "document",
        label: "report.pdf",
      },
    };
    const pending = {
      role: "user",
      content: [{ type: "text", text: "Review this" }, attachment],
      __openclaw: { idempotencyKey: "attachment-run:user" },
    };
    let state = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "sendPending",
      runId: "attachment-run",
      message: pending,
    });
    const early = {
      role: "user",
      content: [{ type: "text", text: "Review this" }],
      __openclaw: {
        id: "attachment-user",
        idempotencyKey: "attachment-run:user",
        seq: 4,
      },
    };

    state = reconcileSessionProjectionSnapshot(state, [early], primaryScope);
    expect(state.messages).toEqual([{ ...early, content: [...early.content, attachment] }]);
    expect(state.entries[0]).toMatchObject({ pending: true, pendingRunId: "attachment-run" });

    state = reconcileSessionProjectionSnapshot(state, [early], primaryScope);
    expect(state.messages).toEqual([{ ...early, content: [...early.content, attachment] }]);

    const committed = {
      ...early,
      __openclaw: {
        ...early["__openclaw"],
        media: [{ url: "media://inbound/report.pdf", contentType: "application/pdf" }],
      },
    };
    state = reconcileSessionProjectionSnapshot(state, [committed], primaryScope);
    expect(state.messages).toEqual([committed]);
    expect(state.entries[0]?.pending).toBe(false);
  });

  it("carries a pending user attachment through an early fact-free live event", () => {
    const attachment = {
      type: "attachment",
      attachment: { url: "data:application/pdf;base64,JVBERg==", label: "report.pdf" },
    };
    const pending = {
      role: "user",
      content: [attachment],
      __openclaw: { idempotencyKey: "live-attachment-run:user" },
    };
    const earlyLive = {
      role: "user",
      content: [{ type: "text", text: "Review this" }],
      __openclaw: {
        id: "live-attachment-user",
        idempotencyKey: "live-attachment-run:user",
        seq: 4,
      },
    };
    const pendingState = reduceSessionProjection(createSessionProjection(primaryScope), {
      type: "sendPending",
      runId: "live-attachment-run",
      message: pending,
    });

    const state = projectLiveSessionMessage(pendingState, earlyLive);

    expect(state.messages).toEqual([{ ...earlyLive, content: [...earlyLive.content, attachment] }]);
    expect(state.entries[0]).toMatchObject({
      live: true,
      pending: true,
      pendingRunId: "live-attachment-run",
    });
  });

  it("never carries structured content across assistant or session boundaries", () => {
    const pending = {
      role: "assistant",
      content: [
        { type: "text", text: "Generated" },
        { type: "attachment", attachment: { url: "/generated.html" } },
      ],
      __openclaw: { idempotencyKey: "assistant-run" },
    };
    const assistant = createMessage("assistant", "Generated", {
      id: "assistant-message",
      idempotencyKey: "assistant-run",
      seq: 2,
    });
    const state = createSessionProjection(primaryScope, [pending]);

    expect(reconcileSessionProjectionSnapshot(state, [assistant], primaryScope).messages).toEqual([
      assistant,
    ]);
    expect(
      reconcileSessionProjectionSnapshot(state, [], {
        sessionKey: "agent:main:other-session",
      }).messages,
    ).toEqual([]);
  });
});
