import { describe, expect, it } from "vitest";
import { SpaceNativeSessionGuard } from "./space-native-session-guard.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";

async function fixture() {
  const f = await createSpaceTestFixture();
  f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "owner", 1);
  const conversation = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
    pageId: f.page.id,
    title: "Alice investigation",
    requestId: "native-guard",
  });
  const privateKey = `agent:${f.alice.binding.agentId}:private`;
  const nativeId = "1b0113dc-f0b5-43a7-98c9-6b7c550bfa17";
  f.request.mockImplementation(async (method, raw) => {
    const params = raw as Record<string, unknown>;
    if (method === "sessions.resolve") {
      if (params.label === "Ambiguous") {
        throw new Error("Multiple sessions found");
      }
      if (
        params.key === "saved-alias" ||
        params.label === conversation.title ||
        params.sessionId === nativeId
      ) {
        return { ok: true, key: conversation.sessionKey };
      }
      if (params.key === conversation.sessionKey || params.key === privateKey) {
        return { ok: true, key: params.key };
      }
      return { ok: false };
    }
    if (method === "chat.history") {
      return {
        messages: [
          {
            role: "assistant",
            content: "Shared final answer",
            __openclaw: { id: "answer" },
          },
          { role: "toolResult", content: "Private raw output", __openclaw: { id: "tool" } },
        ],
      };
    }
    return { results: [] };
  });
  const guard = new SpaceNativeSessionGuard(f.store.spaces, { request: f.request });
  const caller = {
    agentId: f.alice.binding.agentId,
    sessionKey: privateKey,
    nativeTool: "sessions_history",
    broad: true,
  };
  return { ...f, guard, conversation, privateKey, nativeId, caller };
}

