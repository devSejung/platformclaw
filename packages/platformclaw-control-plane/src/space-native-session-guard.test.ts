import { describe, expect, it } from "vitest";
import { SpaceNativeSessionGuard } from "./space-native-session-guard.js";
import { createSpaceTestFixture } from "./spaces.test-fixture.js";

async function fixture() {
  const f = await createSpaceTestFixture();
  f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
  const conversation = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
    pageId: f.page.id,
    title: "Alice investigation",
    requestId: "native-guard",
  });
  const privateKey = `agent:${f.alice.binding.agentId}:private`;
  const nativeId = "1b0113dc-f0b5-43a7-98c9-6b7c550bfa17";
  f.request.mockImplementation(async (method, raw) => {
    const params = raw as Record<string, unknown>;
    if (method === "sessions.resolve") {
      if (params.label === "Ambiguous") {
        throw new Error("Multiple sessions found");
      }
      if (
        params.key === "saved-alias" ||
        params.label === conversation.title ||
        params.sessionId === nativeId
      ) {
        return { ok: true, key: conversation.sessionKey };
      }
      if (params.key === conversation.sessionKey || params.key === privateKey) {
        return { ok: true, key: params.key };
      }
      return { ok: false };
    }
    if (method === "chat.history") {
      return {
        messages: [
          {
            role: "assistant",
            content: "Shared final answer",
            __openclaw: { id: "answer" },
          },
          { role: "toolResult", content: "Private raw output", __openclaw: { id: "tool" } },
        ],
      };
    }
    return { results: [] };
  });
  const guard = new SpaceNativeSessionGuard(f.store.spaces, { request: f.request });
  const caller = {
    agentId: f.alice.binding.agentId,
    sessionKey: privateKey,
    nativeTool: "sessions_history",
    broad: true,
  };
  return { ...f, guard, conversation, privateKey, nativeId, caller };
}

