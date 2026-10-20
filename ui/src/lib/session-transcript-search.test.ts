import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  searchSessionTranscripts,
  createSessionTranscriptSearchPager,
  sessionTranscriptSearchScope,
} from "./session-transcript-search.ts";

describe("searchSessionTranscripts", () => {
  it("delegates complete agent scope to the server without listing session keys", async () => {
    const result = { results: [], totalCount: 0, hasMore: false };
    const request = vi.fn(async () => result);
    expect(
      await searchSessionTranscripts({ request } as unknown as GatewayBrowserClient, {
        query: "배포",
        agentId: "personal",
      }),
    ).toBe(result);
    expect(request).toHaveBeenCalledWith("sessions.search", {
      query: "배포",
      agentId: "personal",
      scope: "agent",
      mode: "substring",
      limit: 25,
    });
  });
  it("preserves explicit thread generation and pagination", async () => {
    const request = vi.fn(async () => ({ results: [] }));
    await searchSessionTranscripts({ request } as unknown as GatewayBrowserClient, {
      query: ".env",
      sessionKeys: ["agent:main:one"],
      sessionId: "old-generation",
      offset: 25,
      limit: 25,
    });
    expect(request).toHaveBeenCalledWith("sessions.search", {
      query: ".env",
      sessionKeys: ["agent:main:one"],
      sessionId: "old-generation",
      offset: 25,
      limit: 25,
      mode: "substring",
    });
  });
  it("merges two agents across page boundaries without applying global offsets to each", async () => {
    const hit = (agentId: string, index: number, timestamp: number) => ({
      sessionKey: `agent:${agentId}:thread`,
      sessionId: agentId,
      messageId: `message-${index}`,
      role: "user" as const,
      timestamp,
      snippet: "needle",
      score: 0,
    });
    const rows = {
      main: Array.from({ length: 30 }, (_, i) => hit("main", i, 100 - i * 2)),
      writer: Array.from({ length: 3 }, (_, i) => hit("writer", i, 99 - i * 2)),
      empty: [],
    };
    const request = vi.fn(
      async (
        _method: string,
        params: { agentId: keyof typeof rows; offset: number; limit: number },
      ) => {
        const all = rows[params.agentId];
        const results = all.slice(params.offset, params.offset + params.limit);
        return {
          results,
          totalCount: all.length,
          hasMore: params.offset + results.length < all.length,
        };
      },
    );
    const pager = createSessionTranscriptSearchPager(
      { request } as unknown as GatewayBrowserClient,
      { query: "needle", agentIds: ["main", "writer", "empty"], limit: 25 },
    );
    const first = await pager.next();
    const second = await pager.next();
    expect(first.results.slice(0, 6).map((row) => row.sessionKey)).toEqual([
      "agent:main:thread",
      "agent:writer:thread",
      "agent:main:thread",
      "agent:writer:thread",
      "agent:main:thread",
      "agent:writer:thread",
    ]);
    expect(first).toMatchObject({ totalCount: 33, hasMore: true });
    expect(second).toMatchObject({ totalCount: 33, hasMore: false });
    expect([...first.results, ...second.results]).toHaveLength(33);
    expect(
      new Set([...first.results, ...second.results].map((row) => row.sessionKey + row.messageId))
        .size,
    ).toBe(33);
    expect(request.mock.calls.map(([, params]) => [params.agentId, params.offset])).toEqual([
      ["main", 0],
      ["writer", 0],
      ["empty", 0],
      ["main", 25],
    ]);
  });

  it("keeps a bound personal agent to one request even if shared scope says all", async () => {
    const scope = sessionTranscriptSearchScope({
      accessMode: "personal-agent",
      gateway: { snapshot: { assistantAgentId: "personal" } },
      agentSelection: { state: { scopeId: null } },
    } as never);
    const request = vi.fn(async () => ({ results: [], totalCount: 0, hasMore: false }));
    await createSessionTranscriptSearchPager({ request } as unknown as GatewayBrowserClient, {
      query: "배포",
      ...scope,
    }).next();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "sessions.search",
      expect.objectContaining({ agentId: "personal" }),
    );
  });
});
