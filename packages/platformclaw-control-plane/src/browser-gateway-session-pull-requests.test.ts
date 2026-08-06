import { describe, expect, it, vi } from "vitest";
import { BrowserGatewaySessionPullRequestSubscriptions } from "./browser-gateway-session-pull-requests.js";

function setup() {
  const request = vi.fn(async () => ({ subscribed: true }));
  const subscriptions = new BrowserGatewaySessionPullRequestSubscriptions(
    { request },
    (key) => /^agent:([^:]+):/.exec(key)?.[1] ?? null,
    () => Object.assign(new Error("inactive browser connection"), { code: "invalid-params" }),
  );
  return { request, subscriptions };
}

describe("BrowserGatewaySessionPullRequestSubscriptions", () => {
  it("keeps browser replace-sets in independent upstream slots", async () => {
    const { request, subscriptions } = setup();
    subscriptions.registerConnection("browser-a");
    subscriptions.registerConnection("browser-b");

    await subscriptions.replace("browser-a", ["agent:a:main"]);
    await subscriptions.replace("browser-b", ["agent:b:main"]);
    await subscriptions.releaseConnection("browser-a");

    expect(request.mock.calls).toEqual([
      [
        "controlUi.sessionPullRequests.subscribe",
        { sessionKeys: ["agent:a:main"], subscriptionId: "browser-a" },
      ],
      [
        "controlUi.sessionPullRequests.subscribe",
        { sessionKeys: ["agent:b:main"], subscriptionId: "browser-b" },
      ],
      ["controlUi.sessionPullRequests.subscribe", { sessionKeys: [], subscriptionId: "browser-a" }],
    ]);
  });

  it("projects only watched sessions owned by the browser agent", async () => {
    const { subscriptions } = setup();
    subscriptions.registerConnection("browser-a");
    await subscriptions.replace("browser-a", ["agent:a:main", "agent:a:other"]);

    expect(
      subscriptions.projectEvent("browser-a", "a", {
        sessions: {
          "agent:a:main": { status: "ready" },
          "agent:a:unwatched": { status: "ready" },
          "agent:b:main": { status: "ready" },
        },
      }),
    ).toEqual({ sessions: { "agent:a:main": { status: "ready" } } });
    expect(
      subscriptions.projectEvent("browser-b", "b", {
        sessions: { "agent:b:main": { status: "ready" } },
      }),
    ).toBeNull();
  });

  it("drops projection ownership immediately when a browser closes", async () => {
    const { request, subscriptions } = setup();
    subscriptions.registerConnection("browser-a");
    await subscriptions.replace("browser-a", ["agent:a:main"]);
    request.mockRejectedValueOnce(new Error("Gateway unavailable"));

    await expect(subscriptions.releaseConnection("browser-a")).rejects.toThrow(
      "Gateway unavailable",
    );
    expect(
      subscriptions.projectEvent("browser-a", "a", {
        sessions: { "agent:a:main": { status: "ready" } },
      }),
    ).toBeNull();
  });

  it("rejects a subscription after its browser connection closes", async () => {
    const { request, subscriptions } = setup();
    subscriptions.registerConnection("browser-a");
    await subscriptions.releaseConnection("browser-a");

    await expect(subscriptions.replace("browser-a", ["agent:a:main"])).rejects.toMatchObject({
      code: "invalid-params",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
