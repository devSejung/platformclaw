import { createChannelIngressMonitor } from "openclaw/plugin-sdk/channel-outbound";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { describe, expect, it, vi } from "vitest";
import { createKnoxIngress } from "./ingress.js";

vi.mock("openclaw/plugin-sdk/channel-outbound", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-outbound")>(
    "openclaw/plugin-sdk/channel-outbound",
  );
  return {
    ...actual,
    createChannelIngressMonitor: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      admit: vi.fn(),
    })),
  };
});

describe("createKnoxIngress", () => {
  it("runs durable delivery outside the relay request admission", () => {
    createKnoxIngress({
      accountId: "default",
      queue: {} as never,
      dispatch: vi.fn(),
    });

    expect(createChannelIngressMonitor).toHaveBeenCalledWith(
      expect.objectContaining({ runPumpTask: runDetachedWebhookWork }),
    );
  });
});
