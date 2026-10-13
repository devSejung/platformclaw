import { describe, expect, it } from "vitest";
import { parseSpaceReadRequest } from "./space-read-request.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

describe("shared content recall boundaries", () => {
  it.each([undefined, "page", "qa"])("accepts the literal get view %s", (view) => {
    expect(parseSpaceReadRequest({ operation: "get", view }, "synthetic-agent")).toEqual({
      agentId: "synthetic-agent",
      operation: "get",
      ...(view === undefined ? {} : { view }),
    });
  });

  it.each([null, 0, true, "other", ["page"], ["qa"], { view: "qa" }])(
    "rejects a non-literal get view %j without coercion",
    (view) => {
      expect(() => parseSpaceReadRequest({ operation: "get", view }, "synthetic-agent")).toThrow(
        "Invalid Space read",
      );
    },
  );

  it("does not spend the Gateway lookup budget on empty Spaces before a later Note", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      f.page.title,
      "Synthetic late-note marker",
      f.page.revision,
    );
    for (let index = 0; index < 40; index++) {
      f.store.spaces.create(f.alice.user.id, `Empty synthetic Space ${index}`, `empty-${index}`);
    }
    const publicResult = await f.service.search(
      f.alice.user.id,
      "late-note marker",
      undefined,
      async () => {},
    );
    expect(publicResult.results).toHaveLength(1);
    expect(publicResult.windowLimited).not.toBe(true);
    const result = await f.service.agentRead({
      agentId: f.alice.binding.agentId,
      operation: "search",
      query: "late-note marker",
    });
    expect(result).toMatchObject({
      count: 1,
      // Personal transcript recall keeps its existing non-exhaustive marker.
      windowLimited: true,
      results: [{ pageId: f.page.id, pageTitle: f.page.title }],
    });
    expect(f.request.mock.calls.every(([method]) => method === "sessions.search")).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("rejects the legacy saved-post view and preserves the legacy read projection", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      f.page.title,
      "N".repeat(32000),
      f.page.revision,
    );
    f.request.mockResolvedValue({
      messages: Array.from({ length: 20 }, (_, index) => ({
        role: "assistant",
        content: "A".repeat(16000),
        __openclaw: { id: `synthetic-message-${index}` },
      })),
    });
    const params = {
      agentId: f.space.agentId,
      sessionKey: `agent:${f.space.agentId}:space:${f.page.id}`,
      runId: "fixture-history",
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
    };
    await expect(f.service.agentRead({ ...params, view: "qa" })).rejects.toThrow(
      "require a personal agent",
    );
    expect(f.request).not.toHaveBeenCalled();
    const result = await f.service.agentRead(params);
    expect((result.messages as unknown[]).length).toBe(5);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(result).toHaveProperty("page.nextBodyOffset");
    expect(result).toHaveProperty("sourceWindow");
  });

  it("matches published rename aliases before deduplicating actors and reports a shared alias as ambiguous", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(
      f.alice.user.id,
      f.space.id,
      f.bob.user.id,
      "editor",
      f.space.revision,
    );
    const publish = async (
      actor: typeof f.alice,
      displayName: string,
      requestId: string,
      revision: number,
    ) => {
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
      const conversation = f.store.spaces.createConversation(actor.user.id, f.space.id, {
        pageId: f.page.id,
        title: "Synthetic author publishing",
        requestId: `conversation-${actor.token}`,
      });
      return f.store.spaces.content.mutate(
        {
          agentId: actor.binding.agentId,
          sessionKey: conversation.sessionKey,
          runtimeRunId: "synthetic-runtime",
          admissionRunId: "synthetic-admission",
        },
        {
          operation: "qa.append",
          body: `Synthetic answer published as ${displayName}`,
          expectedRevision: revision,
          requestId,
        },
      );
    };
    await publish(f.alice, "Alice", "alias-one", 1);
    const renamed = await publish(f.alice, "Aardvark", "alias-two", 2);
    expect(
      f.store.spaces.content
        .qaAuthors(f.alice.user.id, f.space.id, f.alice.user.id)
        .map((author) => author.name),
    ).toEqual(["Aardvark", "Alice"]);
    const params = {
      agentId: f.alice.binding.agentId,
      operation: "search",
      spaceId: f.space.id,
      authorName: "Aardvark",
    };
    const unique = await f.service.agentRead(params);
    expect(unique.ambiguousAuthor).not.toBe(true);
    expect(unique.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ postId: renamed.postId, authorId: f.alice.user.id }),
      ]),
    );
    await publish(f.bob, "Aardvark", "alias-three", 3);
    const ambiguous = await f.service.agentRead(params);
    expect(ambiguous).toMatchObject({ ambiguousAuthor: true, results: [] });
    expect(
      (ambiguous.authors as Array<{ authorId: string }>)
        .map((author) => author.authorId)
        .toSorted(),
    ).toEqual([f.alice.user.id, f.bob.user.id].toSorted());
    expect(f.request).not.toHaveBeenCalled();
  });
});
