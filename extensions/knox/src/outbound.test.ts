import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelKnoxOutbound, sendKnoxOutbound } from "./outbound.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const account: ResolvedKnoxAccount = {
  accountId: "default",
  enabled: true,
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

const context = {
  account,
  inbound,
  agentId: "group-42",
  sessionKey: "agent:group-42:main",
  runId: "knox:evt-1",
};

function receipt(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sendKnoxOutbound", () => {
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
        new Response(
          JSON.stringify({ ok: false, errorCode: "DUPLICATE_MESSAGE", messageId: "original-id" }),
          {
            status: 409,
            headers: { "Content-Type": "application/json" },
          },
        ),
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
    ).resolves.toBe("original-id");
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
    ).rejects.toMatchObject({ retryable: false, errorCode: "DELIVERY_UNKNOWN" });
  });
});

describe("Knox relay operation lifecycle", () => {
  function send(fetchImpl: typeof globalThis.fetch, abortSignal?: AbortSignal) {
    return sendKnoxOutbound({
      context,
      status: "progress",
      text: "Processing request.",
      final: false,
      requestId: "progress:evt-1:0",
      fetchImpl,
      abortSignal,
    });
  }

  it("honors pending retry delay and queries the original composite key", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt({ ok: true, state: "pending", retryAfterSeconds: 2 }, 202))
      .mockResolvedValueOnce(receipt({ ok: true, state: "sent", messageId: "out-confirmed" }));
    const result = send(fetchImpl);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("out-confirmed");
    const [input, init] = fetchImpl.mock.calls[1]!;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/outbound/status");
    expect(url.searchParams.get("requestId")).toBe("progress:evt-1:0");
    expect(url.searchParams.get("runId")).toBe(context.runId);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${account.serviceToken}` });
  });

  it("recovers a lost send acknowledgement without sending another POST", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection lost after acceptance"))
      .mockResolvedValueOnce(receipt({ ok: true, state: "sent", messageId: "accepted-id" }));
    await expect(send(fetchImpl)).resolves.toBe("accepted-id");
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it("looks up a duplicate without a receipt instead of inventing delivery success", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt({ ok: false, errorCode: "DUPLICATE_MESSAGE" }, 409))
      .mockResolvedValueOnce(receipt({ ok: true, state: "sent", messageId: "actual-id" }));
    await expect(send(fetchImpl)).resolves.toBe("actual-id");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps a missing duplicate lookup unconfirmed", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(receipt({ ok: false, errorCode: "DUPLICATE_MESSAGE" }, 409))
      .mockResolvedValueOnce(receipt({ ok: false, errorCode: "REQUEST_NOT_FOUND" }, 404));
    await expect(send(fetchImpl)).rejects.toMatchObject({
      errorCode: "DELIVERY_UNKNOWN",
      retryable: false,
    });
  });

  it.each([
    { state: "pending", messageId: "not-a-confirmation", retryAfterSeconds: 40 },
    {
      state: "failed",
      messageId: "not-a-confirmation",
      errorCode: "DELIVERY_UNKNOWN",
      retryable: false,
    },
  ])("does not treat a message ID with $state state as delivered", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(receipt({ ok: true, ...body }));
    await expect(send(fetchImpl)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["DELIVERY_UNKNOWN", "CANCEL_UNKNOWN", "RATE_LIMITED"])(
    "honors explicit retryable:false for 5xx %s",
    async (errorCode) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
        receipt(
          {
            ok: false,
            state: "failed",
            errorCode,
            retryable: false,
          },
          502,
        ),
      );
      await expect(send(fetchImpl)).rejects.toMatchObject({ errorCode, retryable: false });
    },
  );

  it("stops pending lookup immediately when the owner aborts", async () => {
    vi.useFakeTimers();
    const owner = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      receipt(
        {
          ok: true,
          state: "pending",
          retryAfterSeconds: 5,
        },
        202,
      ),
    );
    const result = expect(send(fetchImpl, owner.signal)).rejects.toMatchObject({
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    await result;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds persistent pending state without resending", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      receipt(
        {
          ok: true,
          state: "pending",
          retryAfterSeconds: 1,
        },
        202,
      ),
    );
    const result = expect(send(fetchImpl)).rejects.toMatchObject({
      errorCode: "DELIVERY_UNKNOWN",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(30);
  });

  it("sends an authenticated cancellation with source and operation run keys", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      receipt({
        ok: true,
        state: "cancelled",
        outcome: "recalled",
      }),
    );
    await expect(
      cancelKnoxOutbound({
        context,
        targetRequestId: "progress:evt-1:0",
        targetRunId: "original-run",
        fetchImpl,
      }),
    ).resolves.toBeUndefined();
    const [input, init] = fetchImpl.mock.calls[0]!;
    expect(String(input)).toBe("http://cdep.example/outbound/cancel");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${account.serviceToken}` });
    expect(JSON.parse(String(init?.body))).toEqual({
      requestId: "cancel:progress:evt-1:0",
      runId: context.runId,
      targetRequestId: "progress:evt-1:0",
      targetRunId: "original-run",
      chatroomId: "42",
      conversationType: "room",
    });
  });

  it("polls cancellation under its operation key after a lost acknowledgement", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("cancel response lost"))
      .mockResolvedValueOnce(receipt({ ok: true, state: "cancelled", outcome: "recalled" }));
    await cancelKnoxOutbound({ context, targetRequestId: "progress:evt-1:0", fetchImpl });
    const url = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(url.searchParams.get("requestId")).toBe("cancel:progress:evt-1:0");
    expect(url.searchParams.get("runId")).toBe(context.runId);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });

  it.each([
    { ok: false, errorCode: "MESSAGE_NOT_FOUND", retryable: false },
    { ok: false, errorCode: "CANCEL_UNKNOWN", retryable: false },
    { ok: true, state: "sent", messageId: "original" },
  ])("does not infer cancellation success from $errorCode / $state", async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => receipt(body));
    await expect(
      cancelKnoxOutbound({
        context,
        targetRequestId: "progress:evt-1:0",
        fetchImpl,
      }),
    ).rejects.toMatchObject({ retryable: false });
  });
});
