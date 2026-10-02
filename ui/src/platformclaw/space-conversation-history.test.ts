import { describe, expect, it, vi } from "vitest";
import type { ChatHistoryResult } from "../pages/chat/chat-history.ts";
import { SpaceConversationHistoryState } from "./space-conversation-history.ts";

const message = (id: number) => ({
  role: "user",
  content: [{ type: "text", text: `Message ${id}` }],
  __openclaw: { seq: id },
});
const tail = {
  messages: [message(3)],
  sessionId: "session-a",
  hasMore: true,
  nextOffset: 100,
  totalMessages: 201,
};

describe("Space read-only history paging", () => {
  it("preserves readable history and its cursor on failure, then merges overlapping projections", async () => {
    const state = new SpaceConversationHistoryState(vi.fn());
    const request = vi
      .fn<(params: Record<string, unknown>) => Promise<ChatHistoryResult>>()
      .mockResolvedValueOnce(tail)
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValueOnce({
        messages: [message(2), message(3)],
        sessionId: "session-a",
        hasMore: true,
        nextOffset: 200,
      })
      .mockResolvedValueOnce({
        messages: [message(1), message(2)],
        sessionId: "session-a",
        hasMore: false,
      });
    await state.load(request);
    await expect(state.load(request, true)).rejects.toThrow("Try again");
    expect(state.messages).toEqual(tail.messages);
    expect(state.pagination).toMatchObject({ hasMore: true, nextOffset: 100 });
    expect(state.loading).toBe(false);
    await state.load(request, true);
    expect(state.messages).toEqual([message(2), message(3)]);
    await state.load(request, true);
    expect(state.messages).toEqual([message(1), message(2), message(3)]);
    expect(request.mock.calls.map(([params]) => params)).toEqual([
      {},
      { offset: 100 },
      { offset: 100 },
      { offset: 200 },
    ]);
    await state.load(request, true);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not combine transcript identities after a session change", async () => {
    const state = new SpaceConversationHistoryState(vi.fn());
    const request = vi
      .fn<(params: Record<string, unknown>) => Promise<ChatHistoryResult>>()
      .mockResolvedValueOnce(tail)
      .mockResolvedValueOnce({ messages: [message(1)], sessionId: "session-b", hasMore: false })
      .mockResolvedValueOnce({ messages: [message(8)], sessionId: "session-b", hasMore: false });
    await state.load(request);
    await state.load(request, true);
    expect(request.mock.calls.map(([params]) => params)).toEqual([{}, { offset: 100 }, {}]);
    expect(state.messages).toEqual([message(8)]);
    expect(state.pagination.hasMore).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("reports failure after a changed-session tail reload and allows a fresh retry", async () => {
    const state = new SpaceConversationHistoryState(vi.fn());
    const request = vi
      .fn<(params: Record<string, unknown>) => Promise<ChatHistoryResult>>()
      .mockResolvedValueOnce(tail)
      .mockResolvedValueOnce({ messages: [message(1)], sessionId: "session-b", hasMore: false })
      .mockRejectedValueOnce(new Error("Tail unavailable"))
      .mockResolvedValueOnce({ messages: [message(8)], sessionId: "session-b", hasMore: false });
    await state.load(request);
    await expect(state.load(request, true)).rejects.toThrow("Tail unavailable");
    expect(state.messages).toEqual([]);
    expect(state.loading).toBe(false);
    await state.load(request);
    expect(state.messages).toEqual([message(8)]);
  });

  it("ignores repeated older requests and invalidated in-flight results", async () => {
    const state = new SpaceConversationHistoryState(vi.fn());
    let release!: (value: ChatHistoryResult) => void;
    const request = vi
      .fn<(params: Record<string, unknown>) => Promise<ChatHistoryResult>>()
      .mockResolvedValueOnce(tail)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    await state.load(request);
    const pending = state.load(request, true);
    await state.load(request, true);
    expect(request).toHaveBeenCalledTimes(2);
    state.clear();
    release({ messages: [message(1)], sessionId: "session-a", hasMore: false });
    await pending;
    expect(state.messages).toEqual([]);
    expect(state.pagination.hasMore).toBe(false);
    expect(state.loading).toBe(false);
  });

  it("stops on a non-advancing offset instead of repeatedly requesting the same page", async () => {
    const state = new SpaceConversationHistoryState(vi.fn());
    const request = vi
      .fn<(params: Record<string, unknown>) => Promise<ChatHistoryResult>>()
      .mockResolvedValueOnce(tail)
      .mockResolvedValueOnce({ ...tail, messages: [message(2)], nextOffset: 100 });
    await state.load(request);
    await state.load(request, true);
    await state.load(request, true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.messages).toEqual([message(2), message(3)]);
    expect(state.pagination.hasMore).toBe(false);
  });
});
