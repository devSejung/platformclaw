import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KnoxRoutingClient } from "./routing-client.js";

const personalRoute = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/resolved-route.json", import.meta.url), "utf8"),
) as { selfInSpace: { requestId: string } };
const personalRequest = {
  accountId: "default",
  conversationType: "room" as const,
  conversationId: "room-a",
  knoxUserId: "user.name_with.dot",
  executionMode: "self_in_space" as const,
  requestId: personalRoute.selfInSpace.requestId,
  requestFingerprint: "a".repeat(64),
};

describe("KnoxRoutingClient", () => {
  it("preserves the control-plane execution target for DM presentation", async () => {
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () =>
        new Response(
          JSON.stringify({
            status: "resolved",
            agentId: "personal-user",
            sessionKey: "agent:personal-user:main",
            senderLinked: true,
            executionTarget: "assigned_vm",
          }),
          { status: 200 },
        ),
    );

    await expect(
      client.resolve({
        accountId: "default",
        conversationType: "dm",
        conversationId: "42",
        knoxUserId: "user.name",
      }),
    ).resolves.toMatchObject({ status: "resolved", executionTarget: "assigned_vm" });
  });

  it("accepts the shared personal routing fixture for its original request", async () => {
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () => new Response(JSON.stringify(personalRoute), { status: 200 }),
    );

    await expect(client.resolve(personalRequest)).resolves.toEqual(personalRoute);
  });

  it("rejects an old control plane's ordinary room route for a personal request", async () => {
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () =>
        new Response(
          JSON.stringify({
            status: "resolved",
            agentId: "knox-room-a",
            sessionKey: "agent:knox-room-a:main",
            senderLinked: false,
            executionTarget: null,
          }),
          { status: 200 },
        ),
    );

    await expect(client.resolve(personalRequest)).rejects.toThrow("invalid response");
  });

  it("rejects a personal route for another request", async () => {
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () => new Response(JSON.stringify(personalRoute), { status: 200 }),
    );

    await expect(
      client.resolve({ ...personalRequest, requestId: "another-request" }),
    ).rejects.toThrow("invalid response");
  });

  it.each(["login-required", "room-disabled", "agent-unavailable"])(
    "requires a personal admission identity for %s while preserving v1 responses",
    async (status) => {
      for (const admissionId of [undefined, "", " "]) {
        const client = new KnoxRoutingClient(
          { url: "http://control.test/route", token: "token" },
          async () => new Response(JSON.stringify({ status, admissionId }), { status: 200 }),
        );

        await expect(client.resolve(personalRequest)).rejects.toThrow("invalid response");
      }
      const client = new KnoxRoutingClient(
        { url: "http://control.test/route", token: "token" },
        async () => new Response(JSON.stringify({ status }), { status: 200 }),
      );

      await expect(
        client.resolve({
          accountId: "default",
          conversationType: "room",
          conversationId: "room-a",
          knoxUserId: "user.name_with.dot",
        }),
      ).resolves.toEqual({ status });
    },
  );

  it("accepts a denied personal request with its admission identity", async () => {
    const route = { status: "permission-denied", admissionId: "admission-a" };
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () => new Response(JSON.stringify(route), { status: 200 }),
    );

    await expect(client.resolve(personalRequest)).resolves.toEqual(route);
  });

  it("rejects a denied personal request without its admission identity", async () => {
    const client = new KnoxRoutingClient(
      { url: "http://control.test/route", token: "token" },
      async () => new Response(JSON.stringify({ status: "permission-denied" }), { status: 200 }),
    );

    await expect(client.resolve(personalRequest)).rejects.toThrow("invalid response");
  });

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
