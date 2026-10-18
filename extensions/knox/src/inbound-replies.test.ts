import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildChannelInboundEventContext,
  runChannelInboundEvent,
  type ChannelInboundEventRunnerParams,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { closeOpenClawStateDatabaseForTest } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  getReplyPayloadNoVisibleReplyReason,
  type NoVisibleReplyReason,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  buildEmptyInteractiveReplyPayload,
  buildKnownAgentRunFailureReplyPayload,
  FailoverError,
} from "openclaw/plugin-sdk/reply-payload-testing";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchKnoxInbound } from "./inbound.js";
import { setKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage, ResolvedKnoxAccount } from "./types.js";

type ReplyResolver = NonNullable<ChannelInboundTurnPlan["replyResolver"]>;
type SentReply = { status: string; text: string; final: boolean; requestId: string };
type ReplyOutcome = {
  event: string;
  reference: string;
  runId: string;
  reason: string;
  error?: string;
};

const account: ResolvedKnoxAccount = {
  accountId: "boundary-test",
  enabled: true,
  configured: true,
  webhookPath: "/knox",
  webhookSecret: "w".repeat(32),
  outboundUrl: "http://relay.invalid/send",
  serviceToken: "s".repeat(32),
  controlPlaneUrl: "http://control.invalid/route",
  progressDelayMs: 60_000,
};
let stateDir: string;
let sent: SentReply[];
let recoveryReasons: Array<NoVisibleReplyReason | undefined>;
let cfg: OpenClawConfig;
let outcomes: ReplyOutcome[];
let relayFailure: "rejected" | "ack-loss" | undefined;

beforeEach(async () => {
  stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "knox-reply-boundary-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  cfg = {
    plugins: { enabled: false },
    agents: { defaults: { workspace: path.join(stateDir, "workspace") } },
    session: { store: path.join(stateDir, "agents", "test-agent", "sessions", "sessions.json") },
  };
  sent = [];
  recoveryReasons = [];
  outcomes = [];
  relayFailure = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === account.controlPlaneUrl) {
        return Response.json({
          status: "resolved",
          agentId: "test-agent",
          sessionKey: "agent:test-agent:main",
          senderLinked: true,
          executionTarget: "platform_server",
        });
      }
      expect(url).toBe(account.outboundUrl);
      if (typeof init.body !== "string") {
        throw new Error("Expected a relay JSON body");
      }
      sent.push(JSON.parse(init.body) as SentReply);
      if (relayFailure === "ack-loss") {
        throw new Error("Relay acknowledgement connection lost");
      }
      if (relayFailure === "rejected") {
        return Response.json(
          { ok: false, message: `Authorization: Bearer ${account.serviceToken}` },
          { status: 503 },
        );
      }
      return Response.json({ ok: true, messageId: `receipt-${sent.length}` });
    }),
  );
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(stateDir, { recursive: true, force: true });
});

async function runReplyBoundary(
  replyResolver: ReplyResolver,
  messageId = randomUUID(),
  conversationType: "dm" | "room" = "room",
): Promise<void> {
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
  // Inject only the model result. Admission, source policy, dispatch settlement,
  // the Knox adapter, and relay acknowledgement remain the real production flow.
  setKnoxRuntime({
    config: { current: () => cfg },
    channel: {
      inbound: {
        buildContext: buildChannelInboundEventContext,
        run: async (params: ChannelInboundEventRunnerParams<KnoxInboundMessage>) =>
          await runChannelInboundEvent({
            ...params,
            adapter: {
              ...params.adapter,
              resolveTurn: async (...args) => {
                const turn = await params.adapter.resolveTurn(...args);
                if (
                  !("delivery" in turn) ||
                  !("deliver" in turn.delivery) ||
                  !turn.delivery.deliver
                ) {
                  throw new Error("Expected the Knox direct delivery plan");
                }
                const deliver = turn.delivery.deliver;
                return {
                  ...turn,
                  replyResolver,
                  delivery: {
                    ...turn.delivery,
                    deliver: async (payload: ReplyPayload, info: Parameters<typeof deliver>[1]) => {
                      recoveryReasons.push(getReplyPayloadNoVisibleReplyReason(payload));
                      return await deliver(payload, info);
                    },
                  },
                };
              },
            },
          }),
      },
    },
  } as unknown as PluginRuntime);
  await dispatchKnoxInbound({
    account,
    message: {
      schemaVersion: 1,
      eventId: `event:${messageId}`,
      messageId,
      occurredAt: new Date().toISOString(),
      sender: { knoxUserId: "synthetic.user", displayName: "Synthetic" },
      conversation: {
        type: conversationType,
        providerType: conversationType === "room" ? "GROUP" : "SINGLE",
        conversationId: "boundary-room",
      },
      message: { type: "text", text: "작업을 진행해주세요" },
    },
    lifecycle: {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    },
    log: { info: (message) => outcomes.push(JSON.parse(message) as ReplyOutcome) },
  });
}

