import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
  setReplyPayloadMetadata,
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
  conversationType?: "dm" | "room";
};
type SentReply = { status: string; text: string; final: boolean; requestId: string; runId: string };
type CancelledReply = {
  requestId: string;
  targetRequestId: string;
  targetRunId: string;
  runId: string;
};
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
let cancelled: CancelledReply[];
let relayOperations: Array<{ kind: "send" | "cancel" | "status"; requestId: string }>;
let recoveryReasons: Array<NoVisibleReplyReason | undefined>;
let cfg: OpenClawConfig;
let outcomes: ReplyOutcome[];
let relayFailure: "rejected" | "ack-loss" | undefined;
let holdProgressRelay: boolean;
let heldProgressSignal: AbortSignal | undefined;
let heldProgressRelease: (() => void) | undefined;
let holdTerminalRelay: boolean;
let heldTerminalRelease: (() => void) | undefined;
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
  cancelled = [];
  relayOperations = [];
  recoveryReasons = [];
  outcomes = [];
  relayFailure = undefined;
  holdProgressRelay = false;
  heldProgressSignal = undefined;
  heldProgressRelease = undefined;
  holdTerminalRelay = false;
  heldTerminalRelease = undefined;
  pendingProgressTurns = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url === account.controlPlaneUrl) {
        return Response.json({
          status: "resolved",
          agentId: "test-agent",
          sessionKey: "agent:test-agent:main",
          senderLinked: true,
          executionTarget: "platform_server",
        });
      }
      const relayUrl = new URL(url);
      if (relayUrl.pathname === "/cancel") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a cancel JSON body");
        }
        const request = JSON.parse(init.body) as CancelledReply;
        cancelled.push(request);
        relayOperations.push({ kind: "cancel", requestId: request.targetRequestId });
        return Response.json({ ok: true, state: "cancelled", outcome: "recalled" });
      }
      if (relayUrl.pathname === "/status") {
        const requestId = relayUrl.searchParams.get("requestId") ?? "";
        relayOperations.push({ kind: "status", requestId });
        return Response.json({
          ok: true,
          state: "failed",
          retryable: true,
          message: "Synthetic relay failure",
        });
      }
      expect(url).toBe(account.outboundUrl);
      if (typeof init?.body !== "string") {
        throw new Error("Expected a relay JSON body");
      }
      const reply = JSON.parse(init.body) as SentReply;
      sent.push(reply);
      relayOperations.push({ kind: "send", requestId: reply.requestId });
      const holdProgress = holdProgressRelay && reply.requestId.startsWith("progress:");
      if (holdProgress || (holdTerminalRelay && reply.final)) {
        const signal = init.signal;
        if (!signal) {
          throw new Error("Expected cancellation for a progress request");
        }
        if (holdProgress) {
          heldProgressSignal = signal;
        }
        return await new Promise<Response>((resolve, reject) => {
          const fail = () =>
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Mock relay aborted"),
            );
          signal.addEventListener("abort", fail, { once: true });
          const release = () => {
            signal.removeEventListener("abort", fail);
            resolve(Response.json({ ok: true, messageId: `receipt:${reply.requestId}` }));
          };
          if (holdProgress) {
            heldProgressRelease = release;
          } else {
            heldTerminalRelease = release;
          }
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
    options.conversationType ?? "room",
    { progressDelayMs: 15_000, ...options, controller },
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

describe("Knox digest through the core dispatch and mock relay", () => {
  it.each(["Please inspect this", "Please inspect 한", "프로젝트를 확인해주세요"])(
    "polls every fifteen seconds and replaces only changed English digests: %s",
    async (text) => {
      const turn = await startProgressBoundary({ text });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent.map((reply) => reply.text)).toEqual(["⏳ Processing request"]);
      const first = sent[0]!;
      turn.emit("tool", {
        phase: "start",
        toolCallId: "exec-1",
        name: "exec",
        args: { command: "node task.js", token: "PRIVATE_TOKEN" },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent.at(-1)?.text).toBe("⏳ exec · node task.js");
      const second = sent[1]!;
      expect(relayOperations.slice(0, 3)).toEqual([
        { kind: "send", requestId: first.requestId },
        { kind: "send", requestId: second.requestId },
        { kind: "cancel", requestId: first.requestId },
      ]);
      turn.emit("tool", {
        phase: "update",
        toolCallId: "exec-1",
        name: "exec",
        args: { command: "node task.js" },
      });
      turn.emit("command_output", { toolCallId: "exec-1", output: "PRIVATE_OUTPUT" });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent).toHaveLength(2);
      expect(cancelled).toHaveLength(1);
      turn.emit("tool", {
        phase: "result",
        toolCallId: "exec-1",
        name: "exec",
        status: "completed",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent.at(-1)?.text).toBe("✓ exec · node task.js");
      expect(JSON.stringify(sent)).not.toMatch(/PRIVATE_TOKEN|PRIVATE_OUTPUT/);
      const current = sent.at(-1)!;
      await turn.finish();
      expect(relayOperations.at(-2)).toEqual({ kind: "send", requestId: sent.at(-1)!.requestId });
      expect(relayOperations.at(-1)).toEqual({ kind: "cancel", requestId: current.requestId });
      expect(
        cancelled.every((item) => item.targetRunId === first.runId && item.runId === first.runId),
      ).toBe(true);
      const count = sent.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toHaveLength(count);
    },
  );

  it.each(["Inspect the file", "파일을 확인해주세요"])(
    "shows completed history alone on the first sample: %s",
    async (text) => {
      const turn = await startProgressBoundary({ text });
      turn.emit("tool", {
        phase: "start",
        toolCallId: "read-1",
        name: "read",
        args: { path: "/workspace/설정.ts" },
      });
      turn.emit("tool", {
        phase: "result",
        toolCallId: "read-1",
        name: "read",
        status: "completed",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent.map((reply) => reply.text)).toEqual(["✓ read · 설정.ts"]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toHaveLength(1);
      expect(cancelled).toEqual([]);
      const notice = sent[0]!;
      await turn.finish();
      expect(cancelled.map((item) => item.targetRequestId)).toEqual([notice.requestId]);
    },
  );

  it("keeps the confirmed notice until its replacement acknowledgement arrives", async () => {
    const turn = await startProgressBoundary({ text: "Run commands" });
    await vi.advanceTimersByTimeAsync(15_000);
    const original = sent[0]!;
    holdProgressRelay = true;
    turn.emit("tool", {
      phase: "start",
      toolCallId: "replacement",
      name: "exec",
      args: { command: "node replacement.js" },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent).toHaveLength(2);
    expect(heldProgressRelease).toBeDefined();
    expect(cancelled).toEqual([]);
    heldProgressRelease!();
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled.map((item) => item.targetRequestId)).toEqual([original.requestId]);
    expect(sent[1]?.text).toBe("⏳ exec · node replacement.js");
    holdProgressRelay = false;
    await turn.finish();
  });

  it.each(["cancelled", "aborted"] as const)(
    "recalls progress immediately for authoritative native %s without aborting the ingress signal",
    async (reason) => {
      const turn = await startProgressBoundary({ text: "Run commands" });
      await vi.advanceTimersByTimeAsync(15_000);
      const notice = sent[0]!;
      holdTerminalRelay = true;
      const payload = setReplyPayloadMetadata(
        { text: "Native execution stopped", isError: true },
        {
          agentRunTerminalOutcome: { status: "error", reason },
        },
      );
      const finishing = turn.finish(payload);
      try {
        await vi.waitFor(() => expect(heldTerminalRelease).toBeDefined());
        expect(turn.controller.signal.aborted).toBe(false);
        expect(cancelled.map((item) => item.targetRequestId)).toEqual([notice.requestId]);
        expect(sent.at(-1)).toMatchObject({ status: "error", final: true });
        expect(sent.at(-1)?.text).toContain("확인 코드: cancelled");
      } finally {
        holdTerminalRelay = false;
        heldTerminalRelease?.();
        await finishing;
      }
    },
  );

  it("keeps only the latest five terminal calls in chronology and puts active work last", async () => {
    const turn = await startProgressBoundary({ text: "Inspect files" });
    for (let index = 0; index < 7; index += 1) {
      turn.emit("tool", {
        phase: "start",
        toolCallId: "read-" + index,
        name: "read",
        args: { path: "/workspace/step-" + index + ".ts" },
      });
      turn.emit("tool", {
        phase: "result",
        toolCallId: "read-" + index,
        name: "read",
        status: "completed",
      });
      await vi.advanceTimersByTimeAsync(1_500);
    }
    turn.emit("tool", {
      phase: "start",
      toolCallId: "active",
      name: "exec",
      args: { command: "node busy.js" },
    });
    await vi.advanceTimersByTimeAsync(4_500);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.split("\n")).toEqual([
      "✓ read · step-2.ts",
      "✓ read · step-3.ts",
      "✓ read · step-4.ts",
      "✓ read · step-5.ts",
      "✓ read · step-6.ts",
      "⏳ exec · node busy.js",
    ]);
    await turn.finish();
  });

  it.each([
    { status: "approved", result: "✓ Approved exec" },
    { status: "denied", result: "– Denied exec" },
    { status: "unavailable", result: "? Approval unavailable exec" },
  ] as const)(
    "shows authoritative native approval $status under default verbose",
    async ({ status, result }) => {
      const turn = await startProgressBoundary({ text: "Run commands" });
      turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
      turn.emit("approval", {
        phase: "requested",
        status: "pending",
        approvalId: "approval-1",
        toolCallId: "exec-1",
        command: "PRIVATE_APPROVAL_COMMAND",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent[0]?.text).toContain("? Awaiting approval exec");
      turn.emit("approval", {
        phase: "resolved",
        status,
        approvalId: "approval-1",
        toolCallId: "exec-1",
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent.at(-1)?.text).toContain(result);
      expect(sent.at(-1)?.text).not.toContain("⏳ exec");
      expect(JSON.stringify(sent)).not.toContain("PRIVATE_APPROVAL_COMMAND");
      await turn.finish();
    },
  );

  it("preserves running siblings and distinguishes failed calls from inline approval resolution", async () => {
    const turn = await startProgressBoundary({ text: "Run tools" });
    turn.emit("tool", {
      phase: "start",
      toolCallId: "a",
      name: "exec",
      args: { command: "node a.js" },
    });
    turn.emit("tool", {
      phase: "start",
      toolCallId: "b",
      name: "exec",
      args: { command: "node b.js" },
    });
    turn.emit("tool", { phase: "result", toolCallId: "b", name: "exec", isError: true });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent[0]?.text.split("\n")).toEqual(["✗ exec · node b.js", "⏳ exec · node a.js"]);
    turn.emit("lifecycle", { phase: "waiting-approval", approvalId: "inline-a", toolCallId: "a" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent.at(-1)?.text).toContain("? Awaiting approval exec");
    turn.emit("lifecycle", { phase: "approval-resolved", approvalId: "inline-a", toolCallId: "a" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent.at(-1)?.text).toContain("? Approval ended exec");
    expect(sent.at(-1)?.text).not.toContain("Approved");
    await turn.finish();
  });

  it.each(["abort", "end", "error"] as const)(
    "stops and recalls its own latest notice on %s",
    async (stop) => {
      const turn = await startProgressBoundary({ text: "Run tools" });
      await vi.advanceTimersByTimeAsync(15_000);
      const notice = sent[0]!;
      if (stop === "abort") {
        turn.controller.abort();
      } else {
        turn.emit("lifecycle", { phase: stop });
      }
      turn.emit("tool", { phase: "start", toolCallId: "late", name: "late-tool" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toHaveLength(1);
      await turn.finish();
      expect(cancelled.map((item) => item.targetRequestId)).toEqual([notice.requestId]);
    },
  );

  it("never recalls block replies, questions, or the final answer", async () => {
    const turn = await startProgressBoundary({ text: "Run tools" });
    await vi.advanceTimersByTimeAsync(15_000);
    await turn.callbacks.onBlockReply?.({ text: "Intermediate result" });
    await turn.callbacks.onBlockReply?.({
      text: "Which target?",
      channelData: { askUser: { questionId: "question-1" } },
    });
    turn.emit("tool", {
      phase: "start",
      toolCallId: "exec-1",
      name: "exec",
      args: { command: "node a.js" },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await turn.finish();
    const permanent = sent.filter((reply) => !reply.requestId.startsWith("progress:"));
    expect(permanent.map((reply) => reply.text)).toEqual([
      "Intermediate result",
      "Which target?",
      "Final answer",
    ]);
    expect(cancelled.every((item) => item.targetRequestId.startsWith("progress:"))).toBe(true);
    expect(
      cancelled.some((item) => permanent.some((reply) => reply.requestId === item.targetRequestId)),
    ).toBe(false);
  });

  it("cancels an original progress key after a pending HTTP acknowledgement loses the race to final", async () => {
    holdProgressRelay = true;
    const turn = await startProgressBoundary({ text: "Run tools" });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sent).toHaveLength(1);
    const original = sent[0]!;
    expect(heldProgressSignal?.aborted).toBe(false);
    holdProgressRelay = false;
    await turn.finish();
    expect(heldProgressSignal?.aborted).toBe(true);
    expect(sent.at(-1)).toMatchObject({ text: "Final answer", final: true });
    expect(cancelled).toContainEqual(
      expect.objectContaining({
        requestId: "cancel:" + original.requestId,
        targetRequestId: original.requestId,
        targetRunId: original.runId,
      }),
    );
    const finalIndex = relayOperations.findIndex(
      (operation) => operation.kind === "send" && operation.requestId === sent.at(-1)?.requestId,
    );
    const cancelIndex = relayOperations.findIndex(
      (operation) => operation.kind === "cancel" && operation.requestId === original.requestId,
    );
    expect(finalIndex).toBeLessThan(cancelIndex);
  });

  it("stops observations before waiting for final attachment DNS but keeps the notice until final confirms", async () => {
    const turn = await startProgressBoundary({ text: "Produce a report" });
    await vi.advanceTimersByTimeAsync(15_000);
    let enterDns!: () => void;
    let releaseDns!: () => void;
    const entered = new Promise<void>((resolve) => {
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
    await entered;
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toHaveLength(1);
      expect(cancelled).toEqual([]);
    } finally {
      releaseDns();
      await finishing;
    }
    expect(sent.at(-1)?.final).toBe(true);
    expect(cancelled).toHaveLength(1);
  });

  it.each(["deny", "message-tool-only"] as const)(
    "honors automatic source suppression under %s",
    async (policy) => {
      if (policy === "deny") {
        cfg.session = { ...cfg.session, sendPolicy: { default: "deny" } };
      } else {
        cfg.messages = { visibleReplies: "message_tool" };
      }
      const turn = await startProgressBoundary({ text: "Run tools" });
      turn.emit("tool", { phase: "start", toolCallId: "exec-1", name: "exec" });
      await vi.advanceTimersByTimeAsync(45_000);
      await turn.finish();
      expect(sent).toEqual([]);
      expect(cancelled).toEqual([]);
    },
  );

  it("reflects a real Node process with long arguments and path without leaking output", async () => {
    const turn = await startProgressBoundary({
      text: "Execute the long command",
      conversationType: "dm",
    });
    const commandDir = path.join(stateDir, "long-command-path-".repeat(6));
    await fs.mkdir(commandDir);
    const script = path.join(commandDir, "wait-for-input.cjs");
    await fs.writeFile(
      script,
      'process.stdout.write("READY\\n");process.stdin.once("data",()=>process.stdout.write("PRIVATE_OUTPUT_TOKEN",()=>process.exit(0)));',
    );
    const args = [script, "--long-argument=" + "x".repeat(300), "--token=PRIVATE_ARG_TOKEN"];
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    try {
      await once(child.stdout, "data");
      expect(child.exitCode).toBeNull();
      const command = [process.execPath, ...args].map((part) => JSON.stringify(part)).join(" ");
      expect(command.length).toBeGreaterThan(400);
      turn.emit("tool", {
        phase: "start",
        toolCallId: "real-command",
        name: "exec",
        args: { command },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent.at(-1)!.text).toContain("🟠 Using PlatformClaw server\n\n");
      const running = sent.at(-1)!.text.split("\n").at(-1)!;
      expect(running).toMatch(/^⏳ exec · /u);
      expect([
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(running),
      ]).toHaveLength(50);
      expect(running.endsWith("…")).toBe(true);
      const exited = once(child, "exit");
      child.stdin.end("\n");
      expect((await exited)[0]).toBe(0);
      expect(output).toContain("PRIVATE_OUTPUT_TOKEN");
      turn.emit("tool", {
        phase: "result",
        toolCallId: "real-command",
        name: "exec",
        isError: false,
        result: { output },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(
        sent
          .at(-1)
          ?.text.split("\n")
          .some((line) => line.startsWith("✓ exec · ")),
      ).toBe(true);
      const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      expect(
        sent
          .flatMap((reply) => reply.text.split("\n"))
          .every((line) => [...graphemes.segment(line)].length <= 50),
      ).toBe(true);
      expect(
        sent.every(
          (reply) =>
            [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(reply.text)]
              .length <= 400,
        ),
      ).toBe(true);
      expect(JSON.stringify(sent)).not.toMatch(/PRIVATE_OUTPUT_TOKEN|PRIVATE_ARG_TOKEN/);
      await turn.finish();
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
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
