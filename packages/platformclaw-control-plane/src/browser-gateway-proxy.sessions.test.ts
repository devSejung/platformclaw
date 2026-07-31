import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy session lifecycle", () => {
  it("allows owned session archive, restore, and archived-only deletion", async () => {
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
        archivedOnly: true,
      }),
    ).resolves.toEqual({ deleted: true });

    expect(request.mock.calls).toEqual([
      ["sessions.patch", { key, archived: true, agentId: binding.agentId }],
      ["sessions.patch", { key, archived: false, agentId: binding.agentId }],
      [
        "sessions.delete",
        { key, deleteTranscript: true, archivedOnly: true, agentId: binding.agentId },
      ],
    ]);
  });

  it("rejects active, cross-agent, and privileged browser session deletion", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:thread`;

    await expect(proxy.request(token, "sessions.delete", { key })).rejects.toMatchObject({
      code: "method-not-allowed",
    });
    await expect(
      proxy.request(token, "sessions.delete", {
        key: "agent:other:thread",
        archivedOnly: true,
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
    await expect(
      proxy.request(token, "sessions.delete", {
        key,
        archivedOnly: true,
        emitLifecycleHooks: false,
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });
});
