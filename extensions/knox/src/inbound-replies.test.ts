import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  emitAgentEvent,
  onAgentEvent,
  resetAgentEventsForTest,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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

const { resolvePinnedHostnameWithPolicy } = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return { ...actual, resolvePinnedHostnameWithPolicy };
});

type ReplyResolver = NonNullable<ChannelInboundTurnPlan["replyResolver"]>;
type ReplyOptions = NonNullable<Parameters<ReplyResolver>[1]>;
type BoundaryOptions = {
  text?: string;
  controller?: AbortController;
  progressDelayMs?: number;
};
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
  selfInSpaceEnabled: false,
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
let holdProgressRelay: boolean;
let heldProgressSignal: AbortSignal | undefined;
let pendingProgressTurns: Array<() => Promise<void>>;

beforeEach(async () => {
  resetAgentEventsForTest();
  resolvePinnedHostnameWithPolicy.mockReset();
  resolvePinnedHostnameWithPolicy.mockResolvedValue({ addresses: ["93.184.216.34"] });
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
  holdProgressRelay = false;
  heldProgressSignal = undefined;
  pendingProgressTurns = [];
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
      const reply = JSON.parse(init.body) as SentReply;
      sent.push(reply);
      if (holdProgressRelay && !reply.final) {
        const signal = init.signal;
        if (!signal) {
          throw new Error("Expected cancellation for a progress request");
        }
        heldProgressSignal = signal;
        return await new Promise<Response>((_resolve, reject) => {
          const fail = () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Mock relay aborted"),
            );
          signal.addEventListener("abort", fail, { once: true });
          if (signal.aborted) {
            fail();
          }
        });
      }
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
  for (const finish of pendingProgressTurns) {
    await finish();
  }
  vi.useRealTimers();
  resetAgentEventsForTest();
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
  options: BoundaryOptions = {},
): Promise<void> {
  await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
  // Inject only the model result. Admission, source policy, dispatch settlement,
  // the Knox adapter, and relay acknowledgement remain the real production flow.
  setKnoxRuntime({
    config: { current: () => cfg },
    events: { onAgentEvent },
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
    account: { ...account, progressDelayMs: options.progressDelayMs ?? account.progressDelayMs },
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
      message: { type: "text", text: options.text ?? "작업을 진행해주세요" },
    },
    lifecycle: {
      admission: "exclusive",
      abortSignal: (options.controller ?? new AbortController()).signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    },
    log: { info: (message) => outcomes.push(JSON.parse(message) as ReplyOutcome) },
  });
}

async function startProgressBoundary(options: BoundaryOptions = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const runId = randomUUID();
  const controller = options.controller ?? new AbortController();
  let finish!: (reply: ReplyPayload) => void;
  let ready!: (callbacks: ReplyOptions) => void;
  const result = new Promise<ReplyPayload>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<ReplyOptions>((resolve) => {
    ready = resolve;
  });
  const done = runReplyBoundary(
    async (_ctx, callbacks) => {
      if (!callbacks) {
        throw new Error("Expected real dispatch reply callbacks");
      }
      callbacks.onAgentRunStart?.(runId);
      await callbacks.turnAdoptionLifecycle?.onAdopted();
      ready(callbacks);
      return await result;
    },
    randomUUID(),
    "room",
    { progressDelayMs: 10_000, ...options, controller },
  );
  const callbacks = await started;
  const finishTurn = async (reply: ReplyPayload = { text: "Final answer" }) => {
    finish(reply);
    await done;
  };
  pendingProgressTurns.push(async () => {
    controller.abort();
    await finishTurn();
  });
  return {
    done,
    callbacks,
    controller,
    runId,
    emit(stream: string, data: Record<string, unknown>, eventRunId = runId) {
      emitAgentEvent({ runId: eventRunId, stream, data, sessionKey: "agent:test-agent:main" });
    },
    finish: finishTurn,
  };
}

