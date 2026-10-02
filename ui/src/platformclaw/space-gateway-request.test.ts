import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { requestSpaceGateway } from "./space-gateway-request.ts";

describe("Space Gateway request identity", () => {
  it("rejects a late response after the application context itself is replaced", async () => {
    let release!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let context = {
      gateway: { snapshot: { phase: "connected", client: { request } } },
    } as unknown as ApplicationContext;
    const pending = requestSpaceGateway(() => context, "conversation.history", {
      conversationId: "own",
    });
    context = {
      gateway: { snapshot: { phase: "connected", client: { request: vi.fn() } } },
    } as unknown as ApplicationContext;
    release({ messages: ["old identity"] });
    await expect(pending).rejects.toThrow();
    expect(request).toHaveBeenCalledWith("platformclaw.spaces.conversation.history", {
      conversationId: "own",
    });
  });
});
