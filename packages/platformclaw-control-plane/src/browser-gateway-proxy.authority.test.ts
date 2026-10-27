import { describe, expect, it } from "vitest";
import {
  NOW,
  setupBrowserGatewayProxyTest as setup,
} from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy current dispatch authority", () => {
  for (const method of ["sessions.create", "sessions.patch"] as const) {
    it(`${method} does not dispatch after logout during model validation`, async () => {
      const { binding, created, proxy, request, store, token } = await setup();
      const key = `agent:${binding.agentId}:dashboard:authority`;
      request.mockImplementation(async (rpcMethod) => {
        expect(rpcMethod).toBe("models.list");
        await store.revokeBrowserSession(created.session.id, NOW);
        return { models: [{ id: "model", provider: "provider" }] };
      });
      await expect(
        proxy.request(token, method, { key, model: "provider/model" }),
      ).rejects.toMatchObject({
        code: "unauthenticated",
        requestDisposition: "rejected-before-dispatch",
      });
      expect(request).toHaveBeenCalledExactlyOnceWith("models.list", { view: "configured" });
    });
  }

  it("records a created session's unsent first turn when authority expires during creation", async () => {
    const { binding, created, proxy, request, store, token } = await setup();
    const key = `agent:${binding.agentId}:dashboard:authority`;
    request.mockImplementation(async (method) => {
      expect(method).toBe("sessions.create");
      await store.revokeBrowserSession(created.session.id, NOW);
      return { ok: true, key };
    });
    await expect(
      proxy.request(token, "sessions.create", { key, message: "hello" }),
    ).resolves.toMatchObject({
      ok: true,
      key,
      runStarted: false,
      runError: { message: "active browser session required" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a disabled Agent binding before dispatch", async () => {
    const { binding, proxy, request, store, token } = await setup();
    request.mockImplementation(async () => {
      await store.transitionAgent({ bindingId: binding.id, state: "disabled", changedAt: NOW });
      return { models: [{ id: "model", provider: "provider" }] };
    });
    await expect(
      proxy.request(token, "sessions.patch", {
        key: `agent:${binding.agentId}:main`,
        model: "provider/model",
      }),
    ).rejects.toMatchObject({ code: "agent-unavailable" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
