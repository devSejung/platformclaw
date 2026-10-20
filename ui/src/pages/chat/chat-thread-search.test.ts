import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ChatThreadSearch } from "./chat-thread-search.ts";

const hit = (id: number) => ({
  sessionKey: "agent:main:thread",
  sessionId: "transcript",
  messageId: `message-${id}`,
  role: "assistant",
  timestamp: id,
  snippet: "배포 설정",
  score: 0,
});
const result = (offset = 0) => ({
  results: Array.from({ length: Math.min(25, 27 - offset) }, (_, index) => hit(offset + index)),
  totalCount: 27,
  hasMore: offset === 0,
});

function setup(request = vi.fn().mockResolvedValue(result())) {
  const search = new ChatThreadSearch();
  const onResult = vi.fn();
  const onInvalidate = vi.fn();
  const requestUpdate = vi.fn();
  const client = { request } as unknown as GatewayBrowserClient;
  search.bind({
    client,
    sessionKey: "agent:main:thread",
    sessionId: "transcript",
    onResult,
    onInvalidate,
    requestUpdate,
  });
  search.show(requestUpdate);
  return { search, request, onResult, onInvalidate, requestUpdate, client };
}

describe("current transcript find", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("invalidates pending navigation immediately on each edit and close", async () => {
    vi.useFakeTimers();
    const { search, request, onInvalidate } = setup();
    search.change("old query");
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    search.change("new query");
    expect(onInvalidate).toHaveBeenCalledTimes(2);
    search.close(false);
    expect(onInvalidate).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(180);
    expect(request).not.toHaveBeenCalled();
  });

  it("does not cancel global navigation when a closed find learns the transcript identity", () => {
    const search = new ChatThreadSearch();
    const onInvalidate = vi.fn();
    const binding = {
      sessionKey: "agent:main:thread",
      onInvalidate,
      requestUpdate: vi.fn(),
    };
    search.bind(binding);
    search.bind({ ...binding, sessionId: "global-search-transcript" });
    expect(onInvalidate).not.toHaveBeenCalled();
    search.show(binding.requestUpdate);
    search.close(false);
    expect(onInvalidate).toHaveBeenCalledOnce();
    search.close(false);
    expect(onInvalidate).toHaveBeenCalledOnce();
  });

  it("searches the selected nondefault global owner and cancels replies after owner switches", async () => {
    vi.useFakeTimers();
    const search = new ChatThreadSearch();
    let finish!: (response: ReturnType<typeof result>) => void;
    const request = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onResult = vi.fn();
    const onInvalidate = vi.fn();
    const binding = {
      agentId: "research",
      sessionKey: "global",
      sessionId: "shared-transcript-id",
      client: { request } as unknown as GatewayBrowserClient,
      onResult,
      onInvalidate,
      requestUpdate: vi.fn(),
    };
    search.bind(binding);
    search.show(binding.requestUpdate);
    search.change("배포");
    await vi.advanceTimersByTimeAsync(180);
    expect(request).toHaveBeenCalledWith("sessions.search", {
      agentId: "research",
      sessionKeys: ["global"],
      sessionId: "shared-transcript-id",
      query: "배포",
      mode: "substring",
      offset: 0,
      limit: 25,
    });
    search.bind({ ...binding, agentId: "other-owner" });
    finish({
      ...result(),
      results: [{ ...hit(0), sessionKey: "global", sessionId: "shared-transcript-id" }],
    });
    await Promise.resolve();
    expect(search.open).toBe(false);
    expect(search.total).toBe(0);
    expect(onResult).not.toHaveBeenCalled();
    expect(onInvalidate).toHaveBeenCalledTimes(2);
  });

  it("opens, focuses and selects again without toggling or changing the draft", async () => {
    const draft = document.createElement("textarea");
    const input = document.createElement("input");
    draft.value = "unsent draft";
    document.body.append(draft, input);
    draft.focus();
    const { search, requestUpdate } = setup();
    search.setInput(input);
    await Promise.resolve();
    expect(document.activeElement).toBe(input);
    input.value = "배포";
    search.show(requestUpdate);
    expect(search.open).toBe(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
    search.close();
    expect(document.activeElement).toBe(draft);
    expect(draft.value).toBe("unsent draft");
  });

  it("searches the whole current transcript, pages and wraps message matches", async () => {
    vi.useFakeTimers();
    const { search, request, onResult } = setup(
      vi.fn().mockImplementation((_method, params) => Promise.resolve(result(params.offset))),
    );
    search.change("배포");
    await vi.advanceTimersByTimeAsync(180);
    expect(request).toHaveBeenCalledWith("sessions.search", {
      query: "배포",
      sessionKeys: ["agent:main:thread"],
      sessionId: "transcript",
      mode: "substring",
      offset: 0,
      limit: 25,
    });
    expect(search.total).toBe(27);
    expect(search.partial).toBe(false);
    expect(onResult).toHaveBeenLastCalledWith({ ...hit(0), query: "배포" });
    search.move(-1);
    await Promise.resolve();
    await Promise.resolve();
    expect(search.index).toBe(26);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.search",
      expect.objectContaining({ offset: 25 }),
    );
    expect(onResult).toHaveBeenLastCalledWith({ ...hit(26), query: "배포" });
    search.move(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(search.index).toBe(0);
    search.close(false);
  });

  it("discards late replies after typing, closing and switching transcripts", async () => {
    vi.useFakeTimers();
    let finish!: (response: ReturnType<typeof result>) => void;
    const { search, requestUpdate, client, onResult } = setup(
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    search.change("old");
    await vi.advanceTimersByTimeAsync(180);
    search.change("new");
    search.bind({ client, sessionKey: "agent:main:other", requestUpdate, onResult });
    finish(result());
    await Promise.resolve();
    expect(onResult).not.toHaveBeenCalled();
    expect(search.open).toBe(false);
    expect(search.total).toBe(0);
  });

  it("distinguishes incomplete or failed search from zero results and supports retry", async () => {
    vi.useFakeTimers();
    const { search, request } = setup(
      vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValue({ results: [], totalCount: 0, hasMore: false, indexing: true }),
    );
    search.change("검색");
    await vi.advanceTimersByTimeAsync(180);
    expect(search.error).toBe(true);
    expect(search.loading).toBe(false);
    search.retry();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(search.partial).toBe(true);
    expect(search.error).toBe(false);
    search.close(false);
  });
});
