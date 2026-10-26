import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test-utils/deferred.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { chatSendScopeDedupeKey, pendingChatSendDedupeKey } from "../server-shared.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { requireChatSendScope } from "./chat-send-scope.js";
import { prepareAndAdmitChatSend } from "./chat-send-setup.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const scopeMocks = vi.hoisted(() => ({
  resolveDurableChatClaim: vi.fn(async () => ({ kind: "continue" as const })),
}));

const config = {
  agents: { entries: { alice: { default: true }, bob: {} } },
};

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: (key: string) => ({
      cfg: config,
      canonicalKey: key,
      storePath: `/test/${key.split(":")[1]}/sessions.json`,
      entry: { sessionId: `session-${key.split(":")[1]}` },
    }),
    resolveDeletedAgentIdFromSessionKey: () => null,
    resolveSessionModelRef: () => ({ provider: "test-provider", model: "test-model" }),
  };
});

vi.mock("./chat-restart-recovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-restart-recovery.js")>();
  return { ...actual, resolveDurableChatClaim: scopeMocks.resolveDurableChatClaim };
});

function admit(
  context: GatewayRequestContext,
  agentId: string,
  runId: string,
  options: { sessionKey?: string; client?: GatewayClient | null } = {},
) {
  const respond = vi.fn();
  const work = prepareAndAdmitChatSend({
    context,
    client: options.client ?? null,
    respond,
    params: {
      sessionKey: options.sessionKey ?? `agent:${agentId}:main`,
      agentId,
      message: "hello",
      idempotencyKey: runId,
    },
  });
  return { respond, work };
}

function expectCollision(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({
      code: "INVALID_REQUEST",
      details: { reason: "idempotency-key-conflict" },
    }),
  );
}

