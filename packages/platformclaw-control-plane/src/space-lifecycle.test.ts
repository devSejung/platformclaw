import { describe, expect, it, vi } from "vitest";
import { BrowserGatewaySpaceAccess } from "./browser-gateway-space-access.js";
import type { Space, SpaceConversation } from "./space-contracts.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

const rpc = "platformclaw.spaces.";
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function conversation(f: Fixture, actor = f.alice) {
  return f.proxy.request<SpaceConversation>(actor.token, rpc + "conversation.create", {
    spaceId: f.space.id,
    pageId: f.page.id,
    title: "Shared investigation",
    requestId: `tab-${actor.token}`,
  });
}
function deleteParams(f: Fixture, revision: number) {
  return { spaceId: f.space.id, expectedRevision: revision, confirmName: f.space.name };
}
function installPurge(f: Fixture) {
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (method, params) =>
    method === "sessions.delete"
      ? {
          ok: true,
          key: (params as { key: string }).key,
          deleted: true,
          purged: true,
          purgeScope: "owned-session-data",
        }
      : original(method, params),
  );
}

describe("Space departure and destructive deletion", () => {
  it.each(["editor", "owner"] as const)(
    "removes a disabled %s without restoring access when the employee is reactivated",
    async (role) => {
      const f = await fixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, role, 1);
      const tab = await conversation(f, f.bob);
      await f.store.setManagedUserStatus({
        actorUserId: f.alice.user.id,
        targetUserId: f.bob.user.id,
        status: "disabled",
        changedAt: Date.now(),
      });
      expect(f.store.spaces.members(f.alice.user.id, f.space.id)).toHaveLength(1);
      for (const nextRole of ["viewer", "editor", "owner"] as const) {
        await expect(
          f.proxy.request(f.alice.token, rpc + "member.set", {
            spaceId: f.space.id,
            userId: f.bob.user.id,
            role: nextRole,
            expectedRevision: 2,
          }),
        ).rejects.toThrow("unavailable");
      }
      await expect(
        f.proxy.request(f.alice.token, rpc + "member.remove", {
          spaceId: f.space.id,
          userId: f.bob.user.id,
          expectedRevision: 2,
        }),
      ).resolves.toEqual({ updated: true });
      expect(f.request).toHaveBeenCalledWith("sessions.abort", {
        key: tab.sessionKey,
        agentId: tab.agentId,
        clearQueued: true,
      });
      expect(f.store.spaces.access(f.alice.user.id, f.space.id)).toMatchObject({
        role: "owner",
        revision: 3,
      });
      await f.store.setManagedUserStatus({
        actorUserId: f.alice.user.id,
        targetUserId: f.bob.user.id,
        status: "active",
        changedAt: Date.now(),
      });
      expect(f.store.spaces.list(f.bob.user.id)).toEqual([]);
      expect(() => f.store.spaces.access(f.bob.user.id, f.space.id)).toThrow("unavailable");
    },
  );

  it("lets members leave only themselves, retaining shared Q&A and rejecting old personal capabilities", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const tab = await conversation(f, f.bob);
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", {
        spaceId: f.space.id,
        expectedRevision: 2,
        userId: f.alice.user.id,
      }),
    ).rejects.toThrow("parameter");
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 1 }),
    ).rejects.toThrow("changed");
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 2 }),
    ).resolves.toEqual({ left: true });
    expect(f.store.spaces.list(f.bob.user.id)).toEqual([]);
    expect(f.store.spaces.sharedConversation(f.alice.user.id, f.space.id, tab.id)).toMatchObject({
      id: tab.id,
      ownerId: f.bob.user.id,
    });
    await expect(
      f.proxy.request(f.bob.token, "chat.history", { sessionKey: tab.sessionKey }),
    ).rejects.toThrow("unavailable");
    expect(f.request).toHaveBeenCalledWith("sessions.abort", {
      key: tab.sessionKey,
      agentId: tab.agentId,
      clearQueued: true,
    });
    expect(
      f.service.event(f.bob.user.id, { event: "chat", payload: { sessionKey: tab.sessionKey } }),
    ).toBeNull();
    // Lost acknowledgments can retry cancellation without granting membership back.
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 2 }),
    ).resolves.toEqual({ left: true });
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 3);
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 2 }),
    ).rejects.toThrow("changed");
    expect(f.store.spaces.access(f.bob.user.id, f.space.id).role).toBe("editor");
  });

  it("rechecks Space authority after the outer browser authentication await", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const access = await f.proxy.resolveAccess(f.bob.token);
    const guard = new BrowserGatewaySpaceAccess(
      { spaceService: f.service, resolveAgentIdFromSessionKey: (key) => key.split(":")[1] ?? null },
      async () => {
        f.store.spaces.leave(f.bob.user.id, f.space.id, 2);
        return access;
      },
    );
    await expect(
      guard.guardRequest(
        f.bob.token,
        access,
        rpc + "get",
        { spaceId: f.space.id },
        undefined,
        async () => ({ page: f.store.spaces.page(f.bob.user.id, f.space.id, f.page.id) }),
      ),
    ).rejects.toThrow("unavailable");
  });

  it("requires another active owner before the last owner can leave", async () => {
    const f = await fixture();
    await expect(
      f.proxy.request(f.alice.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 1 }),
    ).rejects.toThrow("another active Space owner");
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    await expect(
      f.proxy.request(f.alice.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 2 }),
    ).resolves.toEqual({ left: true });
    expect(f.store.spaces.access(f.bob.user.id, f.space.id).role).toBe("owner");
  });

  it("retries incomplete self-leave cancellation after access has been removed", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    await conversation(f, f.bob);
    const original = f.request.getMockImplementation()!;
    let fail = true;
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.abort" && fail) {
        throw new Error("offline");
      }
      return original(method, params);
    });
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 2 }),
    ).rejects.toThrow("Access removed");
    expect(f.store.spaces.list(f.bob.user.id)).toEqual([]);
    expect(f.store.spaces.list(f.bob.user.id, true)).toContainEqual(
      expect.objectContaining({ id: f.space.id, leaving: true, revision: 2 }),
    );
    expect(f.store.spaces.list(f.alice.user.id, true).some((space) => space.leaving)).toBe(false);
    fail = false;
    await expect(
      f.proxy.request(f.bob.token, rpc + "leave", { spaceId: f.space.id, expectedRevision: 2 }),
    ).resolves.toEqual({ left: true });
    expect(f.store.spaces.list(f.bob.user.id, true)).toEqual([]);
  });

  it("coalesces duplicate leave cleanup and never aborts again after completed replay", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    await conversation(f, f.bob);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.abort") {
        await hold;
      }
      return original(method, params);
    });
    const first = f.service.lifecycle.leave(f.bob.user.id, f.space.id, 2);
    const second = f.service.lifecycle.leave(f.bob.user.id, f.space.id, 2);
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.abort")).toHaveLength(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([{ left: true }, { left: true }]);
    f.request.mockClear();
    await expect(f.service.lifecycle.leave(f.bob.user.id, f.space.id, 2)).resolves.toEqual({
      left: true,
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.store.spaces.list(f.bob.user.id, true)).toEqual([]);
  });

  it("fences re-invitation until delayed leave cancellation finishes", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const tab = await conversation(f, f.bob);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.abort") {
        await hold;
      }
      return original(method, params);
    });
    const leaving = f.service.lifecycle.leave(f.bob.user.id, f.space.id, 2);
    for (const role of ["editor", "owner", null] as const) {
      expect(() =>
        f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, role, 3),
      ).toThrow("still leaving");
    }
    await expect(
      f.proxy.request(f.bob.token, "chat.send", {
        sessionKey: tab.sessionKey,
        message: "too early",
        idempotencyKey: "before-cleanup",
      }),
    ).rejects.toThrow("unavailable");
    release();
    await expect(leaving).resolves.toEqual({ left: true });
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 3);
    f.request.mockClear();
    await expect(
      f.proxy.request(f.bob.token, "chat.send", {
        sessionKey: tab.sessionKey,
        message: "new authorized turn",
        idempotencyKey: "after-cleanup",
      }),
    ).resolves.toMatchObject({ status: "started" });
    expect(f.request.mock.calls.some(([method]) => method === "sessions.abort")).toBe(false);
  });

  it("requires owner authority, current revision and exact destructive confirmation", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    await expect(f.proxy.request(f.bob.token, rpc + "delete", deleteParams(f, 2))).rejects.toThrow(
      "unavailable",
    );
    await expect(
      f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 1)),
    ).rejects.toThrow("changed");
    await expect(
      f.proxy.request(f.alice.token, rpc + "delete", { ...deleteParams(f, 2), confirmName: "pmu" }),
    ).rejects.toThrow("exact Space name");
    expect(f.store.spaces.access(f.bob.user.id, f.space.id).name).toBe(f.space.name);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("blocks every member immediately, purges personal and legacy sessions, and never resurrects a deleted Space on retries", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const own = await conversation(f);
    const peer = await conversation(f, f.bob);
    const unrelated = f.store.spaces.create(f.alice.user.id, "Other", "other");
    installPurge(f);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.delete") {
        await blocked;
      }
      return original(method, params);
    });
    const deleting = f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 2));
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith("sessions.delete", expect.anything()),
    );
    expect(f.store.spaces.list(f.bob.user.id)).toEqual([]);
    const pending = await f.proxy.request<Space[]>(f.alice.token, rpc + "list", {});
    expect(pending).toContainEqual(
      expect.objectContaining({ id: f.space.id, deleting: true, revision: 2 }),
    );
    for (const actor of [f.alice, f.bob]) {
      await expect(
        f.proxy.request(actor.token, rpc + "get", { spaceId: f.space.id }),
      ).rejects.toThrow("unavailable");
      await expect(
        f.proxy.request(actor.token, rpc + "search", { spaceId: f.space.id, query: "Board" }),
      ).rejects.toThrow("unavailable");
    }
    await expect(
      f.proxy.request(f.alice.token, "chat.send", {
        sessionKey: own.sessionKey,
        message: "late",
        idempotencyKey: "late",
      }),
    ).rejects.toThrow("unavailable");
    expect(
      f.service.event(f.alice.user.id, { event: "chat", payload: { sessionKey: own.sessionKey } }),
    ).toBeNull();
    expect(
      f.service.event(f.alice.user.id, {
        event: "chat",
        payload: { sessionKey: `agent:${f.space.agentId}:space:${f.page.id}` },
      }),
    ).toBeNull();
    const duplicate = f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 2));
    release();
    await expect(deleting).resolves.toMatchObject({
      deleted: true,
      scope: "space-pages-and-identifiable-conversation-records",
      retainedData: expect.arrayContaining(["untracked-derived-memory", "unattributed-archives"]),
    });
    await expect(duplicate).resolves.toMatchObject({
      deleted: true,
      scope: "space-pages-and-identifiable-conversation-records",
      retainedData: expect.arrayContaining(["untracked-derived-memory", "unattributed-archives"]),
    });
    expect(
      f.request.mock.calls
        .filter(([method]) => method === "sessions.delete")
        .map(([, params]) => params),
    ).toEqual(
      expect.arrayContaining([
        { key: own.sessionKey, purgeTranscript: true },
        { key: peer.sessionKey, purgeTranscript: true },
        {
          key: `agent:${f.space.agentId}:space:${f.page.id}`,
          purgeTranscript: true,
        },
      ]),
    );
    expect(f.request.mock.calls.filter(([method]) => method === "sessions.delete")).toHaveLength(3);
    expect(f.store.spaces.registeredConversation(own.sessionKey)).toBeUndefined();
    expect(f.store.spaces.list(f.alice.user.id, true)).toEqual([unrelated]);
    await expect(
      f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 2)),
    ).resolves.toMatchObject({
      deleted: true,
      scope: "space-pages-and-identifiable-conversation-records",
      retainedData: expect.arrayContaining(["untracked-derived-memory", "unattributed-archives"]),
    });
    expect(() => f.store.spaces.create(f.alice.user.id, f.space.name, "create-pmu")).toThrow(
      "was deleted",
    );
    await expect(
      f.proxy.request(f.alice.token, "chat.history", { sessionKey: own.sessionKey }),
    ).rejects.toThrow("unavailable");
  });

  it("lets another owner resume deletion and replay its completed acknowledgment", async () => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    installPurge(f);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.delete") {
        await hold;
      }
      return original(method, params);
    });
    const first = f.service.lifecycle.delete(
      f.alice.user.id,
      f.space.id,
      2,
      f.space.name,
      async () => {},
    );
    await vi.waitFor(() =>
      expect(f.store.spaces.list(f.bob.user.id, true)).toContainEqual(
        expect.objectContaining({ id: f.space.id, deleting: true }),
      ),
    );
    const second = f.service.lifecycle.delete(
      f.bob.user.id,
      f.space.id,
      2,
      f.space.name,
      async () => {},
    );
    release();
    await expect(first).resolves.toMatchObject({ deleted: true });
    await expect(second).resolves.toMatchObject({ deleted: true });
    await expect(
      f.service.lifecycle.delete(f.bob.user.id, f.space.id, 2, f.space.name, async () => {}),
    ).resolves.toMatchObject({ deleted: true });
    await expect(
      f.service.lifecycle.delete(f.carol.user.id, f.space.id, 2, f.space.name, async () => {}),
    ).rejects.toThrow("unavailable");
  });

  it("keeps retry targets after partial purge failure and rejects an archival-only acknowledgment", async () => {
    const f = await fixture();
    await conversation(f);
    installPurge(f);
    const original = f.request.getMockImplementation()!;
    let first = true;
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.delete" && first) {
        first = false;
        return {
          ok: true,
          key: (params as { key: string }).key,
          deleted: true,
          archived: ["archive.jsonl"],
        };
      }
      return original(method, params);
    });
    await expect(
      f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 1)),
    ).rejects.toThrow("cleanup is incomplete");
    expect(f.store.spaces.deletionSessions(f.space.id, f.space.agentId)).toHaveLength(2);
    await expect(f.proxy.request(f.bob.token, rpc + "delete", deleteParams(f, 1))).rejects.toThrow(
      "unavailable",
    );
    await expect(
      f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 1)),
    ).resolves.toMatchObject({
      deleted: true,
      scope: "space-pages-and-identifiable-conversation-records",
      retainedData: expect.arrayContaining(["untracked-derived-memory", "unattributed-archives"]),
    });
    expect(f.store.spaces.deletionSessions(f.space.id, f.space.agentId)).toEqual([]);
  });

  it("reports unsupported owned memory cleanup without claiming success or leaking backend paths", async () => {
    const f = await fixture();
    await conversation(f);
    f.request.mockRejectedValue(
      Object.assign(new Error("private /srv/memory path"), {
        details: { reason: "session-purge-unsupported", backend: "qmd" },
      }),
    );
    await expect(
      f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 1)),
    ).rejects.toThrow("QMD cannot permanently purge");
    expect(f.store.spaces.list(f.alice.user.id, true)).toContainEqual(
      expect.objectContaining({ deleting: true }),
    );
    expect(f.store.spaces.deletionSessions(f.space.id, f.space.agentId)).toHaveLength(2);
  });

  it("waits for already-admitted provisioning before purging so a late create cannot resurrect data", async () => {
    const f = await fixture();
    installPurge(f);
    const original = f.request.getMockImplementation()!;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.request.mockImplementation(async (method, params) => {
      if (method === "sessions.create") {
        await hold;
      }
      return original(method, params);
    });
    const creating = conversation(f);
    const creationFailure = expect(creating).rejects.toThrow("unavailable");
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenCalledWith("sessions.create", expect.anything()),
    );
    const deleting = f.proxy.request(f.alice.token, rpc + "delete", deleteParams(f, 1));
    await vi.waitFor(() => expect(f.store.spaces.list(f.alice.user.id)).toEqual([]));
    expect(f.request.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
    release();
    await creationFailure;
    await expect(deleting).resolves.toMatchObject({
      deleted: true,
      scope: "space-pages-and-identifiable-conversation-records",
      retainedData: expect.arrayContaining(["untracked-derived-memory", "unattributed-archives"]),
    });
  });
});
