import { describe, expect, it, vi } from "vitest";
import { BrowserGatewaySessionMessageSubscriptions } from "./browser-gateway-session-message-subscriptions.js";

function createSubscriptions() {
  const request = vi.fn(async (method: string) => ({
    subscribed: method === "sessions.messages.subscribe",
  }));
  const subscriptions = new BrowserGatewaySessionMessageSubscriptions(
    { request },
    () => new Error("inactive browser connection"),
  );
  subscriptions.registerConnection("browser-a");
  subscriptions.registerConnection("browser-b");
  return { request, subscriptions };
}

describe("BrowserGatewaySessionMessageSubscriptions", () => {
  it("keeps the shared upstream lease until the final browser unsubscribes", async () => {
    const { request, subscriptions } = createSubscriptions();
    const params = { key: "agent:alice:main", agentId: "alice" };

    await subscriptions.subscribe("browser-a", params);
    await subscriptions.subscribe("browser-b", params);
    await expect(subscriptions.unsubscribe("browser-a", params)).resolves.toEqual({
      subscribed: false,
    });
    expect(request).not.toHaveBeenCalledWith("sessions.messages.unsubscribe", params);

    await subscriptions.unsubscribe("browser-b", params);
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", params);
  });

  it("releases only subscriptions no longer owned by another browser", async () => {
    const { request, subscriptions } = createSubscriptions();
    const shared = { key: "agent:alice:main", agentId: "alice" };
    const unique = { key: "agent:alice:other", agentId: "alice" };
    await subscriptions.subscribe("browser-a", shared);
    await subscriptions.subscribe("browser-a", unique);
    await subscriptions.subscribe("browser-b", shared);

    await subscriptions.releaseConnection("browser-a");

    expect(request).toHaveBeenCalledWith("sessions.messages.unsubscribe", unique);
    expect(request).not.toHaveBeenCalledWith("sessions.messages.unsubscribe", shared);
  });

  it("rolls back an upstream subscribe completed after its browser closed", async () => {
    let finishSubscribe: (() => void) | undefined;
    const request = vi.fn((method: string) =>
      method === "sessions.messages.subscribe"
        ? new Promise((resolve) => {
            finishSubscribe = () => resolve({ subscribed: true });
          })
        : Promise.resolve({ subscribed: false }),
    );
    const subscriptions = new BrowserGatewaySessionMessageSubscriptions(
      { request },
      () => new Error("inactive browser connection"),
    );
    subscriptions.registerConnection("browser-a");
    const params = { key: "agent:alice:main", agentId: "alice" };

    const subscribing = subscriptions.subscribe("browser-a", params);
    await vi.waitFor(() => expect(finishSubscribe).toBeTypeOf("function"));
    const releasing = subscriptions.releaseConnection("browser-a");
    finishSubscribe?.();

    await expect(subscribing).rejects.toThrow("inactive browser connection");
    await releasing;
    expect(request).toHaveBeenLastCalledWith("sessions.messages.unsubscribe", params);
  });
});