describe("Knox reply delivery through the core dispatch boundary", () => {
  it.each(["empty-result", "timeout"] as const)(
    "renders the real runner's %s error payload with a correlated Korean diagnosis",
    async (reason) => {
      const sessionCtx = { Provider: "knox", ChatType: "group" };
      const payload =
        reason === "empty-result"
          ? buildEmptyInteractiveReplyPayload({
              isInteractive: true,
              isMessageToolOnly: false,
              hasPendingContinuation: false,
              hasExplicitSilentReply: false,
              hasCommittedDelivery: false,
              sessionCtx,
              cfg: { agents: { defaults: { silentReply: { group: "disallow" } } } },
            })
          : buildKnownAgentRunFailureReplyPayload({
              err: new FailoverError("CLI produced no output and was terminated.", {
                reason: "timeout",
                code: "cli_no_output_timeout",
                provider: "test-cli",
                cliTimeout: {
                  mode: "no-output",
                  timeoutSeconds: 120,
                  observedActivity: true,
                  activeToolCount: 1,
                  backgroundTaskCount: 0,
                },
              }),
              sessionCtx,
              resolvedVerboseLevel: "off",
            });
      expect(payload?.isError).toBe(true);
      await runReplyBoundary(async () => payload);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        status: reason === "timeout" ? "timeout" : "error",
        final: true,
      });
      expect(sent[0]?.text).toContain(`확인 코드: ${reason}`);
      expect(sent[0]?.text).toContain("요청 참조:");
      expect(sent[0]?.text).not.toContain("CLI produced no output");
      expect(outcomes).toContainEqual(expect.objectContaining({ reason }));
      expect(outcomes).not.toContainEqual(expect.objectContaining({ reason: "delivered" }));
    },
  );

  it.each(["room", "dm"] as const)(
    "explains an empty result in %s with one Korean terminal notice",
    async (conversationType) => {
      const resolver = vi.fn(async () => undefined);
      await runReplyBoundary(resolver, randomUUID(), conversationType);
      expect(resolver).toHaveBeenCalledOnce();
      expect(recoveryReasons).toContain("empty-result");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ status: "error", final: true });
      expect(sent[0]?.text).toContain("확인 코드: empty-result");
      expect(sent[0]?.text).toContain("요청 참조:");
      expect(sent[0]?.text).not.toContain("No response was generated");
      const outcome = outcomes.find(({ reason }) => reason === "empty-result");
      expect(outcome?.reference).toMatch(/^[0-9a-f]{12}$/u);
      expect(sent[0]?.text).toContain(`요청 참조: ${outcome?.reference}`);
    },
  );

  it.each(["deny", "message-tool-only"] as const)(
    "honors %s for progress and errors when the resolver throws",
    async (policy) => {
      if (policy === "deny") {
        cfg.session = { ...cfg.session, sendPolicy: { default: "deny" } };
      } else {
        cfg.messages = { visibleReplies: "message_tool" };
      }
      const resolver = vi.fn<ReplyResolver>(async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        // Give the real channel progress timer a chance to fire before failure.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        throw new Error("Synthetic failure under suppressed source delivery");
      });
      account.progressDelayMs = 0;
      try {
        await runReplyBoundary(resolver);
      } finally {
        account.progressDelayMs = 60_000;
      }
      expect(resolver).toHaveBeenCalledOnce();
      expect(sent).toEqual([]);
      expect(outcomes).toContainEqual(expect.objectContaining({ reason: "runtime-error" }));
      expect(outcomes).toContainEqual(
        expect.objectContaining({
          reason: policy === "deny" ? "send-policy-denied" : "message-tool-only",
        }),
      );
    },
  );

  it("respects denial then delivers the next allowed request in the same session", async () => {
    cfg.session = { ...cfg.session, sendPolicy: { default: "deny" } };
    const deniedResolver = vi.fn(async () => ({ text: "정책상 전송하지 않을 답변" }));
    await runReplyBoundary(deniedResolver);
    expect(deniedResolver).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
    expect(outcomes).toContainEqual(expect.objectContaining({ reason: "send-policy-denied" }));
    cfg.session = { ...cfg.session, sendPolicy: { default: "allow" } };
    const allowedResolver = vi.fn(async () => ({ text: "다음 요청의 답변" }));
    await runReplyBoundary(allowedResolver);
    expect(allowedResolver).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "final", final: true });
    expect(sent[0]?.text).toContain("다음 요청의 답변");
  });

  it("delivers a presentation-only result as readable Knox text", async () => {
    const resolver = vi.fn<ReplyResolver>(async () => ({
      presentation: {
        title: "작업 결과",
        blocks: [
          { type: "text", text: "완료했습니다." },
          {
            type: "buttons",
            buttons: [{ label: "상태 확인", action: { type: "command", command: "/status" } }],
          },
        ],
      },
    }));
    await runReplyBoundary(resolver);
    expect(resolver).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "final", final: true });
    expect(sent[0]?.text).toContain("작업 결과\n\n완료했습니다.\n\n- 상태 확인: `/status`");
    expect(recoveryReasons.filter(Boolean)).toEqual([]);
  });

  it("keeps a question prompt nonterminal and delivers a later run failure", async () => {
    const resolver = vi.fn<ReplyResolver>(async (_ctx, options) => {
      await options?.onBlockReply?.({ text: "어떤 대상을 선택할까요?\n1. 서버\n2. VM" });
      throw new Error("Synthetic failure after a visible question prompt");
    });
    await runReplyBoundary(resolver);
    expect(resolver).toHaveBeenCalledOnce();
    expect(sent.map(({ status, final }) => ({ status, final }))).toEqual([
      { status: "progress", final: false },
      { status: "error", final: true },
    ]);
    expect(sent[0]?.text).toContain("어떤 대상을 선택할까요?");
    const outcome = outcomes.find(({ reason }) => reason === "runtime-error");
    expect(outcome?.reference).toMatch(/^[0-9a-f]{12}$/u);
    expect(sent[1]?.text).toContain(`요청 참조: ${outcome?.reference}`);
  });

  it.each(["block-only", "deduped-final"] as const)(
    "closes a completed %s answer after its visible progress",
    async (mode) => {
      const resolver = vi.fn<ReplyResolver>(async (_ctx, options) => {
        await options?.onBlockReply?.({ text: "처리 결과입니다." });
        return mode === "deduped-final" ? { text: "처리 결과입니다." } : undefined;
      });
      await runReplyBoundary(resolver);
      expect(resolver).toHaveBeenCalledOnce();
      expect(sent.map(({ status, final }) => ({ status, final }))).toEqual([
        { status: "progress", final: false },
        { status: "final", final: true },
      ]);
      expect(sent[0]?.text).toContain("처리 결과입니다.");
      expect(sent[1]?.text).toContain("요청 처리가 끝났습니다.");
      expect(outcomes).toContainEqual(expect.objectContaining({ reason: "completed" }));
    },
  );

  it("deduplicates a repeated physical message without resetting shared ingress state", async () => {
    const messageId = randomUUID();
    const resolver = vi.fn(async () => ({ text: "한 번만 전달할 답변" }));
    await runReplyBoundary(resolver, messageId);
    await runReplyBoundary(resolver, messageId);
    expect(resolver).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
  });

  it.each(["rejected", "ack-loss"] as const)(
    "returns relay %s to durable ingress without a contradictory second terminal reply",
    async (failure) => {
      relayFailure = failure;
      const resolver = vi.fn(async () => ({ text: "생성된 답변" }));
      await expect(runReplyBoundary(resolver)).rejects.toMatchObject({
        name: "KnoxOutboundError",
        retryable: true,
      });
      expect(resolver).toHaveBeenCalledOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain("생성된 답변");
      const outcome = outcomes.find(({ reason }) => reason === "delivery-failed");
      expect(outcome).toMatchObject({ event: "knox.reply.outcome" });
      expect(outcome?.reference).toMatch(/^[0-9a-f]{12}$/u);
      expect(outcome?.runId).toMatch(/^knox:/u);
      expect(JSON.stringify(outcomes)).not.toContain(account.serviceToken);
      expect(outcome?.error).toBeTruthy();
      expect(outcome?.error?.length).toBeLessThanOrEqual(1_000);
    },
  );

  it.each([
    { name: "TimeoutError", reason: "timeout", status: "timeout" },
    { name: "AbortError", reason: "cancelled", status: "error" },
  ])(
    "records $reason with a correlated Korean notice and redacted error",
    async ({ name, reason, status }) => {
      const resolver = vi.fn(async () => {
        throw Object.assign(new Error(`Authorization: Bearer ${account.serviceToken}`), { name });
      });
      await runReplyBoundary(resolver);
      expect(resolver).toHaveBeenCalledOnce();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ status, final: true });
      expect(sent[0]?.text).toContain(`확인 코드: ${reason}`);
      expect(sent[0]?.text).not.toContain(account.serviceToken);
      const outcome = outcomes.find((entry) => entry.reason === reason);
      expect(outcome?.reference).toMatch(/^[0-9a-f]{12}$/u);
      expect(sent[0]?.text).toContain(`요청 참조: ${outcome?.reference}`);
      expect(outcome?.error).toBeTruthy();
      expect(JSON.stringify(outcomes)).not.toContain(account.serviceToken);
    },
  );
});
