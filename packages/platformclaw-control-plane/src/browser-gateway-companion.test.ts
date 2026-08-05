import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy companion", () => {
  it("allows companion questions, state, and reset only for an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({ answer: "The run is checking tests.", ts: 2 })
      .mockResolvedValueOnce({ exchanges: [] })
      .mockResolvedValueOnce({ ok: true });

    await expect(
      proxy.request(token, "sessions.companion.ask", {
        sessionKey,
        question: "What is happening?",
      }),
    ).resolves.toEqual({ answer: "The run is checking tests.", ts: 2 });
    await expect(proxy.request(token, "sessions.companion.state", { sessionKey })).resolves.toEqual(
      { exchanges: [] },
    );
    await expect(proxy.request(token, "sessions.companion.reset", { sessionKey })).resolves.toEqual(
      { ok: true },
    );
    expect(request).toHaveBeenNthCalledWith(1, "sessions.companion.ask", {
      sessionKey,
      question: "What is happening?",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.companion.state", { sessionKey });
    expect(request).toHaveBeenNthCalledWith(3, "sessions.companion.reset", { sessionKey });

    for (const method of [
      "sessions.companion.ask",
      "sessions.companion.state",
      "sessions.companion.reset",
    ]) {
      await expect(
        proxy.request(token, method, {
          sessionKey: "agent:other:main",
          ...(method.endsWith(".ask") ? { question: "What is happening?" } : {}),
        }),
      ).rejects.toMatchObject({ code: "cross-agent-denied" });
    }
  });
});
