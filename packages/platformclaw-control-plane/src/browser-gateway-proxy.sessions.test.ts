import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy session lifecycle", () => {
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

  it("allows rewind only for a PlatformClaw administrator", async () => {
    const member = await setup();
    const memberKey = `agent:${member.binding.agentId}:main`;
    await expect(
      member.proxy.request(member.token, "sessions.rewind", {
        sessionKey: memberKey,
        entryId: "entry-1",
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });

    const admin = await setup({ admin: true });
    const adminKey = `agent:${admin.binding.agentId}:main`;
    admin.request.mockResolvedValueOnce({ editorText: "retry", privatePath: "/srv/private" });
    await expect(
      admin.proxy.request(admin.token, "sessions.rewind", {
        sessionKey: adminKey,
        entryId: "entry-1",
      }),
    ).resolves.toEqual({ editorText: "retry" });
    expect(admin.request).toHaveBeenCalledWith("sessions.rewind", {
      sessionKey: adminKey,
      entryId: "entry-1",
      agentId: admin.binding.agentId,
    });
  });
});