describe("native session tools at the Space registry boundary", () => {
  it("rejects peer raw history through exact keys, aliases, ids and labels while allowing Q&A recall", async () => {
    const f = await fixture();
    for (const selector of [
      { targetSessionKey: f.conversation.sessionKey },
      { targetSessionKey: "saved-alias" },
      { targetSessionKey: f.nativeId },
      { targetLabel: f.conversation.title, targetAgentId: f.alice.binding.agentId },
    ]) {
      await expect(
        f.guard.authorize({ ...f.caller, agentId: f.bob.binding.agentId, ...selector }),
      ).rejects.toThrow("unavailable");
    }
    expect(f.request.mock.calls.every(([method]) => method === "sessions.resolve")).toBe(true);
    const recalled = await f.service.agentRead({
      agentId: f.bob.binding.agentId,
      operation: "get",
      spaceId: f.space.id,
      pageId: f.page.id,
      conversationId: f.conversation.id,
    });
    expect(JSON.stringify(recalled)).toContain("Shared final answer");
    expect(JSON.stringify(recalled)).not.toContain("Private raw output");
  });

  it("canonicalizes authorized aliases and leaves unrelated native targets available", async () => {
    const f = await fixture();
    await expect(
      f.guard.authorize({
        ...f.caller,
        sessionKey: f.conversation.sessionKey,
        targetSessionKey: f.nativeId,
      }),
    ).resolves.toEqual({ sessionKey: f.conversation.sessionKey });
    await expect(f.guard.authorize({ ...f.caller, targetSessionKey: "current" })).resolves.toEqual({
      sessionKey: f.privateKey,
    });
    await expect(
      f.guard.authorize({ ...f.caller, targetSessionKey: "openclaw-control-ui" }),
    ).resolves.toEqual({ sessionKey: f.privateKey });
    const newKey = `agent:${f.alice.binding.agentId}:new-private-task`;
    await expect(
      f.guard.authorize({ ...f.caller, nativeTool: "sessions_send", targetSessionKey: newKey }),
    ).resolves.toEqual({ sessionKey: newKey });
    await expect(
      f.guard.authorize({
        ...f.caller,
        agentId: "generic-helper",
        targetSessionKey: f.privateKey,
      }),
    ).resolves.toEqual({ sessionKey: f.privateKey });
    await expect(
      f.guard.authorize({
        ...f.caller,
        agentId: "generic-helper",
        targetSessionKey: f.conversation.sessionKey,
      }),
    ).rejects.toThrow("unavailable");
  });

  it("rejects ambiguous, missing and unregistered reserved references", async () => {
    const f = await fixture();
    for (const selector of [
      { targetLabel: "Ambiguous" },
      { targetSessionKey: "missing-session" },
      { targetSessionKey: `agent:${f.alice.binding.agentId}:space-session:unregistered` },
    ]) {
      await expect(f.guard.authorize({ ...f.caller, ...selector })).rejects.toThrow("target");
    }
  });

  it("rejects exact legacy Space page sessions through native raw tools", async () => {
    const f = await fixture();
    const legacy = `agent:${f.space.agentId}:space:${f.page.id}`;
    f.request.mockImplementationOnce(async (method, raw) => {
      if (method === "sessions.resolve" && (raw as { key?: unknown }).key === legacy) {
        return { ok: true, key: legacy };
      }
      return { ok: false };
    });

    await expect(f.guard.authorize({ ...f.caller, targetSessionKey: legacy })).rejects.toThrow(
      "Legacy Space raw sessions are private",
    );
  });

  it("rejects exact descendants of current and legacy Space roots before raw history", async () => {
    const f = await fixture();
    const child = `agent:${f.alice.binding.agentId}:subagent:space-child`;
    const grandchild = `agent:${f.alice.binding.agentId}:subagent:space-grandchild`;
    const legacy = `agent:${f.space.agentId}:space:${f.page.id}`;
    const legacyChild = `agent:${f.alice.binding.agentId}:subagent:legacy-space-child`;
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method !== "sessions.resolve") {
        return { results: [] };
      }
      if (params.key === child) {
        return params.includeLineage === true
          ? {
              ok: true,
              key: child,
              lineage: {
                parentSessionKey: f.conversation.sessionKey,
                spawnedBy: f.conversation.sessionKey,
              },
            }
          : { ok: true, key: child };
      }
      if (params.key === grandchild) {
        return params.includeLineage === true
          ? { ok: true, key: grandchild, lineage: { parentSessionKey: child, spawnedBy: child } }
          : { ok: true, key: grandchild };
      }
      if (params.key === legacyChild) {
        return params.includeLineage === true
          ? { ok: true, key: legacyChild, lineage: { parentSessionKey: legacy } }
          : { ok: true, key: legacyChild };
      }
      if (params.key === f.conversation.sessionKey || params.key === legacy) {
        return { ok: true, key: params.key, lineage: {} };
      }
      return { ok: false };
    });

    for (const targetSessionKey of [child, grandchild, legacyChild]) {
      await expect(f.guard.authorize({ ...f.caller, targetSessionKey })).rejects.toThrow(
        "Space descendant raw sessions are private",
      );
    }
  });

  it("keeps an ordinary child chain available when verified ancestry is non-Space", async () => {
    const f = await fixture();
    const parent = "global";
    const child = `agent:${f.alice.binding.agentId}:ordinary-child`;
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method !== "sessions.resolve") {
        return { results: [] };
      }
      if (params.key === child) {
        return params.includeLineage === true
          ? {
              ok: true,
              key: child,
              lineage: {
                parentSessionKey: parent,
                parentSessionAgentId: f.alice.binding.agentId,
              },
            }
          : { ok: true, key: child };
      }
      if (params.key === parent) {
        expect(params.agentId).toBe(f.alice.binding.agentId);
        return { ok: true, key: parent, lineage: {} };
      }
      return { ok: false };
    });

    await expect(f.guard.authorize({ ...f.caller, targetSessionKey: child })).resolves.toEqual({
      sessionKey: child,
    });
  });

  it("keeps cross-agent bare parent ancestry on the requester agent store", async () => {
    const f = await fixture();
    const child = "agent:worker:ordinary-child";
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method !== "sessions.resolve") {
        return { results: [] };
      }
      if (params.key === child) {
        return params.includeLineage === true
          ? {
              ok: true,
              key: child,
              lineage: {
                parentSessionKey: "global",
                parentSessionAgentId: f.alice.binding.agentId,
              },
            }
          : { ok: true, key: child };
      }
      if (params.key === "global") {
        expect(params.agentId).toBe(f.alice.binding.agentId);
        return { ok: true, key: "global", lineage: {} };
      }
      return { ok: false };
    });

    await expect(f.guard.authorize({ ...f.caller, targetSessionKey: child })).resolves.toEqual({
      sessionKey: child,
    });
  });

  it("resolves ordinary cross-agent children by ID while respecting an explicit agent filter", async () => {
    const f = await fixture();
    const child = "agent:worker:subagent:child";
    const childId = "20faf8ba-d18f-4e84-8c8c-6957043d9086";
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method !== "sessions.resolve") {
        return { results: [] };
      }
      if (params.sessionId === childId) {
        return params.agentId === undefined || params.agentId === "worker"
          ? { ok: true, key: child }
          : { ok: false };
      }
      if (params.key === child) {
        return { ok: true, key: child, lineage: { parentSessionKey: f.privateKey } };
      }
      if (params.key === f.privateKey) {
        return { ok: true, key: f.privateKey, lineage: {} };
      }
      return { ok: false };
    });

    for (const targetAgentId of [undefined, "worker"]) {
      await expect(
        f.guard.authorize({ ...f.caller, targetSessionKey: childId, targetAgentId }),
      ).resolves.toEqual({ sessionKey: child });
    }
    await expect(
      f.guard.authorize({
        ...f.caller,
        targetSessionKey: childId,
        targetAgentId: f.alice.binding.agentId,
      }),
    ).rejects.toThrow("Session target unavailable");
  });

  it.each(["sessions_send", "sessions"])(
    "%s keeps ordinary bare global targets on the default store",
    async (nativeTool) => {
      const f = await fixture();
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        if (method !== "sessions.resolve" || params.key !== "global") {
          return { ok: false };
        }
        expect(params.agentId).toBeUndefined();
        return { ok: true, key: "global", lineage: {} };
      });

      for (const targetAgentId of [undefined, f.alice.binding.agentId]) {
        await expect(
          f.guard.authorize({
            ...f.caller,
            nativeTool,
            nativeAction: "patch",
            targetSessionKey: "global",
            targetAgentId,
          }),
        ).resolves.toEqual({ sessionKey: "global" });
      }
    },
  );

  it.each(["sessions_send", "sessions"])(
    "%s checks Space ancestry in the default bare-key store",
    async (nativeTool) => {
      const f = await fixture();
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        if (method !== "sessions.resolve" || params.key !== "global") {
          return { ok: false };
        }
        return {
          ok: true,
          key: "global",
          lineage: params.agentId ? {} : { parentSessionKey: f.conversation.sessionKey },
        };
      });

      await expect(
        f.guard.authorize({ ...f.caller, nativeTool, targetSessionKey: "global" }),
      ).rejects.toThrow("descendant raw sessions are private");
    },
  );

  it.each(["label", "sessionId"])(
    "keeps a send's %s lookup filter separate from bare-key dispatch ownership",
    async (selector) => {
      const f = await fixture();
      const value = "global-reference";
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        if (method !== "sessions.resolve") {
          return { ok: false };
        }
        if (params[selector] === value) {
          expect(params.agentId).toBe(f.alice.binding.agentId);
          return { ok: true, key: "global" };
        }
        if (params.key === "global") {
          expect(params.agentId).toBeUndefined();
          return {
            ok: true,
            key: "global",
            lineage: { parentSessionKey: f.conversation.sessionKey },
          };
        }
        return { ok: false };
      });

      await expect(
        f.guard.authorize({
          ...f.caller,
          nativeTool: "sessions_send",
          targetAgentId: f.alice.binding.agentId,
          ...(selector === "label" ? { targetLabel: value } : { targetSessionKey: value }),
        }),
      ).rejects.toThrow("descendant raw sessions are private");
    },
  );

  it.each(["sessions_search", "session_status"])(
    "%s checks resolved bare keys in the requester store regardless of lookup filter",
    async (nativeTool) => {
      const f = await fixture();
      const value = "global-reference";
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        if (method !== "sessions.resolve") {
          return { ok: false };
        }
        if (params.sessionId === value) {
          expect(params.agentId).toBe("worker");
          return { ok: true, key: "global" };
        }
        if (params.key === "global") {
          expect(params.agentId).toBe(f.alice.binding.agentId);
          return {
            ok: true,
            key: "global",
            lineage: { parentSessionKey: f.conversation.sessionKey },
          };
        }
        return { ok: false };
      });

      await expect(
        f.guard.authorize({
          ...f.caller,
          nativeTool,
          targetSessionKey: value,
          targetAgentId: "worker",
        }),
      ).rejects.toThrow("descendant raw sessions are private");
    },
  );

  it.each([
    { sessionKey: "agent:main:main", agentId: "main", spaceDescendant: false },
    { sessionKey: "agent:main:main", agentId: "main", spaceDescendant: true },
    { sessionKey: "global", agentId: undefined, spaceDescendant: false },
    { sessionKey: "global", agentId: undefined, spaceDescendant: true },
  ])(
    "status uses $sessionKey ownership despite a hook agent override (Space descendant=$spaceDescendant)",
    async ({ sessionKey, agentId, spaceDescendant }) => {
      const f = await fixture();
      f.request.mockImplementation(async (method, raw) => {
        const params = raw as Record<string, unknown>;
        if (method !== "sessions.resolve" || params.key !== "global") {
          return { ok: false };
        }
        expect(params.agentId).toBe(agentId);
        return {
          ok: true,
          key: "global",
          lineage: spaceDescendant ? { parentSessionKey: f.conversation.sessionKey } : {},
        };
      });

      const authorization = f.guard.authorize({
        ...f.caller,
        sessionKey,
        nativeTool: "session_status",
        targetSessionKey: "global",
        targetAgentId: "worker",
      });
      if (spaceDescendant) {
        await expect(authorization).rejects.toThrow("descendant raw sessions are private");
      } else {
        await expect(authorization).resolves.toEqual({
          sessionKey: "global",
          ...(agentId ? { agentId } : {}),
        });
      }
      expect(f.request).toHaveBeenCalledWith("sessions.resolve", {
        key: "global",
        allowMissing: true,
        includeLineage: true,
        ...(agentId ? { agentId } : {}),
      });
    },
  );

  it("pins bare global authorization to the caller agent store", async () => {
    const f = await fixture();
    f.request.mockImplementation(async (method, raw) => {
      const params = raw as Record<string, unknown>;
      if (method !== "sessions.resolve" || params.key !== "global") {
        return { ok: false };
      }
      expect(params.agentId).toBe(f.alice.binding.agentId);
      return params.includeLineage === true
        ? { ok: true, key: "global", lineage: {} }
        : { ok: true, key: "global" };
    });

    await expect(f.guard.authorize({ ...f.caller, targetSessionKey: "global" })).resolves.toEqual({
      sessionKey: "global",
      agentId: f.alice.binding.agentId,
    });
  });

  it("blocks widened queries and revoked default-tree children without disabling normal own trees", async () => {
    const f = await fixture();
    for (const nativeTool of ["sessions_list", "sessions_search"]) {
      await expect(f.guard.authorize({ ...f.caller, nativeTool })).rejects.toThrow(
        "broad native query",
      );
      await expect(f.guard.authorize({ ...f.caller, nativeTool, broad: false })).resolves.toEqual(
        {},
      );
      await expect(
        f.guard.authorize({ ...f.caller, nativeTool, agentId: f.bob.binding.agentId }),
      ).rejects.toThrow("broad native query");
      await expect(
        f.guard.authorize({
          ...f.caller,
          nativeTool,
          agentId: f.bob.binding.agentId,
          targetAgentId: f.bob.binding.agentId,
        }),
      ).rejects.toThrow("broad native query");
      await expect(
        f.guard.authorize({
          ...f.caller,
          nativeTool,
          agentId: f.bob.binding.agentId,
          broad: false,
        }),
      ).resolves.toEqual({});
    }
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
    await expect(
      f.guard.authorize({ ...f.caller, nativeTool: "sessions_list", broad: false }),
    ).rejects.toThrow("broad native query");
    await expect(
      f.guard.authorize({ ...f.caller, targetSessionKey: f.conversation.sessionKey }),
    ).rejects.toThrow("unavailable");
  });

  it("requires current editor authority for mutations and retains registered history", async () => {
    const f = await fixture();
    const request = {
      ...f.caller,
      sessionKey: f.conversation.sessionKey,
      targetSessionKey: f.conversation.sessionKey,
    };
    await expect(
      f.guard.authorize({ ...f.caller, targetSessionKey: f.conversation.sessionKey }),
    ).rejects.toThrow("cross-session native tools");
    for (const nativeAction of ["reset", "delete"]) {
      await expect(
        f.guard.authorize({ ...request, nativeTool: "sessions", nativeAction }),
      ).rejects.toThrow("retained");
    }
    f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, "viewer", 2);
    await expect(f.guard.authorize(request)).rejects.toThrow("read-only");
    for (const nativeTool of ["sessions_send", "sessions", "session_status"]) {
      await expect(
        f.guard.authorize({ ...request, nativeTool, nativeAction: "patch" }),
      ).rejects.toThrow("read-only");
    }
    await expect(
      f.guard.authorize({
        ...f.caller,
        sessionKey: f.conversation.sessionKey,
        targetSessionKey: f.privateKey,
      }),
    ).rejects.toThrow("read-only");
  });

  it("blocks spawning another employee's personal runtime but keeps own and generic helpers", async () => {
    const f = await fixture();
    for (const targetAgentId of [f.bob.binding.agentId, f.bob.binding.agentId.toUpperCase()]) {
      await expect(
        f.guard.authorize({ ...f.caller, nativeTool: "sessions_spawn", targetAgentId }),
      ).rejects.toThrow("another employee");
    }
    for (const targetAgentId of [
      undefined,
      f.alice.binding.agentId,
      f.alice.binding.agentId.toUpperCase(),
      "generic-helper",
    ]) {
      await expect(
        f.guard.authorize({ ...f.caller, nativeTool: "sessions_spawn", targetAgentId }),
      ).resolves.toEqual({});
    }
  });

  it("revalidates actor and membership after an asynchronous resolution", async () => {
    const f = await fixture();
    f.request.mockImplementationOnce(async () => {
      f.store.spaces.setMember(f.bob.user.id, f.space.id, f.alice.user.id, null, 2);
      return { ok: true, key: f.conversation.sessionKey };
    });
    await expect(
      f.guard.authorize({
        ...f.caller,
        sessionKey: f.conversation.sessionKey,
        targetSessionKey: f.conversation.sessionKey,
      }),
    ).rejects.toThrow("unavailable");
  });
});
