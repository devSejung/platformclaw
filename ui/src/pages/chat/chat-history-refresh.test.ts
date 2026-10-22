// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createChatHistoryTestState as createState } from "./chat-history.test-support.ts";
import {
  loadChatHistory,
  needsChatHistoryRefresh,
  type ChatHistoryResult,
} from "./chat-history.ts";

describe("chat history refresh ownership", () => {
  it.each([
    { outcome: "resolve", afterFresh: false },
    { outcome: "reject", afterFresh: false },
    { outcome: "resolve", afterFresh: true },
    { outcome: "reject", afterFresh: true },
  ] as const)(
    "supersedes a pre-mutation read whose stale completion is $outcome (after fresh: $afterFresh)",
    async ({ outcome, afterFresh }) => {
      let resolveOld!: (result: ChatHistoryResult) => void;
      let rejectOld!: (error: Error) => void;
      let resolveFresh!: (result: ChatHistoryResult) => void;
      const oldResponse = new Promise<ChatHistoryResult>((resolve, reject) => {
        resolveOld = resolve;
        rejectOld = reject;
      });
      const freshResponse = new Promise<ChatHistoryResult>((resolve) => {
        resolveFresh = resolve;
      });
      const state = createState({ messages: [] });
      state.chatDisplayedLeafEntryId = "displayed-leaf";
      const request = vi.spyOn(state.client!, "request");
      request.mockReturnValueOnce(oldResponse).mockReturnValueOnce(freshResponse);
      const oldLoad = loadChatHistory(state, { deferBranches: true });
      const freshLoad = loadChatHistory(state, { deferBranches: true, refresh: true });
      expect(request).toHaveBeenCalledTimes(2);
      const freshResult: ChatHistoryResult = {
        messages: [{ role: "user", content: "persisted interrupted request" }],
        sessionInfo: { key: "main", kind: "direct", updatedAt: 2, activeLeafEntryId: "fresh-leaf" },
      };
      if (afterFresh) {
        resolveFresh(freshResult);
        await freshLoad;
      }

      if (outcome === "resolve") {
        resolveOld({
          messages: [{ role: "assistant", content: "stale snapshot" }],
          sessionInfo: {
            key: "main",
            kind: "direct",
            updatedAt: 1,
            activeLeafEntryId: "stale-leaf",
          },
        });
      } else {
        rejectOld(new Error("stale read failed"));
      }
      expect(await oldLoad).toBeUndefined();
      if (afterFresh) {
        expect(state.chatDisplayedLeafEntryId).toBe("fresh-leaf");
        expect(state.chatMessages).toEqual(freshResult.messages);
        expect(needsChatHistoryRefresh(state)).toBe(false);
        expect(state.lastError).toBeNull();
        return;
      }
      expect(state.chatMessages).toEqual([]);
      expect(state.chatDisplayedLeafEntryId).toBe("displayed-leaf");
      expect(state.chatLoading).toBe(true);
      expect(needsChatHistoryRefresh(state)).toBe(true);
      expect(state.lastError).toBeNull();
      const followUpRead = loadChatHistory(state, { deferBranches: true });
      expect(request).toHaveBeenCalledTimes(2);

      resolveFresh(freshResult);
      await Promise.all([freshLoad, followUpRead]);
      expect(state.chatDisplayedLeafEntryId).toBe("fresh-leaf");
      expect(state.chatLoading).toBe(false);
      expect(needsChatHistoryRefresh(state)).toBe(false);
    },
  );

  it("does not join pre-mutation shared history owned by another pane", async () => {
    let resolveOld!: (result: ChatHistoryResult) => void;
    let resolveFresh!: (result: ChatHistoryResult) => void;
    const oldResponse = new Promise<ChatHistoryResult>((resolve) => {
      resolveOld = resolve;
    });
    const freshResponse = new Promise<ChatHistoryResult>((resolve) => {
      resolveFresh = resolve;
    });
    const peer = createState({ messages: [] });
    const state = createState({ messages: [] });
    state.client = peer.client;
    state.chatDisplayedLeafEntryId = "displayed-leaf";
    const request = vi.spyOn(peer.client!, "request");
    request.mockReturnValueOnce(oldResponse).mockReturnValueOnce(freshResponse);
    const peerLoad = loadChatHistory(peer, { deferBranches: true });
    const freshLoad = loadChatHistory(state, { deferBranches: true, refresh: true });
    expect(request).toHaveBeenCalledTimes(2);

    resolveOld({ messages: [] });
    await peerLoad;
    expect(state.chatDisplayedLeafEntryId).toBe("displayed-leaf");
    expect(needsChatHistoryRefresh(state)).toBe(true);
    resolveFresh({
      messages: [],
      sessionInfo: { key: "main", kind: "direct", updatedAt: 2, activeLeafEntryId: "fresh-leaf" },
    });
    await freshLoad;
    expect(state.chatDisplayedLeafEntryId).toBe("fresh-leaf");
    expect(needsChatHistoryRefresh(state)).toBe(false);
  });
});