describe("native session tools at the Space registry boundary", () => {
  it("rejects peer raw history through exact keys, aliases, ids and labels while allowing Q&A recall", async () => {
    const f = await fixture();
    for (const selector of [
      { targetSessionKey: f.conversation.sessionKey },
      { targetSessionKey: "saved-alias" },
      { targetSessionKey: f.nativeId },
      { targetLabel: f.conversation.title, targetAgentId: f.alice.binding.agentId },
    ]) {
      await expect(
        f.guard.authorize({ ...f.caller, agentId: f.bob.binding.agentId, ...selector }),
      ).rejects.toThrow("unavailable");
    }
    expect(f.request.mock.calls.every(([method]) => method === "sessions.resolve")).toBe(true);
    const recalled = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
      conversationId: f.conversation.id,
    });
    expect(JSON.stringify(recalled)).toContain("Shared final answer");
    expect(JSON.stringify(recalled)).not.toContain("Private raw output");
  });

  it("canonicalizes authorized aliases and leaves unrelated native targets available", async () => {
    const f = await fixture();
    await expect(
      f.guard.authorize({
        ...f.caller,
        sessionKey: f.conversation.sessionKey,
        targetSessionKey: f.nativeId,
      }),
    ).resolves.toEqual({ sessionKey: f.conversation.sessionKey });
    await expect(f.guard.authorize({ ...f.caller, targetSessionKey: "current" })).resolves.toEqual({
      sessionKey: f.privateKey,
    });
    await expect(
      f.guard.authorize({ ...f.caller, targetSessionKey: "openclaw-control-ui" }),
    ).resolves.toEqual({ sessionKey: f.privateKey });
    const newKey = `agent:${f.alice.binding.agentId}:new-private-task`;
    await expect(
      f.guard.authorize({ ...f.caller, nativeTool: "sessions_send", targetSessionKey: newKey }),
    ).resolves.toEqual({ sessionKey: newKey });
    await expect(
      f.guard.authorize({
        ...f.caller,
        agentId: "generic-helper",
        targetSessionKey: f.privateKey,
      }),
    ).resolves.toEqual({ sessionKey: f.privateKey });
    await expect(
      f.guard.authorize({
        ...f.caller,
        agentId: "generic-helper",
        targetSessionKey: f.conversation.sessionKey,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("rejects ambiguous, missing and unregistered reserved references", async () => {
    const f = await fixture();
    for (const selector of [
      { targetLabel: "Ambiguous" },
      { targetSessionKey: "missing-session" },
      { targetSessionKey: `agent:${f.alice.binding.agentId}:space-session:unregistered` },
    ]) {
      await expect(f.guard.authorize({ ...f.caller, ...selector })).rejects.toThrow("target");
    }
  });

  it("blocks widened queries and revoked default-tree children without disabling normal own trees", async () => {
    const f = await fixture();
    for (const nativeTool of ["sessions_list", "sessions_search"]) {
      await expect(f.guard.authorize({ ...f.caller, nativeTool })).rejects.toThrow(
        "broad native query",
      );
      await expect(f.guard.authorize({ ...f.caller, nativeTool, broad: false })).resolves.toEqual(
        {},
      );
      await expect(
        f.guard.authorize({ ...f.caller, nativeTool, agentId: f.bob.binding.agentId }),
      ).rejects.toThrow("broad native query");
      await expect(
        f.guard.authorize({
          ...f.caller,
          nativeTool,
          agentId: f.bob.binding.agentId,
          targetAgentId: f.bob.binding.agentId,
        }),
      ).rejects.toThrow("broad native query");
      await expect(
        f.guard.authorize({
          ...f.caller,
          nativeTool,
          agentId: f.bob.binding.agentId,
          broad: false,
        }),
      ).resolves.toEqual({});
    }
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    await expect(
      f.guard.authorize({ ...f.caller, nativeTool: "sessions_list", broad: false }),
    ).rejects.toThrow("broad native query");
    await expect(
      f.guard.authorize({ ...f.caller, targetSessionKey: f.conversation.sessionKey }),
    ).rejects.toThrow("unavailable");
  });

  it("requires current editor authority for mutations and retains registered history", async () => {
    const f = await fixture();
    const request = {
      ...f.caller,
      sessionKey: f.conversation.sessionKey,
      targetSessionKey: f.conversation.sessionKey,
    };
    await expect(
      f.guard.authorize({ ...f.caller, targetSessionKey: f.conversation.sessionKey }),
    ).rejects.toThrow("cross-session native tools");
    for (const nativeAction of ["reset", "delete"]) {
      await expect(
        f.guard.authorize({ ...request, nativeTool: "sessions", nativeAction }),
      ).rejects.toThrow("retained");
    }
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    await expect(f.guard.authorize(request)).rejects.toThrow("read-only");
    for (const nativeTool of ["sessions_send", "sessions", "session_status"]) {
      await expect(
        f.guard.authorize({ ...request, nativeTool, nativeAction: "patch" }),
      ).rejects.toThrow("read-only");
    }
    await expect(
      f.guard.authorize({
        ...f.caller,
        sessionKey: f.conversation.sessionKey,
        targetSessionKey: f.privateKey,
      }),
    ).rejects.toThrow("read-only");
  });

  it("blocks spawning another employee's personal runtime but keeps own and generic helpers", async () => {
    const f = await fixture();
    for (const targetAgentId of [f.bob.binding.agentId, f.bob.binding.agentId.toUpperCase()]) {
      await expect(
        f.guard.authorize({ ...f.caller, nativeTool: "sessions_spawn", targetAgentId }),
      ).rejects.toThrow("another employee");
    }
    for (const targetAgentId of [
      undefined,
      f.alice.binding.agentId,
      f.alice.binding.agentId.toUpperCase(),
      "generic-helper",
    ]) {
      await expect(
        f.guard.authorize({ ...f.caller, nativeTool: "sessions_spawn", targetAgentId }),
      ).resolves.toEqual({});
    }
  });

  it("revalidates actor and membership after an asynchronous resolution", async () => {
    const f = await fixture();
    f.request.mockImplementationOnce(async () => {
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
      return { ok: true, key: f.conversation.sessionKey };
    });
    await expect(
      f.guard.authorize({
        ...f.caller,
        sessionKey: f.conversation.sessionKey,
        targetSessionKey: f.conversation.sessionKey,
      }),
    ).rejects.toThrow("unavailable");
  });
});