describe("chat send scope admission", () => {
  beforeEach(() => {
    scopeMocks.resolveDurableChatClaim.mockReset().mockResolvedValue({ kind: "continue" });
  });

  it.each(["operator.admin", "operator.write"])(
    "does not replay a legacy %s sender's result to the same restricted human",
    (scope) => {
      const context = createDirectChatContext();
      const client: GatewayClient = {
        connect: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: GATEWAY_CLIENT_NAMES.CLI,
            version: "test",
            platform: "test",
            mode: GATEWAY_CLIENT_MODES.CLI,
          },
          scopes: [scope],
        },
      };
      const owner = {
        context,
        client,
        respond: vi.fn(),
        runId: "same-human-authority-change",
        agentId: "alice",
        sessionKey: "agent:alice:main",
        senderAttribution: { id: "alice" },
      };
      expect(requireChatSendScope(owner)).toBeDefined();
      context.dedupe.set(`chat:${owner.runId}`, {
        ts: Date.now(),
        ok: true,
        payload: { status: "ok" },
      });
      const restricted = {
        ...owner,
        respond: vi.fn(),
        senderAttribution: { id: "alice", isOwner: false as const },
      };
      expect(requireChatSendScope(restricted)).toBeUndefined();
      expectCollision(restricted.respond);
    },
  );

  it("rejects another Agent's completed key and preserves its owner's cached replay", async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const first = admit(context, "alice", "completed-scope");
    const admitted = expectDefined(await first.work, "first send admission");
    admitted.admitted.value.cleanupAdmittedRun({ force: true });
    const payload = { runId: "completed-scope", status: "ok" };
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: "chat:completed-scope",
      entry: { ts: Date.now(), ok: true, payload },
    });

    const foreign = admit(context, "bob", "completed-scope");
    await expect(foreign.work).resolves.toBeUndefined();
    expectCollision(foreign.respond);
    const replay = admit(context, "alice", "completed-scope");
    await expect(replay.work).resolves.toBeUndefined();
    expect(replay.respond).toHaveBeenCalledExactlyOnceWith(true, payload, undefined, {
      cached: true,
    });
    expect(scopeMocks.resolveDurableChatClaim).toHaveBeenCalledTimes(1);
  });

  it("does not treat a completed Agent's retained projections as live send ownership", async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const runId = "stale-agent-projections";
    const terminal = { ts: Date.now(), ok: true, payload: { runId, status: "ok" } };
    setGatewayDedupeEntry({ dedupe: context.dedupe, key: `agent:${runId}`, entry: terminal });
    context.chatRunState.registry.add(runId, {
      sessionKey: "agent:alice:main",
      agentId: "alice",
      clientRunId: runId,
    });
    context.chatRunState.toolEventRecipients.add(runId, "previous-agent-client");
    context.chatRunState.toolEventRecipients.markFinal(runId);
    expect(context.chatRunState.runs.get(runId)).toMatchObject({
      registrations: [expect.objectContaining({ sessionKey: "agent:alice:main" })],
      toolRecipient: { finalizedAt: expect.any(Number) },
    });

    const first = admit(context, "alice", runId);
    const admitted = expectDefined(await first.work, "new chat send admission");
    try {
      expect(first.respond).not.toHaveBeenCalled();
      expect(context.chatAbortControllers.get(runId)).toMatchObject({
        kind: "chat-send",
        sessionKey: "agent:alice:main",
      });
      expect(context.dedupe.get(`agent:${runId}`)).toBe(terminal);
      expect(scopeMocks.resolveDurableChatClaim).toHaveBeenCalledTimes(1);
    } finally {
      admitted.admitted.value.cleanupAdmittedRun({ force: true });
    }
  });

  it("rejects retained foreign delivery registrations before a reused id can emit new output", async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const runId = "stale-foreign-agent-route";
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${runId}`,
      entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    });
    context.chatRunState.registry.add(runId, {
      sessionKey: "agent:bob:main",
      agentId: "bob",
      clientRunId: runId,
    });
    context.chatRunState.toolEventRecipients.add(runId, "bob-client");
    context.chatRunState.toolEventRecipients.markFinal(runId);

    const foreign = admit(context, "alice", runId);
    await expect(foreign.work).resolves.toBeUndefined();
    expectCollision(foreign.respond);
    expect(context.chatAbortControllers.has(runId)).toBe(false);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(scopeMocks.resolveDurableChatClaim).not.toHaveBeenCalled();
    expect(context.chatRunState.registry.peek(runId)?.sessionKey).toBe("agent:bob:main");
    expect(context.chatRunState.toolEventRecipients.get(runId)).toEqual(new Set(["bob-client"]));
  });

  it("rejects an active Agent controller even when a matching chat scope and old terminal snapshot exist", async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const runId = "active-agent-over-old-chat";
    const first = admit(context, "alice", runId);
    const priorChat = expectDefined(await first.work, "prior chat admission");
    priorChat.admitted.value.cleanupAdmittedRun({ force: true });
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${runId}`,
      entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    });
    const activeAgent = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      agentId: "alice",
      sessionKey: "agent:alice:main",
      sessionId: "session-alice",
      timeoutMs: 60_000,
      kind: "agent",
    });
    try {
      expect(activeAgent.registered).toBe(true);
      const collision = admit(context, "alice", runId);
      await expect(collision.work).resolves.toBeUndefined();
      expectCollision(collision.respond);
      expect(context.chatAbortControllers.get(runId)?.kind).toBe("agent");
      expect(scopeMocks.resolveDurableChatClaim).toHaveBeenCalledTimes(1);
    } finally {
      activeAgent.cleanup({ force: true });
    }
  });

  it("rejects another session while preserving the owner's active replay and run id", async () => {
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const first = admit(context, "alice", "active-scope");
    const admitted = expectDefined(await first.work, "first send admission");
    try {
      for (const { agentId, sessionKey } of [
        { agentId: "bob", sessionKey: "agent:bob:main" },
        { agentId: "alice", sessionKey: "agent:alice:other" },
      ]) {
        const foreign = admit(context, agentId, "active-scope", { sessionKey });
        await expect(foreign.work).resolves.toBeUndefined();
        expectCollision(foreign.respond);
      }
      const replay = admit(context, "alice", "active-scope");
      await expect(replay.work).resolves.toBeUndefined();
      expect(replay.respond).toHaveBeenCalledExactlyOnceWith(
        true,
        { runId: "active-scope", status: "in_flight" },
        undefined,
        { cached: true, runId: "active-scope" },
      );
      expect(context.chatAbortControllers.size).toBe(1);
    } finally {
      admitted.admitted.value.cleanupAdmittedRun({ force: true });
    }
  });

  it("reserves the scope before asynchronous recovery and refuses a changed claim at admission", async () => {
    const recoveryEntered = createDeferred();
    const releaseRecovery = createDeferred();
    scopeMocks.resolveDurableChatClaim.mockImplementationOnce(async () => {
      recoveryEntered.resolve(undefined);
      await releaseRecovery.promise;
      return { kind: "continue" };
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const first = admit(context, "alice", "recovery-scope");
    await recoveryEntered.promise;
    const foreign = admit(context, "bob", "recovery-scope");
    await expect(foreign.work).resolves.toBeUndefined();
    expectCollision(foreign.respond);
    // Model a retired scope being replaced while recovery is suspended.
    context.dedupe.delete(chatSendScopeDedupeKey("recovery-scope"));
    const replacement = admit(context, "bob", "recovery-scope");
    const admitted = expectDefined(await replacement.work, "replacement admission");
    releaseRecovery.resolve(undefined);
    await expect(first.work).resolves.toBeUndefined();
    expectCollision(first.respond);
    admitted.admitted.value.cleanupAdmittedRun({ force: true });
  });

  it("binds the human owner while allowing the same user to reconnect", async () => {
    const client = (userId: string, connId: string): GatewayClient => ({
      authenticatedUserId: userId,
      connId,
      connect: {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
          version: "test",
          platform: "test",
        },
        role: "operator",
        scopes: ["operator.admin"],
      },
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => config });
    const first = admit(context, "alice", "human-scope", { client: client("one", "socket-1") });
    const admitted = expectDefined(await first.work, "first send admission");
    try {
      const foreign = admit(context, "alice", "human-scope", { client: client("two", "socket-2") });
      await expect(foreign.work).resolves.toBeUndefined();
      expectCollision(foreign.respond);
      const replay = admit(context, "alice", "human-scope", { client: client("one", "socket-3") });
      await expect(replay.work).resolves.toBeUndefined();
      expect(replay.respond).toHaveBeenCalledWith(
        true,
        { runId: "human-scope", status: "in_flight" },
        undefined,
        { cached: true, runId: "human-scope" },
      );
    } finally {
      admitted.admitted.value.cleanupAdmittedRun({ force: true });
    }
  });

  it.each(["cached", "pending", "active", "queued", "aborted"])(
    "fails closed on %s state without a recorded owner",
    async (state) => {
      const context = createDirectChatContext({
        getRuntimeConfig: () => config,
        chatQueuedTurns: new Map(),
      });
      const runId = `unowned-${state}`;
      const entry = { sessionKey: "agent:bob:main", sessionId: "bob-session" };
      if (state === "cached" || state === "pending") {
        context.dedupe.set(state === "cached" ? `chat:${runId}` : pendingChatSendDedupeKey(runId), {
          ts: Date.now(),
          ok: true,
          payload: { ...entry, runId, status: state === "cached" ? "ok" : "accepted" },
        });
      } else if (state === "active") {
        context.chatAbortControllers.set(runId, {
          ...entry,
          controller: new AbortController(),
          startedAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          kind: "chat-send",
        });
      } else if (state === "queued") {
        context.chatQueuedTurns.set(runId, { ...entry, controller: new AbortController() });
      } else {
        context.chatRunState.getOrCreate(runId).abortMarker = Date.now();
      }
      const foreign = admit(context, "alice", runId);
      await expect(foreign.work).resolves.toBeUndefined();
      expectCollision(foreign.respond);
      expect(scopeMocks.resolveDurableChatClaim).not.toHaveBeenCalled();
    },
  );
});
