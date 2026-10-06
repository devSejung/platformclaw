import { describe, expect, it, vi } from "vitest";
import { projectSpaceRecallResult } from "./space-recall-projection.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function create(
  f: Fixture,
  actor = f.alice,
  space = f.space,
  page = f.page,
  requestId = actor.token,
) {
  return f.store.spaces.createConversation(actor.user.id, space.id, {
    pageId: page.id,
    title: "Bringup investigation",
    requestId,
  });
}
async function name(f: Fixture, actor: Fixture["alice"], displayName: string) {
  await f.store.upsertPrincipal(
    {
      provider: "ldap",
      subject: actor.token,
      accountId: actor.token,
      employeeId: actor.token,
      displayName,
    },
    Date.now(),
  );
}

describe("Space conversation author discovery", () => {
  it("never infers a unique author from an incomplete membership window", async () => {
    const f = await fixture();
    await name(f, f.alice, "Alex");
    await name(f, f.bob, "Alex");
    create(f);
    for (let index = 1; index < 100; index++) {
      f.store.spaces.create(f.alice.user.id, `Space ${index}`, `scope-${index}`);
    }
    const params = { agentId: f.alice.binding.agentId, operation: "search", authorName: "Alex" };
    expect(f.store.spaces.recallScope(f.alice.user.id).hasMore).toBe(false);
    expect(await f.service.agentRead(params)).toMatchObject({
      count: 1,
      windowLimited: false,
      results: [{ ownerId: f.alice.user.id }],
    });
    const extra = f.store.spaces.create(f.bob.user.id, "Another team", "extra-scope");
    const page = f.store.spaces.createPage(f.bob.user.id, extra.id, {
      title: "Other investigation",
      body: "",
      requestId: "extra-page",
    });
    create(f, f.bob, extra, page);
    f.store.spaces.setMember(f.bob.user.id, extra.id, f.alice.user.id, "viewer", 1);
    expect(f.store.spaces.list(f.alice.user.id)).toHaveLength(100);
    expect(f.store.spaces.recallScope(f.alice.user.id).hasMore).toBe(true);
    await expect(f.service.agentRead(params)).rejects.toThrow("provide a spaceId");
    expect(await f.service.agentRead({ ...params, spaceId: extra.id })).toMatchObject({
      count: 1,
      results: [{ ownerId: f.bob.user.id }],
    });
    for (const authorId of [f.alice.user.id, f.carol.user.id]) {
      expect(
        await f.service.agentRead({
          agentId: f.alice.binding.agentId,
          operation: "search",
          authorId,
        }),
      ).toMatchObject({ windowLimited: true });
    }
    expect(f.request).not.toHaveBeenCalled();
  });

  it("discovers a partial author name without transcript keywords, then reads only shared Q&A", async () => {
    const f = await fixture();
    await name(f, f.alice, "김하늘");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const conversation = create(f);
    f.store.spaces.createConversation(f.bob.user.id, f.space.id, {
      pageId: f.page.id,
      title: "하늘 관련 질문",
      requestId: "own-name-mention",
    });
    const search = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "search",
      authorName: " 하늘 ",
    });
    expect(search).toMatchObject({
      discoveryOnly: true,
      count: 1,
      results: [{ conversationId: conversation.id, ownerId: f.alice.user.id, ownerName: "김하늘" }],
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(JSON.stringify(search)).not.toMatch(/sessionKey|agentId|canWrite/);
    f.request.mockResolvedValueOnce({
      messages: [
        {
          role: "assistant",
          content: "private activity",
          phase: "commentary",
          __openclaw: { id: "hidden" },
        },
        {
          role: "assistant",
          content: "Shared answer",
          phase: "final_answer",
          __openclaw: { id: "answer" },
        },
      ],
    });
    const read = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
      conversationId: conversation.id,
    });
    expect(read).toMatchObject({ messages: [{ id: "answer", text: "Shared answer" }] });
    expect(JSON.stringify(read)).not.toContain("private activity");
  });

  it("resolves duplicate names across authorized Spaces before any keyword lookup", async () => {
    const f = await fixture();
    await name(f, f.alice, "Alex Kim");
    await name(f, f.bob, "Alex Kim");
    create(f);
    const other = f.store.spaces.create(f.bob.user.id, "Other", "other");
    const page = f.store.spaces.createPage(f.bob.user.id, other.id, {
      title: "Other",
      body: "",
      requestId: "page",
    });
    f.store.spaces.setMember(f.bob.user.id, other.id, f.alice.user.id, "viewer", 1);
    const second = create(f, f.bob, other, page);
    const search = await f.service.agentRead({
      agentId: f.alice.binding.agentId,
      operation: "search",
      authorName: "aLeX",
      query: "clock",
    });
    expect(search).toMatchObject({
      ambiguousAuthor: true,
      results: [],
      authors: expect.arrayContaining([
        expect.objectContaining({
          authorId: f.alice.user.id,
          authorName: "Alex Kim",
          spaceName: f.space.name,
        }),
        expect.objectContaining({
          authorId: f.bob.user.id,
          authorName: "Alex Kim",
          spaceName: other.name,
        }),
      ]),
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(
      await f.service.agentRead({
        agentId: f.alice.binding.agentId,
        operation: "search",
        authorId: f.bob.user.id,
      }),
    ).toMatchObject({ results: [{ conversationId: second.id }], count: 1 });
    expect(
      await f.service.agentRead({
        agentId: f.alice.binding.agentId,
        sessionKey: `agent:${f.alice.binding.agentId}:space-session:${f.store.spaces.sharedConversations(f.alice.user.id, f.space.id)[0]!.id}`,
        operation: "search",
        authorName: "Alex",
      }),
    ).toMatchObject({ count: 1, results: [{ ownerId: f.alice.user.id }] });
  });

  it("filters keyword lookup to the selected owner and excludes commentary-only matches", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const first = create(f);
    create(f, f.bob);
    let finalText = "public answer";
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method === "sessions.search") {
        expect(params).toMatchObject({
          agentId: first.agentId,
          sessionKeys: [first.sessionKey],
          query: "clock",
        });
        return {
          results: [{ sessionKey: first.sessionKey, messageId: "mixed", snippet: "clock private" }],
        };
      }
      return {
        messages: [
          {
            role: "assistant",
            __openclaw: { id: "mixed" },
            content: [
              {
                type: "text",
                text: "clock private",
                textSignature: '{"v":1,"phase":"commentary"}',
              },
              {
                type: "text",
                text: finalText,
                textSignature: '{"v":1,"phase":"final_answer"}',
              },
            ],
          },
        ],
      };
    });
    const search = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "search",
      authorId: f.alice.user.id,
      query: "clock",
    });
    expect(search).toMatchObject({ count: 0, results: [], windowLimited: true });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(search)).not.toContain("private");
    finalText = "clock configured correctly";
    const matched = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "search",
      authorName: "alice",
      query: "clock",
    });
    expect(matched).toMatchObject({
      count: 1,
      results: [
        {
          conversationId: first.id,
          ownerId: f.alice.user.id,
          messageId: "mixed",
          snippet: finalText,
        },
      ],
    });
    expect(f.request).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(matched)).not.toContain("private");
  });

  it("does not discover unauthorized authors and retains departed authors for current members", async () => {
    const f = await fixture();
    const conversation = create(f);
    expect(
      await f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        authorId: f.alice.user.id,
      }),
    ).toMatchObject({ results: [], count: 0 });
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    expect(
      await f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        authorName: "alice",
      }),
    ).toMatchObject({ results: [{ conversationId: conversation.id, ownerId: f.alice.user.id }] });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("revalidates membership after an author-filtered transcript lookup", async () => {
    const f = await fixture();
    create(f);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    f.request.mockImplementationOnce(async () => {
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
      return { results: [] };
    });
    await expect(
      f.service.agentRead({
        agentId: f.bob.binding.agentId,
        operation: "search",
        authorId: f.alice.user.id,
        query: "clock",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("revalidates the whole authorized Space scope before returning discovered metadata", async () => {
    const f = await fixture();
    create(f);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const pending = f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "search",
      authorName: "alice",
    });
    await Promise.resolve();
    // Revoke during the asynchronous authorization boundary, before metadata is returned.
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 2);
    await expect(pending).rejects.toThrow("unavailable");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("bounds metadata discovery pages and duplicate-author candidates", async () => {
    const f = await fixture();
    for (let index = 0; index < 40; index++) {
      create(f, f.alice, f.space, f.page, `conversation-${index}`);
    }
    const params = { agentId: f.alice.binding.agentId, operation: "search", authorName: "alice" };
    const pageRead = vi.spyOn(f.store.spaces, "page");
    const first = await f.service.agentRead(params);
    expect(pageRead).toHaveBeenCalledTimes(21);
    expect(first).toMatchObject({
      count: 5,
      nextCursor: "5",
      windowLimited: true,
      discoveryOnly: true,
    });
    expect(await f.service.agentRead({ ...params, cursor: "5" })).toMatchObject({ count: 5 });
    expect(pageRead).toHaveBeenCalledTimes(42);
    expect(await f.service.agentRead({ ...params, limit: 20 })).toMatchObject({
      count: 20,
      windowLimited: true,
    });
    expect(pageRead).toHaveBeenCalledTimes(63);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(8 * 1024);
    const ambiguous = projectSpaceRecallResult(
      {
        ambiguousAuthor: true,
        authors: Array.from({ length: 30 }, (_, index) => ({
          authorId: String(index),
          authorName: "名".repeat(256),
        })),
      },
      { operation: "search" },
    );
    expect(ambiguous).toMatchObject({ ambiguousAuthor: true, windowLimited: true, results: [] });
    expect(Buffer.byteLength(JSON.stringify(ambiguous), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each([
    { authorName: " " },
    { authorId: " " },
    { authorName: "x".repeat(241) },
    { authorId: "x".repeat(129) },
    { authorName: "Alice", authorId: "alice" },
  ])("rejects invalid direct author search %j", async (params) => {
    const f = await fixture();
    await expect(
      f.service.agentRead({ agentId: f.alice.binding.agentId, operation: "search", ...params }),
    ).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
});
