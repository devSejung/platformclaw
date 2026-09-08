import { describe, expect, it } from "vitest";
import { setupBrowserGatewayProxyTest as setup } from "./browser-gateway-proxy.test-harness.js";

describe("BrowserGatewayProxy ACP commands", () => {
  it("rejects an ACP steering prompt that embeds an unavailable browser command", async () => {
    const { binding, proxy, request, token } = await setup();
    await expect(
      proxy.request(token, "chat.send", {
        sessionKey: `agent:${binding.agentId}:main`,
        message: "/acp steer inspect this /config show",
        idempotencyKey: "request-acp-embedded-config",
      }),
    ).rejects.toMatchObject({ code: "method-not-allowed" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "/acp",
    "/acp help",
    "/acp doctor",
    "/acp install",
    "/acp sessions",
    "/acp spawn claude",
    "/acp status",
    "/acp cancel",
    "/acp steer continue",
    "/acp close",
    "/acp set-mode plan",
    "/acp set model claude-sonnet-4-5",
    "/acp cwd /workspace",
    "/acp permissions strict",
    "/acp timeout 120",
    "/acp model claude-sonnet-4-5",
    "/acp reset-options",
  ])("forwards personal ACP command %s with an assigned-agent boundary", async (message) => {
    const { binding, proxy, request, token, user } = await setup();
    const key = `agent:${binding.agentId}:main`;
    request
      .mockResolvedValueOnce({
        commands: [
          {
            name: "acp",
            textAliases: ["/acp"],
            source: "native",
            category: "management",
          },
        ],
      })
      .mockResolvedValueOnce({ status: "started" });

    await proxy.request(token, "chat.send", {
      sessionKey: key,
      message,
      idempotencyKey: `request-${message}`,
    });

    expect(request).toHaveBeenNthCalledWith(2, "chat.send", {
      sessionKey: key,
      message,
      idempotencyKey: `request-${message}`,
      agentId: binding.agentId,
      deliver: false,
      senderAttribution: {
        id: user.accountId,
        name: user.displayName,
        profileId: user.id,
        agentId: binding.agentId,
      },
      suppressCommandInterpretation: false,
    });
  });
});