describe("Knox progress through the core dispatch and mock relay", () => {
  it.each([
    { text: "Please inspect this", first: "Processing your request.", running: "Calling exec." },
    {
      text: "Please inspect 한",
      first: "요청을 처리 중입니다.",
      running: "exec 호출 진행 중입니다.",
    },
  ])(
    "uses raw request language and sends changed state at ten-second ticks: $text",
    async ({ text, first, running }) => {
      const turn = await startProgressBoundary({ text });
      turn.emit("tool", {
        phase: "start",
        toolCallId: "exec-1",
        name: "exec",
        args: { command: "private-secret-command" },
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent.map((reply) => reply.text)).toEqual([first]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.map((reply) => reply.text)).toEqual([first, running]);
      turn.emit("command_output", { toolCallId: "exec-1", output: "private-secret-output" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toHaveLength(2);
      turn.emit("tool", {
        phase: "result",
        toolCallId: "exec-1",
        name: "exec",
        status: "completed",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.at(-1)?.text).toBe(
        text.includes("한") ? "exec 호출이 완료됐습니다." : "exec call completed.",
      );
      expect(new Set(sent.map((reply) => reply.requestId)).size).toBe(3);
      expect(JSON.stringify(sent)).not.toContain("private-secret");
      await turn.finish();
      const settledCount = sent.length;
      turn.emit("tool", { phase: "start", toolCallId: "late", name: "late-tool" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toHaveLength(settledCount);
      expect(sent.at(-1)).toMatchObject({ text: "Final answer", final: true });
    },
  );

  it.each([
    { status: "approved", text: "exec execution approved." },
    { status: "denied", text: "exec execution denied." },
    { status: "unavailable", text: "Approval unavailable for exec." },
  ] as const)(
    "observes native approval $status with verbose disabled",
    async ({ status, text }) => {
      const turn = await startProgressBoundary({ text: "Run the command" });
      turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
      turn.emit("approval", {
        phase: "requested",
        status: "pending",
        kind: "exec",
        approvalId: "approval-1",
        toolCallId: "exec-1",
        command: "private-secret-command",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.map((reply) => reply.text)).toEqual(["Awaiting approval for exec."]);
      turn.emit("approval", {
        phase: "resolved",
        status,
        kind: "exec",
        approvalId: "approval-1",
        toolCallId: "exec-1",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.at(-1)?.text).toBe(text);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toHaveLength(2);
      expect(JSON.stringify(sent)).not.toContain("private-secret");
      await turn.finish();
    },
  );

  it("keeps retired approval callbacks from overwriting a same-run fallback", async () => {
    const turn = await startProgressBoundary({ text: "Run the command" });
    turn.emit("tool", { phase: "start", toolCallId: "old-call", name: "bash" });
    turn.emit("approval", {
      phase: "requested",
      status: "pending",
      itemId: "old-call",
      approvalId: "old-approval",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Awaiting approval for bash.");
    turn.emit("approval", {
      phase: "resolved",
      status: "denied",
      itemId: "old-call",
      approvalId: "old-approval",
    });
    turn.emit("lifecycle", { phase: "finishing" });
    turn.emit("lifecycle", { phase: "start", startedAt: Date.now() });
    // Shared producer events are authoritative. A callback held behind an old
    // block acknowledgement can finish after the next attempt has started.
    await turn.callbacks.onApprovalEvent?.({
      phase: "requested",
      status: "pending",
      itemId: "old-call",
      approvalId: "old-approval",
    });
    await turn.callbacks.onApprovalEvent?.({
      phase: "resolved",
      status: "denied",
      itemId: "old-call",
      approvalId: "old-approval",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Processing your request.");
    turn.emit("tool", { phase: "start", toolCallId: "new-call", name: "read" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Calling read.");
    await turn.finish();
  });

  it("prioritizes inline approval over parallel tools and clears only the resolved approval", async () => {
    const turn = await startProgressBoundary({ text: "Run tools" });
    turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    turn.emit("lifecycle", {
      phase: "waiting-approval",
      approvalId: "inline-1",
      toolCallId: "exec-1",
    });
    turn.emit("item", { phase: "start", kind: "tool", toolCallId: "web-1", name: "web" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Awaiting approval for exec.");
    turn.emit("item", {
      phase: "end",
      kind: "tool",
      toolCallId: "web-1",
      name: "web",
      status: "completed",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
    turn.emit("lifecycle", { phase: "approval-resolved", approvalId: "unrelated-approval" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
    turn.emit("lifecycle", {
      phase: "approval-resolved",
      approvalId: "inline-1",
      toolCallId: "exec-1",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Approval wait ended for exec.");
    await turn.finish();
  });

  it("keeps a still-running sibling visible when the newest parallel call finishes", async () => {
    const turn = await startProgressBoundary({ text: "Run tools" });
    await vi.advanceTimersByTimeAsync(10_000);
    turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    turn.emit("tool", { phase: "start", toolCallId: "web-1", name: "web" });
    turn.emit("tool", { phase: "result", toolCallId: "web-1", name: "web", status: "completed" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Calling exec.");
    turn.emit("tool", { phase: "result", toolCallId: "exec-1", name: "exec", isError: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("exec call failed.");
    await turn.finish();
  });

  it("stops progress before awaiting final attachment DNS validation", async () => {
    const turn = await startProgressBoundary({ text: "Produce a report" });
    await vi.advanceTimersByTimeAsync(10_000);
    turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    let enterDns!: () => void;
    let releaseDns!: () => void;
    const enteredDns = new Promise<void>((resolve) => {
      enterDns = resolve;
    });
    const dns = new Promise<void>((resolve) => {
      releaseDns = resolve;
    });
    resolvePinnedHostnameWithPolicy.mockImplementationOnce(async () => {
      enterDns();
      await dns;
      return { addresses: ["93.184.216.34"] };
    });
    const finishing = turn.finish({
      text: "Final report",
      mediaUrl: "https://example.com/report.pdf",
    });
    await enteredDns;
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent.map((reply) => reply.text)).toEqual(["Processing your request."]);
    } finally {
      releaseDns();
      await finishing;
    }
    expect(sent.at(-1)).toMatchObject({ final: true });
  });

  it.each(["abort", "end", "error"] as const)(
    "stops immediately on %s while the resolver remains pending",
    async (stop) => {
      const turn = await startProgressBoundary({ text: "Run tools" });
      await vi.advanceTimersByTimeAsync(10_000);
      if (stop === "abort") {
        turn.controller.abort();
      } else {
        turn.emit("lifecycle", { phase: stop });
      }
      turn.emit("tool", { phase: "start", toolCallId: "late", name: "late-tool" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent.map((reply) => reply.text)).toEqual(["Processing your request."]);
      await turn.finish();
    },
  );

  it("keeps periodic tool updates after a nonterminal block reply", async () => {
    const turn = await startProgressBoundary({ text: "Run tools" });
    await vi.advanceTimersByTimeAsync(10_000);
    await turn.callbacks.onBlockReply?.({ text: "Intermediate result" });
    turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map((reply) => reply.text)).toEqual([
      "Processing your request.",
      "Intermediate result",
      "Calling exec.",
    ]);
    expect(sent.every((reply) => !reply.final)).toBe(true);
    await turn.finish();
  });

  it("does not inherit old run state or language across requests sharing a session", async () => {
    const first = await startProgressBoundary({ text: "한국어 요청" });
    first.emit("tool", { phase: "start", toolCallId: "old-tool", name: "old-private-tool" });
    first.emit("lifecycle", {
      phase: "waiting-approval",
      approvalId: "old-approval",
      toolCallId: "old-tool",
    });
    first.controller.abort();
    await first.finish();
    sent = [];
    const second = await startProgressBoundary({ text: "English request" });
    second.emit(
      "tool",
      { phase: "start", toolCallId: "old-tool", name: "old-private-tool" },
      first.runId,
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.map((reply) => reply.text)).toEqual(["Processing your request."]);
    second.emit("tool", { phase: "start", toolCallId: "new-tool", name: "web" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)?.text).toBe("Calling web.");
    expect(JSON.stringify(sent)).not.toContain("old-private-tool");
    await second.finish();
  });

  it.each(["deny", "message-tool-only"] as const)(
    "keeps automatic progress suppressed under %s",
    async (policy) => {
      if (policy === "deny") {
        cfg.session = { ...cfg.session, sendPolicy: { default: "deny" } };
      } else {
        cfg.messages = { visibleReplies: "message_tool" };
      }
      const turn = await startProgressBoundary({ text: "Run tools" });
      turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
      turn.emit("approval", {
        phase: "requested",
        status: "pending",
        approvalId: "approval-1",
        toolCallId: "exec-1",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toEqual([]);
      await turn.finish();
      expect(sent).toEqual([]);
    },
  );

  it("cancels an outstanding progress relay request and starts no further sends after abort", async () => {
    holdProgressRelay = true;
    const turn = await startProgressBoundary({ text: "Run tools" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(1);
    expect(heldProgressSignal?.aborted).toBe(false);
    turn.controller.abort();
    expect(heldProgressSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sent).toHaveLength(1);
    holdProgressRelay = false;
    await turn.finish();
  });
});

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
