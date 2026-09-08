import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy session lifecycle", () => {
  it("keeps owned session reads while removing cross-agent ACP child lineage", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:dashboard:f63ef63b-0aaa-4000-8000-000000000001`;
    const ownedChild = `agent:${binding.agentId}:subagent:child`;
    const acpChild = "agent:claude:acp:foreign-child";
    const parentSessionKey = `agent:${binding.agentId}:main`;
    const forkSource = { sessionKey: parentSessionKey, sessionId: "source-session" };
    const session = {
      key,
      agentId: binding.agentId,
      displayName: "ACP parent",
      parentSessionKey,
      spawnedBy: "agent:claude:acp:controller",
      controlOwnerSessionKey: acpChild,
      childSessionKey: 42,
      forkSource,
      childSessions: [ownedChild, acpChild, 42],
    };
    const originalSession = structuredClone(session);
    const projectedSession = {
      key,
      agentId: binding.agentId,
      displayName: "ACP parent",
      parentSessionKey,
      forkSource,
      childSessions: [ownedChild],
    };
    request
      .mockResolvedValueOnce({ total: 1, sessions: [session] })
      .mockResolvedValueOnce({ session });

    await expect(
      proxy.request(token, "sessions.list", {
        agentId: binding.agentId,
        archived: "all",
        search: "f63ef63b",
      }),
    ).resolves.toEqual({
      total: 1,
      sessions: [projectedSession],
    });
    expect(request).toHaveBeenLastCalledWith("sessions.list", {
      agentId: binding.agentId,
      archived: "all",
      search: "f63ef63b",
      includeGlobal: false,
      includeUnknown: false,
      configuredAgentsOnly: true,
    });
    await expect(proxy.request(token, "sessions.describe", { key })).resolves.toEqual({
      session: projectedSession,
    });
    expect(session).toEqual(originalSession);
  });

  it("rejects malformed session lists instead of showing an empty sidebar", async () => {
    const { proxy, request, token } = await setup();
    request
      .mockResolvedValueOnce({ total: 0 })
      .mockResolvedValueOnce({ total: 0, sessions: { key: "invalid" } });

    await expect(proxy.request(token, "sessions.list", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(proxy.request(token, "sessions.list", {})).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("still rejects foreign or malformed primary session records", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    const foreignSession = {
      key: "agent:other:main",
      agentId: "other",
      childSessions: [`agent:${binding.agentId}:subagent:child`],
    };
    request
      .mockResolvedValueOnce({ total: 1, sessions: [foreignSession] })
      .mockResolvedValueOnce({ total: 1, sessions: [{ agentId: binding.agentId }] })
      .mockResolvedValueOnce({ total: 1, sessions: [{ key: 42, agentId: binding.agentId }] })
      .mockResolvedValueOnce({
        total: 1,
        sessions: [{ key, agentId: 42 }],
      })
      .mockResolvedValueOnce({ session: foreignSession })
      .mockResolvedValueOnce({
        session: { key, agentId: binding.agentId, childSessions: { key: "invalid" } },
      });

    for (let index = 0; index < 4; index += 1) {
      await expect(proxy.request(token, "sessions.list", {})).rejects.toMatchObject({
        code: "upstream-result-denied",
      });
    }
    await expect(proxy.request(token, "sessions.describe", { key })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(proxy.request(token, "sessions.describe", { key })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("projects nested session change events and rejects unscoped or malformed events", async () => {
    const { binding, proxy, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const ownedChild = `agent:${binding.agentId}:child`;
    const event = {
      event: "sessions.changed",
      payload: {
        sessionKey,
        agentId: binding.agentId,
        childSessions: [ownedChild, "agent:other:outer-child"],
        session: {
          key: sessionKey,
          agentId: binding.agentId,
          controlOwnerSessionKey: "agent:other:controller",
          forkSource: { sessionKey: "agent:other:source", sessionId: "source-session" },
          childSessions: [ownedChild, "agent:other:nested-child"],
        },
      },
    };
    const originalEvent = structuredClone(event);

    await expect(proxy.filterEvent(token, event)).resolves.toEqual({
      event: "sessions.changed",
      payload: {
        sessionKey,
        agentId: binding.agentId,
        childSessions: [ownedChild],
        session: { key: sessionKey, agentId: binding.agentId, childSessions: [ownedChild] },
      },
    });
    expect(event).toEqual(originalEvent);
    for (const payload of [
      { agentId: binding.agentId },
      { sessionKey: 42, agentId: binding.agentId },
      { sessionKey, agentId: binding.agentId, childSessions: { key: "invalid" } },
      {
        sessionKey,
        agentId: binding.agentId,
        session: { agentId: binding.agentId },
      },
      {
        sessionKey: "agent:other:main",
        agentId: "other",
        childSessions: [ownedChild],
      },
    ]) {
      await expect(
        proxy.filterEvent(token, {
          event: "sessions.changed",
          payload,
        }),
      ).resolves.toBeNull();
    }
  });

  it("projects session metadata in chat history and startup without mutating Gateway rows", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    const ownedChild = `agent:${binding.agentId}:child`;
    const sessionInfo = {
      key,
      agentId: binding.agentId,
      spawnedBy: "agent:other:controller",
      controlOwnerSessionKey: 42,
      forkSource: { sessionKey: 42, sessionId: "source-session" },
      childSessions: [ownedChild, "agent:other:child"],
    };
    const originalSessionInfo = structuredClone(sessionInfo);
    const projectedSessionInfo = {
      key,
      agentId: binding.agentId,
      childSessions: [ownedChild],
    };
    request
      .mockResolvedValueOnce({ sessionKey: key, messages: [], sessionInfo })
      .mockResolvedValueOnce({
        sessionKey: key,
        messages: [],
        sessionInfo,
        agentsList: { defaultId: "other", agents: [{ id: binding.agentId }, { id: "other" }] },
      })
      .mockResolvedValueOnce({
        sessionKey: key,
        messages: [],
        sessionInfo: { key: "agent:other:main", agentId: "other" },
      });

    await expect(proxy.request(token, "chat.history", { sessionKey: key })).resolves.toEqual({
      sessionKey: key,
      messages: [],
      sessionInfo: projectedSessionInfo,
    });
    await expect(proxy.request(token, "chat.startup", { sessionKey: key })).resolves.toEqual({
      sessionKey: key,
      messages: [],
      sessionInfo: projectedSessionInfo,
      agentsList: { defaultId: binding.agentId, agents: [{ id: binding.agentId }] },
    });
    expect(sessionInfo).toEqual(originalSessionInfo);
    await expect(proxy.request(token, "chat.history", { sessionKey: key })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
  });

  it("allows owned session archive, restore, and direct deletion", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:thread`;
    request
      .mockResolvedValueOnce({ ok: true, key })
      .mockResolvedValueOnce({ ok: true, key })
      .mockResolvedValueOnce({
        ok: true,
        deleted: true,
        archivedTranscripts: ["/private/transcript.jsonl"],
      });

    await expect(
      proxy.request(token, "sessions.patch", { key, archived: true, boardFace: "dashboard" }),
    ).resolves.toEqual({ ok: true, key });
    await expect(proxy.request(token, "sessions.patch", { key, archived: false })).resolves.toEqual(
      { ok: true, key },
    );
    await expect(
      proxy.request(token, "sessions.delete", {
        key,
        deleteTranscript: true,
      }),
    ).resolves.toEqual({ deleted: true });

    expect(request.mock.calls).toEqual([
      ["sessions.patch", { key, archived: true, boardFace: "dashboard", agentId: binding.agentId }],
      ["sessions.patch", { key, archived: false, agentId: binding.agentId }],
      ["sessions.delete", { key, deleteTranscript: true, agentId: binding.agentId }],
    ]);
  });

  it("rejects cross-agent and privileged browser session deletion", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:thread`;

    await expect(
      proxy.request(token, "sessions.delete", {
        key: "agent:other:thread",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "sessions.delete", {
        key,
        emitLifecycleHooks: false,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it("allows compact, reset, and hard steer only for an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:thread`;
    request
      .mockResolvedValueOnce({ ok: true, key, compacted: true, result: { tokensAfter: 1200 } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ status: "started", runId: "redirect-run" });

    await expect(proxy.request(token, "sessions.compact", { key })).resolves.toMatchObject({
      compacted: true,
    });
    await expect(proxy.request(token, "sessions.reset", { key, reason: "reset" })).resolves.toEqual(
      {},
    );
    await expect(
      proxy.request(token, "sessions.steer", { key, message: "restart with this" }),
    ).resolves.toEqual({ status: "started", runId: "redirect-run" });

    expect(request.mock.calls).toEqual([
      ["sessions.compact", { key, agentId: binding.agentId }],
      ["sessions.reset", { key, reason: "reset", agentId: binding.agentId }],
      ["sessions.steer", { key, message: "restart with this", agentId: binding.agentId }],
    ]);

    await expect(
      proxy.request(token, "sessions.compact", { key: "agent:other:thread" }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "sessions.steer", {
        key: "agent:other:thread",
        message: "cross the boundary",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "sessions.compact", { key, maxLines: 20 }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("allows owned forks and rejects foreign fork results", async () => {
    const { binding, proxy, request, token } = await setup();
    const source = `agent:${binding.agentId}:source`;
    const fork = `agent:${binding.agentId}:fork`;
    request
      .mockResolvedValueOnce({
        sessionKey: fork,
        editorText: "continue",
        editorAttachments: [
          { mimeType: "image/png", data: "aGVsbG8=" },
          { mimeType: 42, data: "rejected" },
        ],
        privatePath: "/srv/private",
      })
      .mockResolvedValueOnce({ sessionKey: "agent:other:fork" });

    await expect(
      proxy.request(token, "sessions.fork", { sessionKey: source, entryId: "entry-1" }),
    ).resolves.toEqual({
      sessionKey: fork,
      editorText: "continue",
      editorAttachments: [{ mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(request).toHaveBeenNthCalledWith(1, "sessions.fork", {
      sessionKey: source,
      entryId: "entry-1",
      agentId: binding.agentId,
    });
    await expect(
      proxy.request(token, "sessions.fork", { sessionKey: source, entryId: "entry-2" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
    await expect(
      proxy.request(token, "sessions.fork", {
        sessionKey: "agent:other:source",
        entryId: "entry-3",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });

  it("allows rewind only for an owned session", async () => {
    const member = await setup();
    const memberKey = `agent:${member.binding.agentId}:main`;
    member.request.mockResolvedValueOnce({ editorText: "retry", privatePath: "/srv/private" });
    await expect(
      member.proxy.request(member.token, "sessions.rewind", {
        sessionKey: memberKey,
        entryId: "entry-1",
      }),
    ).resolves.toEqual({ editorText: "retry" });
    expect(member.request).toHaveBeenCalledWith("sessions.rewind", {
      sessionKey: memberKey,
      entryId: "entry-1",
      agentId: member.binding.agentId,
    });
    await expect(
      member.proxy.request(member.token, "sessions.rewind", {
        sessionKey: "agent:other:main",
        entryId: "entry-2",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });

  it("allows read-only files only inside an owned Agent workspace", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        sessionKey,
        root: "/srv/private/workspace",
        gitCheckout: true,
        files: [{ path: "notes.md", name: "notes.md", kind: "read", missing: false }],
        browser: {
          path: "",
          entries: [{ path: "notes.md", name: "notes.md", kind: "file" }],
        },
        privatePath: "/srv/private",
      })
      .mockResolvedValueOnce({
        sessionKey,
        root: "/srv/private/workspace",
        file: {
          path: "notes.md",
          workspacePath: "notes.md",
          name: "notes.md",
          kind: "read",
          missing: false,
          content: "hello",
        },
      });

    await expect(
      proxy.request(token, "sessions.files.list", { sessionKey, path: "" }),
    ).resolves.toEqual({
      sessionKey,
      gitCheckout: true,
      files: [{ path: "notes.md", name: "notes.md", kind: "read", missing: false }],
      browser: {
        path: "",
        entries: [{ path: "notes.md", name: "notes.md", kind: "file" }],
      },
    });
    await expect(
      proxy.request(token, "sessions.files.get", { sessionKey, path: "notes.md" }),
    ).resolves.toEqual({
      sessionKey,
      file: {
        path: "notes.md",
        workspacePath: "notes.md",
        name: "notes.md",
        kind: "read",
        missing: false,
        content: "hello",
      },
    });
    expect(request.mock.calls).toEqual([
      ["sessions.files.list", { sessionKey, path: "", agentId: binding.agentId }],
      ["sessions.files.get", { sessionKey, path: "notes.md", agentId: binding.agentId }],
    ]);

    await expect(
      proxy.request(token, "sessions.files.get", {
        sessionKey: "agent:other:main",
        path: "notes.md",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "sessions.files.set", { sessionKey, path: "notes.md" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("allows owned session artifact listing and download", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    const artifact = {
      id: "artifact-1",
      type: "file",
      title: "report.pdf",
      mimeType: "application/pdf",
      sessionKey,
      download: { mode: "bytes" },
    };
    request
      .mockResolvedValueOnce({ artifacts: [{ ...artifact, privatePath: "/srv/private" }] })
      .mockResolvedValueOnce({
        artifact: { ...artifact, privatePath: "/srv/private" },
        encoding: "base64",
        data: "cGRm",
        privatePath: "/srv/private",
      });

    await expect(proxy.request(token, "artifacts.list", { sessionKey })).resolves.toEqual({
      artifacts: [artifact],
    });
    await expect(
      proxy.request(token, "artifacts.download", { sessionKey, artifactId: "artifact-1" }),
    ).resolves.toEqual({ artifact, encoding: "base64", data: "cGRm" });
    expect(request.mock.calls).toEqual([
      ["artifacts.list", { sessionKey, agentId: binding.agentId }],
      ["artifacts.download", { sessionKey, artifactId: "artifact-1", agentId: binding.agentId }],
    ]);

    await expect(
      proxy.request(token, "artifacts.list", { sessionKey, taskId: "foreign-task" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    await expect(
      proxy.request(token, "artifacts.download", {
        sessionKey: "agent:other:main",
        artifactId: "artifact-1",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });

  it("rejects foreign file and artifact results from the shared Gateway", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        sessionKey: "agent:other:main",
        files: [],
      })
      .mockResolvedValueOnce({
        artifacts: [
          {
            id: "artifact-1",
            type: "file",
            title: "foreign.txt",
            sessionKey: "agent:other:main",
            download: { mode: "bytes" },
          },
        ],
      })
      .mockResolvedValueOnce({
        artifacts: [
          {
            id: "artifact-without-owner",
            type: "file",
            title: "unowned.txt",
            download: { mode: "bytes" },
          },
        ],
      })
      .mockResolvedValueOnce({
        artifact: {
          id: "artifact-2",
          type: "file",
          title: "wrong.txt",
          sessionKey,
          download: { mode: "bytes" },
        },
        encoding: "base64",
        data: "d3Jvbmc=",
      });

    await expect(proxy.request(token, "sessions.files.list", { sessionKey })).rejects.toMatchObject(
      { code: "upstream-result-denied" },
    );
    await expect(proxy.request(token, "artifacts.list", { sessionKey })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(proxy.request(token, "artifacts.list", { sessionKey })).rejects.toMatchObject({
      code: "upstream-result-denied",
    });
    await expect(
      proxy.request(token, "artifacts.download", { sessionKey, artifactId: "artifact-1" }),
    ).rejects.toMatchObject({ code: "upstream-result-denied" });
  });
});
