import { describe, expect, it, vi } from "vitest";
import type { Space, SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

type Fixture = Awaited<ReturnType<typeof createSpaceTestFixture>>;
function create(f: Fixture, requestId: string, title: string, actor = f.alice, pageId = f.page.id) {
  return f.proxy.request<SpaceConversation>(
    actor.token,
    "platformclaw.spaces.conversation.create",
    {
      spaceId: f.space.id,
      pageId,
      title,
      requestId,
    },
  );
}
function rename(
  f: Fixture,
  conversation: SpaceConversation,
  title: string,
  expectedRevision: number,
  actor = f.alice,
) {
  return f.proxy.request<SpaceConversation>(
    actor.token,
    "platformclaw.spaces.conversation.rename",
    {
      spaceId: f.space.id,
      conversationId: conversation.id,
      title,
      expectedRevision,
      expectedTitle: conversation.title,
    },
  );
}

describe("Space conversation rename", () => {
  it("renames only the registry title, allocates collisions and retains create retries", async () => {
    const f = await createSpaceTestFixture();
    const first = await create(f, "first", "Original");
    await create(f, "taken", "Taken");
    const nativeCalls = f.request.mock.calls.length;
    const renamed = await rename(f, first, " Taken ", 1);
    expect(renamed).toEqual({ ...first, title: "Taken2" });
    expect(f.request).toHaveBeenCalledTimes(nativeCalls);
    expect(await rename(f, renamed, renamed.title, 1)).toEqual(renamed);
    const listed = await f.proxy.request<{ space: Space; conversations: SpaceConversation[] }>(
      f.alice.token,
      "platformclaw.spaces.get",
      { spaceId: f.space.id },
    );
    expect(listed.space.revision).toBe(1);
    expect(listed.conversations.find((entry) => entry.id === first.id)).toEqual(renamed);
    expect(await create(f, "first", "Original")).toEqual(renamed);
    await expect(create(f, "first", renamed.title)).rejects.toThrow("request changed");
    expect((await create(f, "next", "Taken")).title).toBe("Taken3");
    await expect(rename(f, renamed, "Stale revision", 2)).rejects.toThrow("Space changed");
    await expect(rename(f, first, "Stale overwrite", 1)).rejects.toThrow("Conversation changed");
    expect(f.store.spaces.conversation(f.alice.user.id, f.space.id, first.id)).toEqual(renamed);
  });

  it("keeps rename allocation owner/page scoped and bounds Unicode suffixes", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const target = await create(f, "target", "Original");
    await create(f, "peer", "Peer title", f.bob);
    const otherPage = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
      title: "Other page",
      body: "",
      requestId: "other-page",
    });
    await create(f, "other-page", "Peer title", f.alice, otherPage.id);
    const scoped = await rename(f, target, "Peer title", 2);
    expect(scoped.title).toBe("Peer title");
    const title = "😀".repeat(120);
    await create(f, "unicode", title);
    const renamed = await rename(f, scoped, title, 2);
    expect(renamed.title).toBe("😀".repeat(119) + "2");
    expect(renamed.title.length).toBeLessThanOrEqual(240);
    expect(Buffer.from(renamed.title, "utf8").toString("utf8")).toBe(renamed.title);
  });

  it("keeps a pending native chat admission valid while its title changes", async () => {
    const f = await createSpaceTestFixture();
    const conversation = await create(f, "target", "Original");
    const native = f.request.getMockImplementation()!;
    let release!: () => void;
    f.request.mockImplementation(async (method, params) => {
      if (method === "chat.send") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "started" };
      }
      return native(method, params);
    });
    const pending = f.proxy.request(f.alice.token, "chat.send", {
      sessionKey: conversation.sessionKey,
      message: "Keep investigating",
      idempotencyKey: "pending-admission",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await rename(f, conversation, "Renamed while sending", 1);
    release();
    await expect(pending).resolves.toMatchObject({ status: "started" });
    expect(f.request).not.toHaveBeenCalledWith("chat.abort", expect.anything());
    expect(f.request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    expect(f.store.spaces.access(f.alice.user.id, f.space.id).revision).toBe(1);
  });

  it.each(["", " \n\t", "x".repeat(241)])(
    "rejects invalid title %j without changes",
    async (title) => {
      const f = await createSpaceTestFixture();
      const conversation = await create(f, "target", "Original");
      await expect(rename(f, conversation, title, 1)).rejects.toThrow("title");
      expect(f.store.spaces.conversation(f.alice.user.id, f.space.id, conversation.id)).toEqual(
        conversation,
      );
      expect(f.store.spaces.access(f.alice.user.id, f.space.id).revision).toBe(1);
    },
  );

  it.each(["peer", "viewer", "removed", "disabled"] as const)(
    "denies %s renames even with a current revision",
    async (access) => {
      const f = await createSpaceTestFixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
      const conversation = await create(f, "target", "Original");
      let revision = 2;
      if (access === "viewer" || access === "removed") {
        f.store.spaces.setMember(
          f.bob.user.id,
          f.space.id,
          f.alice.user.id,
          access === "viewer" ? "viewer" : null,
          revision,
        );
        revision++;
      } else if (access === "disabled") {
        await f.store.transitionAgent({
          bindingId: f.alice.binding.id,
          state: "disabled",
          changedAt: Date.now(),
        });
      }
      const actor = access === "peer" ? f.bob : f.alice;
      await expect(rename(f, conversation, "Forbidden", revision, actor)).rejects.toThrow(
        /unavailable|read-only|active personal agent/,
      );
      expect(f.store.spaces.registeredConversation(conversation.sessionKey)?.title).toBe(
        "Original",
      );
      expect(f.store.spaces.access(f.bob.user.id, f.space.id).revision).toBe(revision);
    },
  );
});
