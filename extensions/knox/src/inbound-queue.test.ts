import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchKnoxInbound, sendKnoxQueuedNotice } from "./inbound.js";
import { createKnoxIngress, type KnoxIngressLifecycle } from "./ingress.js";
import { setKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

const account: ResolvedKnoxAccount = {
  accountId: "synthetic",
  enabled: true,
  configured: true,
  webhookPath: "/knox",
  webhookSecret: "w".repeat(32),
  outboundUrl: "http://relay.invalid/send",
  serviceToken: "s".repeat(32),
  controlPlaneUrl: "http://control.invalid/route",
  progressDelayMs: 60_000,
};
type TestRun = {
  raw: KnoxInboundMessage;
  turnAdoptionLifecycle: KnoxIngressLifecycle & { onSettled: () => void };
  adapter: { resolveTurn: () => Promise<ChannelInboundTurnPlan> };
};
type Sent = { messageId: string; status: string; text: string; requestId: string };
function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function roomMessage(id: number): KnoxInboundMessage {
  return {
    schemaVersion: 1,
    eventId: `evt-${id}`,
    messageId: `msg-${id}`,
    occurredAt: new Date(id).toISOString(),
    sender: { knoxUserId: `person.${id}`, displayName: `Person ${id}` },
    conversation: { type: "room", providerType: "GROUP", conversationId: "room-1" },
    message: { type: "text", text: `@platformclaw question ${id}` },
  };
}
function installRuntime(
  run: (params: TestRun) => Promise<unknown>,
  adoptionPolicy: "allow" | "deny" = "allow",
  initialPolicy: "allow" | "deny" = "allow",
) {
  setKnoxRuntime({
    config: { current: () => ({}) },
    channel: {
      inbound: {
        buildContext: () => ({}),
        run: async (params: TestRun) => {
          const turn = await params.adapter.resolveTurn();
          turn.replyOptions?.onSourceReplyDeliveryPolicy?.({
            sendPolicyDenied: initialPolicy === "deny",
            sourceReplyDeliveryMode: "automatic",
          });
          return await run({
            ...params,
            turnAdoptionLifecycle: {
              ...params.turnAdoptionLifecycle,
              onAdopted: async () => {
                // The real deferred owner reloads its policy before adoption.
                turn.replyOptions?.onSourceReplyDeliveryPolicy?.({
                  sendPolicyDenied: adoptionPolicy === "deny",
                  sourceReplyDeliveryMode: "automatic",
                });
                await params.turnAdoptionLifecycle.onAdopted();
              },
            },
          });
        },
      },
    },
  } as unknown as PluginRuntime);
}
function mockRelay(sent: Sent[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === account.controlPlaneUrl) {
        return Response.json({
          status: "resolved",
          agentId: "room-agent",
          sessionKey: "agent:room-agent:main",
          senderLinked: true,
          executionTarget: null,
        });
      }
      expect(url).toBe(account.outboundUrl);
      if (typeof init.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      sent.push(JSON.parse(init.body) as Sent);
      return Response.json({ ok: true, messageId: `receipt-${sent.length}` });
    }),
  );
}
const emptyDispatchResult = {
  admission: { kind: "dispatch" },
  dispatched: true,
  ctxPayload: {},
  routeSessionKey: "agent:room-agent:main",
  dispatchResult: { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

describe("Knox room admission and delivery", () => {
  it.each(["final", "error"] as const)(
    "closes acknowledged progress as %s from settled dispatch facts",
    async (expectedStatus) => {
      const sent: Sent[] = [];
      mockRelay(sent);
      installRuntime(async (params) => {
        await params.turnAdoptionLifecycle.onAdopted();
        await vi.waitFor(() => expect(sent.some(({ status }) => status === "progress")).toBe(true));
        return {
          ...emptyDispatchResult,
          dispatchResult: {
            ...emptyDispatchResult.dispatchResult,
            sourceTurnCompleted: true,
            noVisibleReplyFallbackEligible: expectedStatus === "error",
            ...(expectedStatus === "error" ? { noVisibleReplyReason: "delivery-suppressed" } : {}),
          },
        };
      });
      await dispatchKnoxInbound({
        account: { ...account, progressDelayMs: 0 },
        message: roomMessage(1),
        lifecycle: {
          admission: "exclusive",
          abortSignal: new AbortController().signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
      });
      expect(sent.map(({ status }) => status)).toEqual(["progress", expectedStatus]);
      expect(sent[1]?.text).toContain(
        expectedStatus === "error" ? "확인 코드: delivery-suppressed" : "요청 처리가 끝났습니다.",
      );
    },
  );

  it.each(["runtime-error", "timeout", "empty-result", "timeout-after-empty"] as const)(
    "closes acknowledged progress with the recorded %s instead of success",
    async (scenario) => {
      const reason = scenario === "timeout-after-empty" ? "timeout" : scenario;
      const sent: Sent[] = [];
      mockRelay(sent);
      installRuntime(async (params) => {
        await params.turnAdoptionLifecycle.onAdopted();
        await vi.waitFor(() => expect(sent.some(({ status }) => status === "progress")).toBe(true));
        if (scenario === "timeout-after-empty") {
          const turn = await params.adapter.resolveTurn();
          turn.replyOptions?.onAgentRunFailure?.(
            { reason: "failed", status: "error" },
            "empty-result",
          );
          turn.replyOptions?.onAgentRunFailure?.({ reason: "timed_out", status: "timeout" });
        }
        return {
          ...emptyDispatchResult,
          dispatchResult: {
            ...emptyDispatchResult.dispatchResult,
            sourceTurnFailure: {
              reason: reason === "timeout" ? "timed_out" : "failed",
              status: reason === "timeout" ? "timeout" : "error",
            },
            ...(reason === "empty-result" ? { noVisibleReplyReason: "empty-result" } : {}),
          },
        };
      });
      await dispatchKnoxInbound({
        account: { ...account, progressDelayMs: 0 },
        message: roomMessage(1),
        lifecycle: {
          admission: "exclusive",
          abortSignal: new AbortController().signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
      });
      expect(sent.map(({ status }) => status)).toEqual([
        "progress",
        reason === "timeout" ? "timeout" : "error",
      ]);
      expect(sent[1]?.text).toContain(`확인 코드: ${reason}`);
      expect(sent[1]?.text).not.toContain("요청 처리가 끝났습니다.");
    },
  );

  it.each([
    ["allow", "allow"],
    ["allow", "deny"],
    ["deny", "allow"],
  ] as const)(
    "honors refreshed %s → %s for a failure after initial dispatch returned",
    async (initialPolicy, policy) => {
      const sent: Sent[] = [];
      mockRelay(sent);
      let followup: Promise<void> | undefined;
      installRuntime(
        async (params) => {
          params.turnAdoptionLifecycle.onDeferred();
          const turn = await params.adapter.resolveTurn();
          followup = (async () => {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
            await params.turnAdoptionLifecycle.onAdopted();
            if (policy === "allow") {
              await vi.waitFor(() =>
                expect(sent.some(({ status }) => status === "progress")).toBe(true),
              );
            }
            turn.replyOptions?.onAgentRunFailure?.(
              { reason: "failed", status: "error" },
              "empty-result",
            );
            params.turnAdoptionLifecycle.onSettled();
          })();
          return {
            ...emptyDispatchResult,
            dispatchResult: {
              ...emptyDispatchResult.dispatchResult,
              sendPolicyDenied: initialPolicy === "deny",
              sourceReplyDeliveryMode: "automatic",
            },
          };
        },
        policy,
        initialPolicy,
      );
      await dispatchKnoxInbound({
        account: { ...account, progressDelayMs: 0 },
        message: roomMessage(1),
        lifecycle: {
          admission: "exclusive",
          abortSignal: new AbortController().signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onAbandoned: vi.fn(),
        },
      });
      await followup;
      expect(sent.map(({ status }) => status)).toEqual(
        policy === "allow" ? ["progress", "error"] : [],
      );
      if (policy === "allow") {
        expect(sent[1]?.text).toContain("확인 코드: empty-result");
      }
    },
  );

  it("cancels pending progress when the execution owner refreshes policy to deny", async () => {
    vi.useFakeTimers();
    const sent: Sent[] = [];
    mockRelay(sent);
    installRuntime(async (params) => {
      await params.turnAdoptionLifecycle.onAdopted();
      const turn = await params.adapter.resolveTurn();
      turn.replyOptions?.onSourceReplyDeliveryPolicy?.({
        sendPolicyDenied: true,
        sourceReplyDeliveryMode: "automatic",
      });
      await vi.advanceTimersByTimeAsync(1_001);
      return emptyDispatchResult;
    });
    await dispatchKnoxInbound({
      account: { ...account, progressDelayMs: 1_000 },
      message: roomMessage(1),
      lifecycle: {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      },
    });
    expect(sent).toEqual([]);
  });

  it("notifies newly waiting mentions with N=1,2 and never waits for notice ACK", async () => {
    const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "knox-notice-")));
    const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
      channelId: "knox",
      accountId: account.accountId,
      stateDir,
    });
    const sent: Sent[] = [];
    const started: string[] = [];
    mockRelay(sent);
    const first = createDeferred<void>();
    const notices: Array<{ messageId: string; aheadCount: number }> = [];
    const noticeSignals: AbortSignal[] = [];
    const noticeAck = createDeferred<void>();
    const relay = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (
        typeof init?.body === "string" &&
        (JSON.parse(init.body) as Sent).requestId?.startsWith("queued:")
      ) {
        sent.push(JSON.parse(init.body) as Sent);
        await noticeAck.promise;
        return Response.json({ ok: true, messageId: "synthetic-notice-receipt" });
      }
      return relay(url, init);
    });
    installRuntime(async (params) => {
      started.push(params.raw.messageId);
      await params.turnAdoptionLifecycle.onAdopted();
      if (params.raw.messageId === "msg-3") {
        await first.promise;
      }
      const turn = await params.adapter.resolveTurn();
      if (!("deliver" in turn.delivery) || !turn.delivery.deliver) {
        throw new Error("Missing deliverer");
      }
      await turn.delivery.deliver({ text: `answer:${params.raw.messageId}` }, { kind: "final" });
      return emptyDispatchResult;
    });
    const ingress = createKnoxIngress({
      accountId: account.accountId,
      queue,
      dispatch: async (message, lifecycle) => dispatchKnoxInbound({ account, message, lifecycle }),
      notifyQueued: async (message, context) => {
        notices.push({ messageId: message.messageId, aheadCount: context.aheadCount });
        noticeSignals.push(context.abortSignal);
        await sendKnoxQueuedNotice({ account, message, ...context });
      },
    });
    ingress.start();
    try {
      await ingress.admit(roomMessage(3));
      await vi.waitFor(() => expect(started).toEqual(["msg-3"]));
      await Promise.all([ingress.admit(roomMessage(2)), ingress.admit(roomMessage(1))]);
      expect(await ingress.admit(roomMessage(2))).toEqual({ duplicate: true });
      await vi.waitFor(() =>
        expect(sent.filter((item) => item.requestId.startsWith("queued:"))).toHaveLength(2),
      );
      expect(notices).toEqual([
        { messageId: "msg-2", aheadCount: 1 },
        { messageId: "msg-1", aheadCount: 2 },
      ]);
      expect(sent.map((item) => ({ requestId: item.requestId, text: item.text }))).toEqual([
        { requestId: "queued:msg-2", text: "앞선 요청 1건 처리 후 이어서 진행합니다." },
        { requestId: "queued:msg-1", text: "앞선 요청 2건 처리 후 이어서 진행합니다." },
      ]);
      first.resolve();
      await vi.waitFor(() =>
        expect(sent.filter((item) => item.status === "final")).toHaveLength(3),
      );
      expect(started).toEqual(["msg-3", "msg-2", "msg-1"]);
      expect(noticeSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      first.resolve();
      noticeAck.resolve();
      await ingress.stop();
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("discards a waiting notice after routing if dispatch or shutdown won", async () => {
    const sent: Sent[] = [];
    mockRelay(sent);
    const relay = vi.mocked(fetch).getMockImplementation()!;
    const routing = createDeferred<void>();
    const routingStarted = createDeferred<void>();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      routingStarted.resolve();
      await routing.promise;
      return relay(url, init);
    });
    const abort = new AbortController();
    const notice = sendKnoxQueuedNotice({
      account,
      message: roomMessage(1),
      aheadCount: 1,
      abortSignal: abort.signal,
    });
    await routingStarted.promise;
    abort.abort();
    routing.resolve();
    await notice;
    expect(sent).toEqual([]);
  });

  it("does not start the processing delay before adoption commits", async () => {
    vi.useFakeTimers();
    const sent: Sent[] = [];
    mockRelay(sent);
    const adopting = createDeferred<void>();
    const commit = createDeferred<void>();
    const ready = createDeferred<void>();
    const finish = createDeferred<void>();
    installRuntime(async (params) => {
      adopting.resolve();
      await params.turnAdoptionLifecycle.onAdopted();
      ready.resolve();
      await finish.promise;
      return emptyDispatchResult;
    });
    const lifecycle: KnoxIngressLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: () => commit.promise,
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const dispatch = dispatchKnoxInbound({
      account: { ...account, progressDelayMs: 4_000 },
      message: roomMessage(1),
      lifecycle,
    });
    try {
      await adopting.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toEqual([]);
      commit.resolve();
      await ready.promise;
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sent.map((item) => item.text)).toEqual(["요청을 처리 중입니다."]);
    } finally {
      commit.resolve();
      finish.resolve();
      await dispatch;
    }
  });

  it.each(["slow", "fast", "cancelled", "queued", "deferred"])(
    "starts one Korean progress notice only after adoption: %s",
    async (mode) => {
      vi.useFakeTimers();
      const sent: Sent[] = [];
      mockRelay(sent);
      const ready = createDeferred<void>();
      const finish = createDeferred<void>();
      const abort = new AbortController();
      installRuntime(async (params) => {
        if (mode === "deferred") {
          params.turnAdoptionLifecycle.onDeferred();
        } else {
          await params.turnAdoptionLifecycle.onAdopted();
          await params.turnAdoptionLifecycle.onAdopted();
        }
        ready.resolve();
        await finish.promise;
        if (mode === "deferred") {
          params.turnAdoptionLifecycle.onSettled();
        }
        return emptyDispatchResult;
      });
      const lifecycle: KnoxIngressLifecycle = {
        admission: "exclusive",
        abortSignal: abort.signal,
        ...(mode === "queued" ? { admissionAheadCount: 2 } : {}),
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      };
      const dispatch = dispatchKnoxInbound({
        account: { ...account, progressDelayMs: 4_000 },
        message: roomMessage(1),
        lifecycle,
      });
      try {
        await ready.promise;
        if (mode === "fast") {
          finish.resolve();
          await dispatch;
        }
        if (mode === "cancelled") {
          abort.abort();
        }
        await vi.advanceTimersByTimeAsync(3_999);
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(4_001);
        expect(sent.map((item) => item.text)).toEqual(
          mode === "slow" || mode === "queued" ? ["요청을 처리 중입니다."] : [],
        );
      } finally {
        finish.resolve();
        await dispatch;
      }
    },
  );
  it("allows one waiting notice then one processing notice after queued adoption", async () => {
    vi.useFakeTimers();
    const sent: Sent[] = [];
    mockRelay(sent);
    const abort = new AbortController();
    await sendKnoxQueuedNotice({
      account,
      message: roomMessage(2),
      aheadCount: 1,
      abortSignal: abort.signal,
    });
    const deferred = createDeferred<void>();
    const adopt = createDeferred<void>();
    const adopted = createDeferred<void>();
    const finish = createDeferred<void>();
    installRuntime(async (params) => {
      params.turnAdoptionLifecycle.onDeferred();
      deferred.resolve();
      await adopt.promise;
      await params.turnAdoptionLifecycle.onAdopted();
      adopted.resolve();
      await finish.promise;
      params.turnAdoptionLifecycle.onSettled();
      return emptyDispatchResult;
    });
    const lifecycle: KnoxIngressLifecycle = {
      admission: "exclusive",
      admissionAheadCount: 1,
      abortSignal: abort.signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const dispatch = dispatchKnoxInbound({
      account: { ...account, progressDelayMs: 4_000 },
      message: roomMessage(2),
      lifecycle,
    });
    try {
      await deferred.promise;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(sent.map((item) => item.requestId)).toEqual(["queued:msg-2"]);
      adopt.resolve();
      await adopted.promise;
      await vi.advanceTimersByTimeAsync(3_999);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(4_001);
      expect(sent.map((item) => ({ requestId: item.requestId, text: item.text }))).toEqual([
        { requestId: "queued:msg-2", text: "앞선 요청 1건 처리 후 이어서 진행합니다." },
        { requestId: "progress:msg-2", text: "요청을 처리 중입니다." },
      ]);
    } finally {
      adopt.resolve();
      finish.resolve();
      await dispatch;
    }
  });
  it.each(["direct", "deferred"])(
    "delivers every mention in order with delayed %s completion",
    async (mode) => {
      const stateDir = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "knox-queue-repro-")),
      );
      const queue = createChannelIngressQueueForTests<{ version: 1; rawEvent: string }>({
        channelId: "knox",
        accountId: account.accountId,
        stateDir,
      });
      const sent: Sent[] = [];
      const started: string[] = [];
      mockRelay(sent);
      let releaseFirst = () => {};
      const firstCompletion = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let active = false;
      installRuntime(async (params) => {
        started.push(params.raw.messageId);
        // Match accepted same-turn steering: no independent final is returned.
        if (active) {
          await params.turnAdoptionLifecycle.onAdopted();
          return emptyDispatchResult;
        }
        active = true;
        const complete = async () => {
          if (mode === "deferred" && params.raw.messageId === "msg-1") {
            await firstCompletion;
          }
          await params.turnAdoptionLifecycle.onAdopted();
          if (mode === "direct" && params.raw.messageId === "msg-1") {
            await firstCompletion;
          }
          const turn = await params.adapter.resolveTurn();
          if (!("deliver" in turn.delivery) || !turn.delivery.deliver) {
            throw new Error("Missing deliverer");
          }
          await turn.delivery.deliver(
            { text: `answer:${params.raw.messageId}` },
            { kind: "final" },
          );
          active = false;
        };
        if (mode === "deferred" && params.raw.messageId === "msg-1") {
          params.turnAdoptionLifecycle.onDeferred();
          void complete().finally(params.turnAdoptionLifecycle.onSettled);
          return emptyDispatchResult;
        }
        await complete();
        return emptyDispatchResult;
      });
      const ingress = createKnoxIngress({
        accountId: account.accountId,
        queue,
        dispatch: async (message, lifecycle) =>
          dispatchKnoxInbound({ account, message, lifecycle }),
      });
      ingress.start();
      try {
        await ingress.admit(roomMessage(1));
        await vi.waitFor(() => expect(started).toEqual(["msg-1"]));
        await ingress.admit(roomMessage(2));
        expect(await ingress.admit(roomMessage(2))).toEqual({ duplicate: true });
        await ingress.admit(roomMessage(3));
        await new Promise((resolve) => {
          setTimeout(resolve, 650);
        });
        const beforeCompletion = [...started];
        releaseFirst();
        await vi.waitFor(() => expect(sent).toHaveLength(3));
        expect(beforeCompletion).toEqual(["msg-1"]);
        expect(sent.map(({ messageId, status, text }) => ({ messageId, status, text }))).toEqual(
          [1, 2, 3].map((id) => ({
            messageId: `msg-${id}`,
            status: "final",
            text: `answer:msg-${id}`,
          })),
        );
      } finally {
        releaseFirst();
        await ingress.stop();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("does not report no-response while a turn is deferred", async () => {
    const sent: Sent[] = [];
    mockRelay(sent);
    let settle = () => {};
    installRuntime(async (params) => {
      params.turnAdoptionLifecycle.onDeferred();
      settle = params.turnAdoptionLifecycle.onSettled;
      return emptyDispatchResult;
    });
    const lifecycle: KnoxIngressLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onFailed: vi.fn(),
      onAbandoned: vi.fn(),
    };
    let finished = false;
    const dispatch = dispatchKnoxInbound({ account, message: roomMessage(2), lifecycle }).then(
      () => {
        finished = true;
      },
    );
    await vi.waitFor(() => expect(lifecycle.onDeferred).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(sent).toEqual([]);
    settle();
    await dispatch;
    expect(lifecycle.onDeferred).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });

  it.each(["synchronous", "pending"])(
    "suppresses fallback after abandonment and preserves the %s callback result",
    async (mode) => {
      const sent: Sent[] = [];
      mockRelay(sent);
      const release = createDeferred<void>();
      const callbackResult = mode === "pending" ? release.promise : undefined;
      const lifecycle: KnoxIngressLifecycle = {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(() => callbackResult),
      };
      installRuntime(async (params) => {
        params.turnAdoptionLifecycle.onDeferred();
        expect(params.turnAdoptionLifecycle.onAbandoned()).toBe(callbackResult);
        params.turnAdoptionLifecycle.onSettled();
        return {
          ...emptyDispatchResult,
          dispatchResult: {
            ...emptyDispatchResult.dispatchResult,
            noVisibleReplyFallbackEligible: true,
          },
        };
      });
      try {
        await dispatchKnoxInbound({ account, message: roomMessage(1), lifecycle });
        expect(lifecycle.onDeferred).toHaveBeenCalledOnce();
        expect(lifecycle.onAbandoned).toHaveBeenCalledOnce();
        expect(lifecycle.onAdopted).not.toHaveBeenCalled();
        expect(sent).toEqual([]);
      } finally {
        release.resolve();
      }
    },
  );

  it.each([undefined, false, true])(
    "uses fallback eligibility %s from the core",
    async (eligible) => {
      const sent: Sent[] = [];
      mockRelay(sent);
      installRuntime(async () => ({
        ...emptyDispatchResult,
        dispatchResult: {
          ...emptyDispatchResult.dispatchResult,
          noVisibleReplyFallbackEligible: eligible,
        },
      }));
      const lifecycle: KnoxIngressLifecycle = {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      };
      await dispatchKnoxInbound({ account, message: roomMessage(1), lifecycle });
      if (eligible) {
        expect(sent).toHaveLength(1);
        expect(sent[0]?.text).toContain("확인 코드: unknown");
        expect(sent[0]?.text).toContain("요청 참조:");
      } else {
        expect(sent).toEqual([]);
      }
    },
  );

  it("ends a pre-adoption deferred wait on shutdown without a terminal error", async () => {
    const sent: Sent[] = [];
    mockRelay(sent);
    const abort = new AbortController();
    installRuntime(async (params) => {
      params.turnAdoptionLifecycle.onDeferred();
      return emptyDispatchResult;
    });
    const lifecycle: KnoxIngressLifecycle = {
      admission: "exclusive",
      abortSignal: abort.signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const dispatch = dispatchKnoxInbound({ account, message: roomMessage(1), lifecycle });
    await vi.waitFor(() => expect(lifecycle.onDeferred).toHaveBeenCalledOnce());
    abort.abort();
    await dispatch;
    expect(sent).toEqual([]);
  });

  it.each([undefined, false])(
    "waits for pending progress before releasing a turn with fallback eligibility %s",
    async (eligible) => {
      const sent: Sent[] = [];
      mockRelay(sent);
      const relay = vi.mocked(fetch).getMockImplementation();
      if (!relay) {
        throw new Error("Expected a synthetic relay implementation");
      }
      const progressStarted = createDeferred<void>();
      const progressRelease = createDeferred<void>();
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (
          typeof init?.body === "string" &&
          (JSON.parse(init.body) as { status?: string }).status === "progress"
        ) {
          progressStarted.resolve();
          await progressRelease.promise;
        }
        return relay(url, init);
      });
      installRuntime(async (params) => {
        await params.turnAdoptionLifecycle.onAdopted();
        await progressStarted.promise;
        return {
          ...emptyDispatchResult,
          dispatchResult: {
            ...emptyDispatchResult.dispatchResult,
            noVisibleReplyFallbackEligible: eligible,
          },
        };
      });
      const lifecycle: KnoxIngressLifecycle = {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      };
      let finished = false;
      const dispatch = dispatchKnoxInbound({
        account: { ...account, progressDelayMs: 0 },
        message: roomMessage(1),
        lifecycle,
      }).then(() => {
        finished = true;
      });
      try {
        await progressStarted.promise;
        // Flush the resolved run, its return, and finally before observing dispatch.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(finished).toBe(false);
        expect(sent).toEqual([]);
      } finally {
        progressRelease.resolve();
        await dispatch;
      }
      expect(finished).toBe(true);
      expect(sent.map(({ status, messageId }) => ({ status, messageId }))).toEqual([
        { status: "progress", messageId: "msg-1" },
      ]);
    },
  );

  it.each(["intentional silence", "observed delivery"])(
    "preserves core %s without a fallback",
    async (outcome) => {
      const sent: Sent[] = [];
      mockRelay(sent);
      installRuntime(async () => ({
        ...emptyDispatchResult,
        dispatchResult: {
          ...emptyDispatchResult.dispatchResult,
          ...(outcome === "observed delivery" ? { observedReplyDelivery: true } : {}),
        },
      }));
      const lifecycle: KnoxIngressLifecycle = {
        admission: "exclusive",
        abortSignal: new AbortController().signal,
        onAdopted: vi.fn(),
        onDeferred: vi.fn(),
        onAbandoned: vi.fn(),
      };
      await dispatchKnoxInbound({ account, message: roomMessage(1), lifecycle });
      expect(sent).toEqual([]);
    },
  );
});
