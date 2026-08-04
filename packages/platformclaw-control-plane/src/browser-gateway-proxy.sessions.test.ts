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

    await expect(proxy.request(token, "sessions.patch", { key, archived: true })).resolves.toEqual({
      ok: true,
      key,
    });
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
      ["sessions.patch", { key, archived: true, agentId: binding.agentId }],
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
      proxy.request(token, "sessions.compact", { key, maxLines: 20 }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });
});
