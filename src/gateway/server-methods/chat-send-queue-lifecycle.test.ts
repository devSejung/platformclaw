import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { abortQueuedChatTurnById, registerQueuedChatTurn } from "../chat-queued-turns.js";
import { createChatRunState } from "../server-chat-state.js";
import { createChatSendFollowupLifecycle } from "./chat-send-queue-lifecycle.js";
import type { GatewayRequestContext } from "./types.js";

function fixture() {
  const broadcast = vi.fn();
  const release = vi.fn();
  const controller = new AbortController();
  const context = {
    chatQueuedTurns: new Map(),
    chatAbortControllers: new Map(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getRuntimeConfig: () => ({}),
    broadcast,
    nodeSendToSession: vi.fn(),
  } as unknown as GatewayRequestContext;
  const queue = createChatSendFollowupLifecycle({
    context,
    controller,
    clientRunId: "request",
    sessionId: "session",
    sessionKey: "agent:team:issue",
    agentId: "team",
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    retainWorkAdmission: () => release,
  });
  return { queue, context, controller, broadcast, release };
}

afterEach(() => resetAgentEventsForTest());

describe("chat followup lifecycle", () => {
  it("keeps the original native cancel identity until settlement and publishes it once", () => {
    const f = fixture();
    expect(f.queue.lifecycle.onDeferred?.()).toBe(true);
    expect(f.context.chatQueuedTurns.has("request")).toBe(true);
    expect(f.broadcast).not.toHaveBeenCalled();
    f.queue.lifecycle.onSettled?.();
    f.queue.lifecycle.onSettled?.();
    expect(f.broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat",
      expect.objectContaining({ runId: "request", queuePhase: "settled" }),
      { sessionKeys: ["agent:team:issue"] },
    );
    expect(f.context.chatQueuedTurns.size).toBe(0);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.queue.lifecycle.onDeferred?.()).toBe(false);
  });
  it("retains native cancellation after the admitting dispatch has ended", () => {
    const f = fixture();
    f.queue.lifecycle.onDeferred?.();
    expect(
      abortQueuedChatTurnById(f.context.chatQueuedTurns, {
        runId: "request",
        sessionKey: "agent:team:issue",
      }),
    ).toEqual({ aborted: true });
    expect(f.controller.signal.aborted).toBe(true);
    f.queue.lifecycle.onSettled?.();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it.each(["generation", "replacement"] as const)(
    "does not terminalize a newer %s owner",
    (kind) => {
      const f = fixture();
      f.queue.lifecycle.onDeferred?.();
      if (kind === "generation") {
        rotateAgentEventLifecycleGeneration();
      } else {
        f.controller.abort();
        registerQueuedChatTurn({
          chatQueuedTurns: f.context.chatQueuedTurns,
          runId: "request",
          controller: new AbortController(),
          sessionId: "new-session",
          sessionKey: "agent:team:issue",
        });
      }
      f.queue.lifecycle.onSettled?.();
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.context.dedupe.size).toBe(0);
      expect(f.release).toHaveBeenCalledOnce();
      if (kind === "replacement") {
        expect(f.context.chatQueuedTurns.get("request")?.sessionId).toBe("new-session");
      }
    },
  );
});
