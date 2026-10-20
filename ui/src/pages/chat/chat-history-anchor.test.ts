// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatHistoryTestState as createState } from "./chat-history.test-support.ts";
import { loadChatHistoryAnchor, type ChatHistoryResult } from "./chat-history.ts";

describe("search-anchored chat history", () => {
  const hit = {
    role: "assistant",
    content: [{ type: "text", text: "배포실패 원인" }],
    __openclaw: { id: "message-old" },
  };

  it("loads a bounded message neighborhood without changing the composer or active run", async () => {
    const state = createState({
      messages: [hit],
      sessionId: "s",
      offset: 100,
      hasMore: true,
      nextOffset: 200,
    });
    state.currentSessionId = "s";
    state.chatMessage = "unsent draft";
    state.chatRunId = "running";
    state.chatStream = "still streaming";
    await expect(
      loadChatHistoryAnchor(state, { sessionId: "s", messageId: "message-old" }),
    ).resolves.toBe(true);
    expect(vi.mocked(state.client!).request.mock.calls[0]).toEqual([
      "chat.history",
      {
        sessionKey: "main",
        sessionId: "s",
        messageId: "message-old",
        limit: 100,
      },
    ]);
    expect(state.chatMessages).toContainEqual(hit);
    expect(state.chatMessage).toBe("unsent draft");
    expect(state.chatRunId).toBe("running");
    expect(state.chatStream).toBe("still streaming");
    expect(state.chatHistoryPagination).toMatchObject({ hasMore: true, nextOffset: 200 });
  });

  it("rejects a late anchor after switching sessions", async () => {
    let resolve!: (value: ChatHistoryResult) => void;
    const state = createState({});
    const request = vi.fn(
      () =>
        new Promise<ChatHistoryResult>((done) => {
          resolve = done;
        }),
    );
    state.client = { request } as unknown as GatewayBrowserClient;
    const pending = loadChatHistoryAnchor(state, { sessionId: "s", messageId: "message-old" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    state.sessionKey = "other";
    resolve({ messages: [hit] });
    await expect(pending).resolves.toBe(false);
    expect(state.chatMessages).toEqual([]);
  });

  it("keeps the current transcript when a result has disappeared", async () => {
    const state = createState({ messages: [] });
    const previous = [{ role: "user", content: "current conversation" }];
    state.chatMessages = previous;
    await expect(
      loadChatHistoryAnchor(state, { sessionId: "s", messageId: "deleted" }),
    ).resolves.toBe(false);
    expect(state.chatMessages).toBe(previous);
  });
});

describe("search anchor ownership", () => {
  it.each(["closed", "changed query", "selected an already-loaded hit"])(
    "does not apply after search %s",
    async () => {
      let resolve!: (value: ChatHistoryResult) => void;
      let current = true;
      const state = createState({});
      const before = [{ role: "user", content: "keep this view" }];
      state.chatMessages = before;
      const request = vi.fn(
        () =>
          new Promise<ChatHistoryResult>((done) => {
            resolve = done;
          }),
      );
      state.client = { request } as unknown as GatewayBrowserClient;
      const target = { sessionKey: "main", sessionId: "s", messageId: "old", query: "로그인" };
      const pending = loadChatHistoryAnchor(state, target, () => current);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(request.mock.calls[0]).toEqual([
        "chat.history",
        { sessionKey: "main", sessionId: "s", messageId: "old", limit: 100 },
      ]);
      current = false;
      resolve({
        messages: [{ role: "assistant", content: "로그인오류", __openclaw: { id: "old" } }],
      });
      await expect(pending).resolves.toBe(false);
      expect(state.chatMessages).toBe(before);
    },
  );
});
