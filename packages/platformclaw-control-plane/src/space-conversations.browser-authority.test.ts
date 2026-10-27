import { describe, expect, it, vi } from "vitest";
import { createSpaceTestConversation as create } from "./space-conversation.test-helpers.js";
import { createSpaceTestFixture as fixture } from "./spaces.test-fixtures.js";

describe("Space conversation browser authority", () => {
  it.each(["chat.send", "sessions.send", "sessions.steer"] as const)(
    "cancels a native send admitted during membership revocation (%s)",
    async (sendMethod) => {
      const f = await fixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
      const conversation = await create(f);
      const original = f.request.getMockImplementation()!;
      let release!: () => void;
      f.request.mockImplementation(async (method, params) => {
        if (method === sendMethod) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: "started" };
        }
        return original(method, params);
      });
      const sending = f.proxy.request(f.alice.token, sendMethod, {
        ...(sendMethod === "chat.send"
          ? { sessionKey: conversation.sessionKey }
          : { key: conversation.sessionKey }),
        message: "run",
        idempotencyKey: "race",
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
      release();
      await expect(sending).rejects.toThrow("unavailable");
      expect(f.request).toHaveBeenLastCalledWith("chat.abort", {
        sessionKey: conversation.sessionKey,
        agentId: conversation.agentId,
        runId: "race",
      });
      expect(
        await f.proxy.filterEvent(f.alice.token, {
          event: "chat",
          payload: {
            sessionKey: conversation.sessionKey,
            message: { content: "after revoke" },
          },
        }),
      ).toBeNull();
    },
  );

  it.each(["chat.send", "sessions.send", "sessions.steer"] as const)(
    "fences a pending old admission after remove and re-add without cancelling a newer run (%s)",
    async (sendMethod) => {
      const f = await fixture();
      f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
      const conversation = await create(f);
      const original = f.request.getMockImplementation()!;
      let release!: () => void;
      f.request.mockImplementation(async (method, params) => {
        if (
          method === sendMethod &&
          (params as { idempotencyKey?: string }).idempotencyKey === "old-admission"
        ) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: "started", runId: "old-admission" };
        }
        return original(method, params);
      });
      const old = f.proxy.request(f.alice.token, sendMethod, {
        ...(sendMethod === "chat.send"
          ? { sessionKey: conversation.sessionKey }
          : { key: conversation.sessionKey }),
        message: "old",
        idempotencyKey: "old-admission",
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "editor", 3);
      await f.proxy.request(f.alice.token, sendMethod, {
        ...(sendMethod === "chat.send"
          ? { sessionKey: conversation.sessionKey }
          : { key: conversation.sessionKey }),
        message: "new authorization",
        idempotencyKey: "new-admission",
      });
      release();
      await expect(old).rejects.toThrow("membership changed");
      expect(f.request).toHaveBeenLastCalledWith("chat.abort", {
        sessionKey: conversation.sessionKey,
        agentId: conversation.agentId,
        runId: "old-admission",
      });
      expect(f.request).not.toHaveBeenCalledWith("sessions.abort", expect.anything());
    },
  );

  it.each([
    "artifacts.get",
    "sessions.compaction.get",
    "sessions.usage.logs",
    "sessions.usage.timeseries",
  ] as const)("allows an own Viewer to use %s while rejecting peer access", async (method) => {
    const f = await fixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
    const conversation = await create(f);
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    const key = conversation.sessionKey;
    const checkpoint = {
      checkpointId: "checkpoint-1",
      sessionKey: key,
      sessionId: "session-1",
      createdAt: 1,
      reason: "manual",
      preCompaction: { sessionId: "session-1" },
      postCompaction: { sessionId: "session-1" },
    };
    const request =
      method === "artifacts.get"
        ? { sessionKey: key, artifactId: "artifact-1" }
        : method === "sessions.compaction.get"
          ? { key, checkpointId: checkpoint.checkpointId }
          : { key };
    const result =
      method === "artifacts.get"
        ? {
            artifact: {
              id: "artifact-1",
              sessionKey: key,
              type: "file",
              title: "report",
              download: { mode: "unsupported" },
            },
          }
        : method === "sessions.compaction.get"
          ? { ok: true, key, checkpoint }
          : method === "sessions.usage.logs"
            ? { logs: [] }
            : { points: [] };
    f.request.mockResolvedValueOnce(result);
    await expect(f.proxy.request(f.alice.token, method, request)).resolves.toEqual(result);
    const calls = f.request.mock.calls.length;
    await expect(f.proxy.request(f.bob.token, method, request)).rejects.toThrow("unavailable");
    expect(f.request).toHaveBeenCalledTimes(calls);
  });
});
