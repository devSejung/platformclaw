import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";
import { SqliteControlPlaneStore } from "./sqlite-store.js";

describe("Space conversation title allocation", () => {
  it("allocates owner/page titles through browser admission without claiming native labels", async () => {
    const f = await createSpaceTestFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const native = f.request.getMockImplementation()!;
    // Native labels are agent-wide aliases, including private sessions outside this page.
    const labels = new Set(["새 대화", "새 대화2", "새 대화3"]);
    let loseResponse = true;
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as { label?: string };
      if (method === "sessions.create" && params.label) {
        if (labels.has(params.label)) {
          throw new Error(`label already in use: ${params.label}`);
        }
        labels.add(params.label);
      }
      const result = await native(method, raw);
      if (method === "sessions.create" && loseResponse) {
        loseResponse = false;
        throw new Error("response lost");
      }
      return result;
    });
    const create = (requestId: string, title = "새 대화", actor = f.alice, pageId = f.page.id) =>
      f.proxy.request<SpaceConversation>(actor.token, "platformclaw.spaces.conversation.create", {
        spaceId: f.space.id,
        pageId,
        title,
        requestId,
      });
    await expect(create("first")).rejects.toThrow("response lost");
    const first = await create("first");
    const [second, third, repeated] = await Promise.all([
      create("second"),
      create("third"),
      create("second"),
    ]);
    expect([first.title, second.title, third.title]).toEqual(["새 대화", "새 대화2", "새 대화3"]);
    expect(repeated).toEqual(second);
    await expect(create("second", second.title)).rejects.toThrow("request changed");
    expect((await create("bob", "새 대화", f.bob)).title).toBe("새 대화");
    const page = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
      title: "Another page",
      body: "",
      requestId: "another-page",
    });
    expect((await create("other-page", "새 대화", f.alice, page.id)).title).toBe("새 대화");
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.create")).toHaveLength(5);
  });

  it("retains exact request receipts after reopening and bounds Unicode suffixes", async () => {
    const root = mkdtempSync(join(tmpdir(), "space-titles-"));
    const options = {
      databasePath: join(root, "control.sqlite"),
      initialAdminAccountIds: ["alice"],
      buildAgentMainSessionKey: ({ agentId }: { agentId: string }) => `agent:${agentId}:main`,
    };
    let store: SqliteControlPlaneStore | undefined;
    const closeStore = () => {
      const active = store;
      store = undefined;
      active?.close();
    };
    try {
      store = new SqliteControlPlaneStore(options);
      const { user } = await store.upsertPrincipal(
        { provider: "ldap", subject: "alice", accountId: "alice", employeeId: "alice" },
        Date.now(),
      );
      const reserved = await store.reservePersonalAgent(user.id, Date.now());
      await store.transitionAgent({
        bindingId: reserved.binding.id,
        state: "active",
        changedAt: Date.now(),
      });
      const space = store.spaces.create(user.id, "Team", "team");
      const page = store.spaces.createPage(user.id, space.id, {
        title: "Page",
        body: "",
        requestId: "page",
      });
      const title = "😀".repeat(120);
      const create = (requestId: string, requestedTitle = title) =>
        store!.spaces.createConversation(user.id, space.id, {
          pageId: page.id,
          title: requestedTitle,
          requestId,
        });
      const first = create("first");
      closeStore();
      const olderDatabase = new DatabaseSync(options.databasePath);
      try {
        olderDatabase.exec("DROP TABLE IF EXISTS collaboration_space_conversation_titles");
      } finally {
        olderDatabase.close();
      }
      store = new SqliteControlPlaneStore(options);
      expect(create("first")).toEqual(first);
      const second = create("second");
      expect(second.title).toBe("😀".repeat(119) + "2");
      expect(second.title.length).toBeLessThanOrEqual(240);
      create("reserved", "Name2");
      create("base", "Name");
      expect(create("collision", " Name ").title).toBe("Name3");
      closeStore();
      store = new SqliteControlPlaneStore(options);
      expect(create("first")).toEqual(first);
      expect(create("second")).toEqual(second);
      expect(() => create("second", second.title)).toThrow("request changed");
      expect(create("collision", " Name ").title).toBe("Name3");
      expect(() => create("collision", "Name")).toThrow("request changed");
    } finally {
      try {
        closeStore();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
