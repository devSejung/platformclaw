import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy personal session messaging", () => {
  for (const method of ["sessions.send", "sessions.steer"] as const) {
    it(`${method} preserves a successful native stop acknowledgement`, async () => {
      const { binding, proxy, request, token } = await setup();
      request.mockImplementation(async (rpcMethod) =>
        rpcMethod === "chat.metadata"
          ? { commands: [{ name: "stop", source: "native", category: "session" }] }
          : { ok: true, aborted: true, runIds: ["own-run"], privatePath: "/private/state" },
      );
      await expect(
        proxy.request(token, method, {
          key: `agent:${binding.agentId}:main`,
          message: "/stop",
          idempotencyKey: "stop-1",
        }),
      ).resolves.toEqual({ ok: true, aborted: true, runIds: ["own-run"] });
    });

    it(`${method} preserves delivery, sender, command, and acknowledgement boundaries`, async () => {
      const { binding, proxy, request, token, user } = await setup();
      const key = `agent:${binding.agentId}:main`;
      const attachments = [{ type: "file", mimeType: "text/plain", content: "aGVsbG8=" }];
      request.mockResolvedValueOnce({
        status: "started",
        runId: "run-1",
        messageSeq: 4,
        interruptedActiveRun: true,
        privatePath: "/private/state",
      });

      await expect(
        proxy.request(token, method, {
          key,
          message: "Explain /config without running it",
          attachments,
          thinking: "low",
          timeoutMs: 10_000,
          idempotencyKey: "run-1",
        }),
      ).resolves.toEqual({
        status: "started",
        runId: "run-1",
        messageSeq: 4,
        interruptedActiveRun: true,
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(method, {
        key,
        agentId: binding.agentId,
        message: "Explain /config without running it",
        attachments,
        thinking: "low",
        timeoutMs: 10_000,
        idempotencyKey: "run-1",
        deliver: false,
        suppressCommandInterpretation: true,
        senderAttribution: {
          id: user.accountId,
          name: user.displayName,
          profileId: user.id,
          agentId: binding.agentId,
          isOwner: false,
        },
      });
    });

    it(`${method} rejects foreign sessions, forged relay controls, and administration commands`, async () => {
      const { binding, proxy, request, token } = await setup();
      const key = `agent:${binding.agentId}:main`;
      await expect(
        proxy.request(token, method, { key: "agent:other:main", message: "hello" }),
      ).rejects.toMatchObject({ code: "cross-agent-denied" });
      for (const field of ["senderAttribution", "suppressCommandInterpretation", "deliver"]) {
        await expect(
          proxy.request(token, method, { key, message: "hello", [field]: true }),
        ).rejects.toMatchObject({ code: "method-not-allowed" });
      }
      await expect(
        proxy.request(token, method, { key, message: "/restart" }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
      expect(request).not.toHaveBeenCalled();
    });
  }

  it("creates a session with a configured model and rejects an unavailable selection", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:dashboard:model`;
    request.mockImplementation(async (method) =>
      method === "models.list"
        ? { models: [{ id: "company-model", provider: "company" }] }
        : { ok: true, key },
    );
    await expect(
      proxy.request(token, "sessions.create", { key, model: "company/company-model" }),
    ).resolves.toEqual({ ok: true, key });
    expect(request).toHaveBeenLastCalledWith("sessions.create", {
      key,
      model: "company/company-model",
      agentId: binding.agentId,
      emitCommandHooks: false,
    });
    request.mockClear();
    await expect(
      proxy.request(token, "sessions.create", { key, model: "other/unavailable" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).toHaveBeenCalledExactlyOnceWith("models.list", { view: "configured" });
  });
});
