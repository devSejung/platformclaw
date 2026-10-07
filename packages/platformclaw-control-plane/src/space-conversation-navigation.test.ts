import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BrowserGatewaySpaceAccess } from "./browser-gateway-space-access.js";
import type { SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";
import { SqliteSpaceConversationStore } from "./sqlite-space-conversations.js";

const rpc = "platformclaw.spaces.conversation.";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function create(f: Fixture, actor = f.alice) {
  return f.proxy.request<SpaceConversation>(actor.token, rpc + "create", {
    spaceId: f.space.id,
    pageId: f.page.id,
    title: "Space work",
    requestId: "own-tab",
  });
}

describe("Space-only conversation navigation", () => {
  it("rejects ambiguous UUID prefixes instead of selecting an arbitrary Space", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE collaboration_space_conversations (
        id TEXT, session_key TEXT, owner_id TEXT, agent_id TEXT
      );
      INSERT INTO collaboration_space_conversations VALUES
        ('12345678-0000-4000-8000-000000000001', 'agent:own:space-session:first', 'owner', 'own'),
        ('12345678-0000-4000-8000-000000000002', 'agent:own:space-session:second', 'owner', 'own');`);
      const conversations = new SqliteSpaceConversationStore(db, {
        access: () => {
          throw new Error("Ambiguity must be rejected before selecting a Space");
        },
        page: () => {
          throw new Error("Unused");
        },
      });
      expect(() => conversations.byShortId("owner", "own", "12345678")).toThrow("ambiguous");
      expect(conversations.byShortId("peer", "own", "12345678")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("pins ordinary discovery before pagination and rejects a Gateway that ignores the exclusion", async () => {
    const f = await fixture();
    const conversation = await create(f);
    const key = `agent:${conversation.agentId}:main`;
    const result = {
      sessions: [{ key }],
      count: 1,
      totalCount: 2,
      offset: 1,
      limitApplied: 1,
      nextOffset: null,
      hasMore: false,
    };
    f.request.mockResolvedValueOnce(result);
    await expect(
      f.proxy.request(f.alice.token, "sessions.list", {
        limit: 1,
        offset: 1,
        sortBy: "lastInteractionAt",
        search: "Space work",
      }),
    ).resolves.toEqual(result);
    expect(f.request).toHaveBeenLastCalledWith("sessions.list", {
      limit: 1,
      offset: 1,
      sortBy: "lastInteractionAt",
      search: "Space work",
      agentId: conversation.agentId,
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
      excludeSessionKeyPrefixes: [`agent:${conversation.agentId}:space-session:`],
    });
    f.request.mockResolvedValueOnce({
      sessions: [{ key: conversation.sessionKey }],
      totalCount: 1,
    });
    await expect(f.proxy.request(f.alice.token, "sessions.list", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("preserves authorized Space lifecycle and cursorless transcript updates for embedded panes", async () => {
    const f = await fixture();
    const conversation = await create(f);
    const sessionKey = conversation.sessionKey;
    expect(f.service.conversations.canAccessNative(f.alice.user.id, sessionKey, true)).toBe(true);
    for (const change of [{ phase: "message" }, { reason: "child-updated" }, { reason: "patch" }]) {
      const frame = {
        event: "sessions.changed",
        payload: {
          sessionKey,
          ...change,
          hasActiveRun: false,
          session: { key: sessionKey, hasActiveRun: false, status: "done" },
        },
      };
      // phase=message without per-message cursors is the only batch-history invalidation.
      expect(await f.proxy.filterEvent(f.alice.token, frame)).toEqual(frame);
      expect(await f.proxy.filterEvent(f.bob.token, frame)).toBeNull();
    }
    const keyOnly = {
      event: "sessions.changed",
      payload: { key: sessionKey, reason: "child-updated", hasActiveSubagentRun: true },
    };
    expect(await f.proxy.filterEvent(f.alice.token, keyOnly)).toEqual(keyOnly);
    for (const payload of [
      { sessionKey: 42, key: sessionKey },
      { sessionKey, session: { key: "agent:other:main" } },
      { sessionKey: `agent:${conversation.agentId}:space-session:unregistered` },
    ]) {
      expect(
        await f.proxy.filterEvent(f.alice.token, { event: "sessions.changed", payload }),
      ).toBeNull();
    }
    for (const event of ["chat", "agent", "session.tool", "session.message"]) {
      const frame = { event, payload: { sessionKey, session: { key: sessionKey } } };
      expect(await f.proxy.filterEvent(f.alice.token, frame)).toEqual(frame);
    }
    f.request.mockResolvedValueOnce({ messages: [], sessionInfo: { key: sessionKey } });
    await expect(f.proxy.request(f.alice.token, "chat.history", { sessionKey })).resolves.toEqual({
      messages: [],
      sessionInfo: { key: sessionKey },
    });
  });

  it("removes stale Space search keys before the native result limit and never widens an empty scope", async () => {
    const f = await fixture();
    const conversation = await create(f);
    const key = `agent:${conversation.agentId}:main`;
    f.request.mockResolvedValueOnce({ results: [{ sessionKey: key }] });
    await expect(
      f.proxy.request(f.alice.token, "sessions.search", {
        sessionKeys: [conversation.sessionKey, key],
        query: "needle",
        limit: 1,
      }),
    ).resolves.toEqual({ results: [{ sessionKey: key }] });
    expect(f.request).toHaveBeenLastCalledWith("sessions.search", {
      agentId: conversation.agentId,
      sessionKeys: [key],
      query: "needle",
      limit: 1,
    });
    f.request.mockClear();
    await expect(
      f.proxy.request(f.alice.token, "sessions.search", {
        sessionKeys: [conversation.sessionKey],
        query: "needle",
      }),
    ).resolves.toEqual({ results: [] });
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce({ results: [{ sessionKey: conversation.sessionKey }] });
    await expect(
      f.proxy.request(f.alice.token, "sessions.search", { sessionKeys: [key], query: "needle" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });

  it("resolves full keys and UUID short links only to the owner's accessible Space", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const conversation = await create(f, f.bob);
    const route = {
      spaceId: conversation.spaceId,
      pageId: conversation.pageId,
      conversationId: conversation.id,
    };
    const shortId = conversation.id.replaceAll("-", "").slice(0, 12).toUpperCase();
    for (const params of [
      { sessionKey: conversation.sessionKey },
      { agentId: conversation.agentId, shortId },
    ]) {
      await expect(f.proxy.request(f.bob.token, rpc + "resolve", params)).resolves.toEqual(route);
    }
    await expect(
      f.proxy.request(f.alice.token, rpc + "resolve", { sessionKey: conversation.sessionKey }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.proxy.request(f.alice.token, rpc + "resolve", { agentId: conversation.agentId, shortId }),
    ).rejects.toThrow("unavailable");
    await expect(
      f.proxy.request(f.bob.token, rpc + "resolve", {
        sessionKey: `agent:${conversation.agentId}:main`,
      }),
    ).resolves.toBeNull();
    await expect(
      f.proxy.request(f.bob.token, rpc + "resolve", { shortId: "abc" }),
    ).rejects.toThrow();
    await expect(
      f.proxy.request(f.bob.token, rpc + "resolve", {
        shortId,
        sessionKey: conversation.sessionKey,
      }),
    ).rejects.toThrow("one conversation");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 2);
    await expect(
      f.proxy.request(f.bob.token, rpc + "resolve", { sessionKey: conversation.sessionKey }),
    ).resolves.toEqual(route);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 3);
    await expect(f.proxy.request(f.bob.token, rpc + "resolve", { shortId })).rejects.toThrow(
      "unavailable",
    );
  });

  it("rechecks short-link authority after the outer authentication await", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const conversation = await create(f, f.bob);
    const access = await f.proxy.resolveAccess(f.bob.token);
    const params = { shortId: conversation.id.replaceAll("-", "").slice(0, 8) };
    const guard = new BrowserGatewaySpaceAccess(
      { spaceService: f.service, resolveAgentIdFromSessionKey: (key) => key.split(":")[1] ?? null },
      async () => {
        f.store.spaces.leave(f.bob.user.id, f.space.id, 2);
        return access;
      },
    );
    await expect(
      guard.guardRequest(f.bob.token, access, rpc + "resolve", params, undefined, async () =>
        f.service.conversations.resolveRoute(f.bob.user.id, conversation.agentId, params),
      ),
    ).rejects.toThrow("unavailable");
  });
});
