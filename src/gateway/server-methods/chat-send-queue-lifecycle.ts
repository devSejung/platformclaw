import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
} from "../chat-queued-turns.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { broadcastChatFinal } from "./chat-broadcast.js";
import type { GatewayRequestContext } from "./types.js";

/** Own the admitted request across deferral, cancellation, and actual queue settlement. */
export function createChatSendFollowupLifecycle(params: {
  context: GatewayRequestContext;
  clientRunId: string;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  controller: AbortController;
  lifecycleGeneration: string;
  ownerKey?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  expectedLeafEntryId?: string | null;
  retainWorkAdmission: () => () => void;
}) {
  let state: "none" | "queued" | "settled" = "none";
  let release: (() => void) | undefined;
  let sessionId = params.sessionId;
  const { context, clientRunId, sessionKey, agentId, controller } = params;
  const lifecycle: TurnAdoptionLifecycle = {
    admission: "cancel-only",
    ...(params.expectedLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.expectedLeafEntryId }
      : {}),
    ownerKey: params.ownerKey,
    onAdopted: async () => {},
    onDeferred: () => {
      if (state === "settled") {
        return false;
      }
      const registered = registerQueuedChatTurn({
        chatQueuedTurns: context.chatQueuedTurns,
        runId: clientRunId,
        controller,
        sessionId,
        sessionKey,
        agentId,
        ownerConnId: params.ownerConnId,
        ownerDeviceId: params.ownerDeviceId,
      });
      if (registered) {
        state = "queued";
        // Keep the session fence while detached dispatch returns before queue adoption.
        release ??= params.retainWorkAdmission();
      }
      return registered;
    },
    onCancellationRetired: () => {
      retireQueuedChatTurnCancellation(context.chatQueuedTurns, clientRunId, controller);
    },
    onSettled: () => {
      if (state !== "queued") {
        return;
      }
      state = "settled";
      try {
        const queued = context.chatQueuedTurns.get(clientRunId);
        const active = context.chatAbortControllers.get(clientRunId);
        const ownsIdentity =
          (!queued || queued.controller === controller) &&
          (!active || active.controller === controller);
        // A queue-admission final is not completion. Publish settlement with the
        // original cancellation identity, without overwriting an explicit abort.
        if (
          ownsIdentity &&
          params.lifecycleGeneration === getAgentEventLifecycleGeneration() &&
          !context.chatRunState.hasAbortMarker(clientRunId)
        ) {
          setGatewayDedupeEntry({
            dedupe: context.dedupe,
            key: `chat:${clientRunId}`,
            entry: { ts: Date.now(), ok: true, payload: { runId: clientRunId, status: "ok" } },
          });
          broadcastChatFinal({
            context,
            runId: clientRunId,
            sessionKey,
            agentId,
            queuePhase: "settled",
          });
        }
      } finally {
        completeQueuedChatTurn(context.chatQueuedTurns, clientRunId, controller);
        release?.();
        release = undefined;
      }
    },
  };
  return {
    lifecycle,
    setSessionId: (nextSessionId: string) => {
      if (params.lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
        return;
      }
      sessionId = nextSessionId;
      const queued = context.chatQueuedTurns.get(clientRunId);
      // A deferred callback may outlive its run ID. Rebind only its own cancel
      // entry so session-scoped abort follows compaction without touching reuse.
      if (queued?.controller === controller && queued.sessionKey === sessionKey) {
        queued.sessionId = sessionId;
      }
    },
    isEnqueued: () => state !== "none",
    isSettled: () => state === "settled",
  };
}
