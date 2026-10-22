import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sendKnoxOutbound } from "./outbound.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const account: ResolvedKnoxAccount = {
  accountId: "default",
  enabled: true,
  selfInSpaceEnabled: false,
  configured: true,
  webhookPath: "/knox",
  webhookSecret: "w".repeat(32),
  outboundUrl: "http://cdep.example/outbound/send",
  serviceToken: "s".repeat(32),
  controlPlaneUrl: "http://control.example/route",
  progressDelayMs: 4_000,
};
const inbound: KnoxInboundMessage = {
  schemaVersion: 1,
  eventId: "evt-1",
  messageId: "msg-1",
  occurredAt: "2026-07-31T00:00:00.000Z",
  sender: { knoxUserId: "user.name", displayName: "User" },
  conversation: {
    type: "room",
    providerType: "GROUP",
    conversationId: "42",
  },
  message: { type: "text", text: "question" },
};
const dmInbound: KnoxInboundMessage = {
  ...inbound,
  conversation: {
    type: "dm",
    providerType: "SINGLE",
    conversationId: "24",
  },
};
const personalInbound = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/self-in-space.json", import.meta.url), "utf8"),
) as Extract<KnoxInboundMessage, { schemaVersion: 2 }>;
const failureFixtures = JSON.parse(
  readFileSync(new URL("../test-fixtures/my/outbound-responses.json", import.meta.url), "utf8"),
) as Array<{
  name: string;
  status: number;
  body: unknown;
  retryable: boolean;
  deliveryOutcome?: "partial" | "unknown";
}>;

describe("sendKnoxOutbound", () => {
  it.each([
    [false, inbound],
    [true, personalInbound],
  ] as const)(
    "preserves migration message identity only for v2 (stable=%s)",
    async (stable, message) => {
      const fetchImpl = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ ok: true, messageId: "delivered" }), { status: 200 }),
      );
      const request = {
        context: {
          account,
          inbound: message,
          agentId: "personal-a",
          sessionKey: "registered-session",
          runId: "run-a",
        },
        status: "final" as const,
        text: "saved answer",
        final: true,
        requestId: "persisted-delivery",
        fetchImpl,
      };
      await sendKnoxOutbound(request);
      await sendKnoxOutbound(request);
      const bodies = fetchImpl.mock.calls.map(([, init]) => {
        if (typeof init?.body !== "string") {
          throw new Error("expected string request body");
        }
        return JSON.parse(init.body) as { requestId: string; chatMsgId: string };
      });
      expect(bodies).toHaveLength(2);
      const first = bodies[0]!;
      const second = bodies[1]!;
      expect(second.requestId).toBe(first.requestId);
      if (stable) {
        expect(second).toEqual(first);
        expect(first.chatMsgId).toMatch(/^[0-9a-f]{64}$/u);
        await sendKnoxOutbound({ ...request, requestId: "another-delivery" });
        await sendKnoxOutbound({
          ...request,
          context: { ...request.context, account: { ...account, accountId: "another-account" } },
        });
        const nextIds = fetchImpl.mock.calls.slice(2).map(([, init]) => {
          if (typeof init?.body !== "string") {
            throw new Error("expected string request body");
          }
          return (JSON.parse(init.body) as { chatMsgId: string }).chatMsgId;
        });
        expect(new Set([first.chatMsgId, ...nextIds]).size).toBe(3);
      } else {
        expect(second.chatMsgId).not.toBe(first.chatMsgId);
      }
    },
  );

  it.each(failureFixtures)("$name", async (fixture) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(fixture.body), {
          status: fixture.status,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      sendKnoxOutbound({
        context: {
          account,
          inbound,
          agentId: "personal-24",
          sessionKey: "agent:personal-24:space-fixture",
          runId: "knox:msg-1",
        },
        status: "final",
        text: "answer",
        final: true,
        requestId: "final:msg-1:0",
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "KnoxOutboundError",
      retryable: fixture.retryable,
      deliveryOutcome: fixture.deliveryOutcome,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("sends bearer-authenticated dual-schema final response", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, messageId: "out-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      sendKnoxOutbound({
        context: {
          account,
          inbound,
          agentId: "group-42",
          sessionKey: "agent:group-42:main",
          runId: "knox:evt-1",
        },
        status: "final",
        text: "answer",
        final: true,
        requestId: "final:evt-1",
        fetchImpl,
      }),
    ).resolves.toBe("out-1");
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${account.serviceToken}` });
    if (typeof init?.body !== "string") {
      throw new Error("expected string request body");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      conversationType: "room",
      chatroomId: "42",
      agentId: "group-42",
      status: "final",
      final: true,
      text: "answer",
      senderDisplayName: "User",
    });
  });

  it("treats a CDEP idempotency hit as delivered", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, errorCode: "DUPLICATE_MESSAGE" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      sendKnoxOutbound({
        context: {
          account,
          inbound,
          agentId: "group-42",
          sessionKey: "agent:group-42:main",
          runId: "knox:evt-1",
        },
        status: "final",
        text: "answer",
        final: true,
        requestId: "final:evt-1",
        fetchImpl,
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it.each([
    ["assigned_vm", "question", "🟢 Using VM\n\nanswer"],
    ["platform_server", "question", "🟠 Using PlatformClaw server\n\nanswer"],
    ["assigned_vm", "질문", "🟢 VM 사용 중\n\nanswer"],
    ["platform_server", "question 한", "🟠 PlatformClaw 서버 사용 중\n\nanswer"],
  ] as const)("adds a localized %s indicator for %s", async (target, request, expected) => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, messageId: "out-dm" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await sendKnoxOutbound({
      context: {
        account,
        inbound: { ...dmInbound, message: { type: "text", text: request } },
        agentId: "personal-24",
        sessionKey: "agent:personal-24:main",
        runId: "knox:dm-24",
        executionTarget: target,
      },
      status: "final",
      text: "answer",
      final: true,
      fetchImpl,
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("expected string request body");
    }
    expect(JSON.parse(init.body)).toMatchObject({
      conversationType: "dm",
      text: expected,
    });
    expect(dmInbound.message.text).toBe("question");
  });

  it("replaces a conflicting generated indicator instead of showing two statuses", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, messageId: "out-dm" }), { status: 200 }),
    );

    await sendKnoxOutbound({
      context: {
        account,
        inbound: dmInbound,
        agentId: "personal-24",
        sessionKey: "agent:personal-24:main",
        runId: "knox:dm-24",
        executionTarget: "assigned_vm",
      },
      status: "final",
      text: "\r🟠 PlatformClaw 서버 사용 중\r\r🟢 VM 사용 중\r\ranswer",
      final: true,
      fetchImpl,
    });

    const init = fetchImpl.mock.calls[0]?.[1];
    if (typeof init?.body !== "string") {
      throw new Error("expected string request body");
    }
    expect(JSON.parse(init.body).text).toBe("🟢 Using VM\n\nanswer");
  });

  it("rejects a 2xx response without an explicit acknowledgement", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    await expect(
      sendKnoxOutbound({
        context: {
          account,
          inbound,
          agentId: "group-42",
          sessionKey: "agent:group-42:main",
          runId: "knox:msg-1",
        },
        status: "final",
        text: "answer",
        final: true,
        requestId: "final:msg-1",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});
