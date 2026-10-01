import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy model selection", () => {
  it("allows configured model selection only for an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        models: [{ id: "company/qwen", name: "Qwen", provider: "company", available: true }],
      })
      .mockResolvedValueOnce({ ok: true, key });

    await expect(
      proxy.request(token, "sessions.patch", { key, model: "company/qwen" }),
    ).resolves.toEqual({ ok: true, key });
    expect(request).toHaveBeenNthCalledWith(1, "models.list", { view: "configured" });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.patch", {
      key,
      agentId: binding.agentId,
      model: "company/qwen",
    });

    request.mockResolvedValueOnce({ models: [{ id: "company/qwen" }] });
    await expect(
      proxy.request(token, "sessions.patch", { key, model: "company/other" }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
  });

  it("accepts the provider-qualified model value produced by the upstream picker", async () => {
    const { binding, proxy, request, token } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        models: [{ id: "qwen", name: "Qwen", provider: "company", available: true }],
      })
      .mockResolvedValueOnce({ ok: true, key });

    await expect(
      proxy.request(token, "sessions.patch", { key, model: "company/qwen" }),
    ).resolves.toEqual({ ok: true, key });
  });

  it("applies a configured model before the first browser-created session turn", async () => {
    const { binding, proxy, request, token, user } = await setup();
    request
      .mockResolvedValueOnce({
        models: [{ id: "qwen", name: "Qwen", provider: "company", available: true }],
      })
      .mockImplementationOnce(async (_method, params) => ({
        ok: true,
        key: (params as { key: string }).key,
      }))
      .mockResolvedValueOnce({ status: "started" });

    await expect(
      proxy.request(token, "sessions.create", {
        agentId: binding.agentId,
        message: "hello",
        model: "company/qwen",
      }),
    ).resolves.toMatchObject({ ok: true, runStarted: true });

    expect(request).toHaveBeenNthCalledWith(1, "models.list", { view: "configured" });
    const createdKey = (request.mock.calls[1]?.[1] as { key?: unknown } | undefined)?.key;
    if (typeof createdKey !== "string") {
      throw new Error("expected browser-created session key");
    }
    expect(request).toHaveBeenNthCalledWith(2, "sessions.create", {
      agentId: binding.agentId,
      emitCommandHooks: false,
      key: createdKey,
      model: "company/qwen",
    });
    expect(request).toHaveBeenNthCalledWith(3, "chat.send", {
      sessionKey: createdKey,
      agentId: binding.agentId,
      message: "hello",
      idempotencyKey: expect.any(String),
      deliver: false,
      senderAttribution: expect.objectContaining({ id: user.accountId, profileId: user.id }),
      suppressCommandInterpretation: true,
    });
  });

  it.each(["company/not-configured", "company/qwen@operator"])(
    "rejects browser session model selection outside the configured catalog: %s",
    async (model) => {
      const { binding, proxy, request, token } = await setup();
      request.mockResolvedValueOnce({
        models: [{ id: "qwen", name: "Qwen", provider: "company", available: true }],
      });

      await expect(
        proxy.request(token, "sessions.create", {
          agentId: binding.agentId,
          model,
        }),
      ).rejects.toMatchObject({ code: "method-not-allowed" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("models.list", { view: "configured" });
    },
  );
});
