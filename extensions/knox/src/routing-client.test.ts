import { describe, expect, it } from "vitest";
import { KnoxRoutingClient } from "./routing-client.js";

describe("KnoxRoutingClient", () => {
  it("treats a transient 503 as retryable transport failure", async () => {
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () =>
        new Response(JSON.stringify({ ok: false, error: "routing_unavailable" }), { status: 503 }),
    );

    await expect(
      client.resolve({
        accountId: "default",
        conversationType: "dm",
        conversationId: "42",
        knoxUserId: "user.name",
      }),
    ).rejects.toThrow("invalid response");
  });

  it("cancels an undeclared oversized response while streaming", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(40 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () => new Response(body, { status: 200 }),
    );

    await expect(
      client.resolve({
        accountId: "default",
        conversationType: "dm",
        conversationId: "42",
        knoxUserId: "user.name",
      }),
    ).rejects.toThrow("size limit");
    expect(cancelled).toBe(true);
  });
});
