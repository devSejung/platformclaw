import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy companion", () => {
  it("allows companion questions only for an owned session", async () => {
    const { binding, proxy, request, token } = await setup();
    const sessionKey = `agent:${binding.agentId}:main`;
    request.mockResolvedValueOnce({ answer: "The run is checking tests.", digestRevision: 2 });

    await expect(
      proxy.request(token, "sessions.observer.ask", {
        sessionKey,
        question: "What is happening?",
      }),
    ).resolves.toEqual({ answer: "The run is checking tests.", digestRevision: 2 });
    expect(request).toHaveBeenCalledWith("sessions.observer.ask", {
      sessionKey,
      question: "What is happening?",
    });

    await expect(
      proxy.request(token, "sessions.observer.ask", {
        sessionKey: "agent:other:main",
        question: "What is happening?",
      }),
    ).rejects.toMatchObject({ code: "cross-agent-denied" });
  });
});
