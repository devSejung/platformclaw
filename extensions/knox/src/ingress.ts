import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveKnoxCommandText } from "./command-text.js";
import type { KnoxQuestionAnswerBinding } from "./input-routing.js";
import { normalizeKnoxInbound } from "./normalize.js";
import { KnoxOutboundError } from "./outbound.js";
import { parseKnoxRoute, type KnoxRouteResolution } from "./routing-client.js";
import { getKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage } from "./types.js";

const VERSION = 1;

type StoredKnoxIngress = { version: number; rawEvent: string };
type AdmittedKnoxMessage = KnoxInboundMessage & {
  questionAnswerBinding?: KnoxQuestionAnswerBinding;
  selfInSpaceRoute?: KnoxRouteResolution;
};
export type KnoxIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "onAdoptionFinalizing">;

export const KnoxIngressPermanentError = createChannelIngressError<
  "agent-unavailable" | "invalid-event" | "login-required" | "room-disabled"
>("KnoxIngressPermanentError", { withReason: true });

export function createKnoxIngress(options: {
  accountId: string;
  executionMode?: "self_in_space";
  queue?: ChannelIngressQueue<StoredKnoxIngress>;
  dispatch: (
    message: KnoxInboundMessage,
    lifecycle: KnoxIngressLifecycle,
    questionAnswerBinding?: KnoxQuestionAnswerBinding,
    selfInSpaceRoute?: KnoxRouteResolution,
  ) => Promise<void>;
  resolveSelfInSpaceRoute?: (message: KnoxInboundMessage) => Promise<KnoxRouteResolution>;
  resolveQuestionAnswerBinding?: (
    message: KnoxInboundMessage,
  ) => Promise<KnoxQuestionAnswerBinding | undefined>;
  notifyQueued?: (
    message: KnoxInboundMessage,
    context: { aheadCount: number; abortSignal: AbortSignal; route?: KnoxRouteResolution },
  ) => Promise<void>;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}) {
  const inspect = (
    message: AdmittedKnoxMessage,
    context?: { phase: "admission" | "claim"; claimedLaneKey?: string },
  ) => {
    if (message.schemaVersion === 2) {
      return {
        eventId: message.messageId,
        laneKey:
          message.selfInSpaceRoute?.status === "resolved"
            ? message.selfInSpaceRoute.sessionKey
            : `rejected:${message.messageId}`,
      };
    }
    const command = resolveKnoxCommandText(message.message.text).trim().split(/\s+/u)[0];
    const control = command?.toLowerCase() === "/stop" || command?.toLowerCase() === "/approve";
    const conversationId = message.conversation.conversationId;
    return {
      eventId: message.messageId,
      // The durable binding survives reclaim; a stale answer must never become
      // ordinary work or answer a replacement question sharing the same choices.
      laneKey:
        control ||
        message.questionAnswerBinding ||
        (context?.phase === "claim" && context.claimedLaneKey === `${conversationId}:control`)
          ? `${conversationId}:control`
          : conversationId,
    };
  };
  let queue = options.queue;
  const resolveQueue = () =>
    (queue ??= getKnoxRuntime().state.openChannelIngressQueue<StoredKnoxIngress>({
      // A separate tuple namespace cannot collide with any ordinary account ID.
      accountId: options.accountId,
      ...(options.executionMode ? { queueNamespace: "self-in-space-v2" } : {}),
      sequencedAdmission: true,
    }));
  const monitor = createChannelIngressMonitor<AdmittedKnoxMessage, string, StoredKnoxIngress>({
    queue: resolveQueue,
    inspect,
    payload: {
      storage: "raw-event",
      version: options.executionMode ? 2 : VERSION,
      serialize: (message) => JSON.stringify(message),
      deserialize: (rawEvent, { claim }) => {
        let message: AdmittedKnoxMessage;
        try {
          const stored = JSON.parse(rawEvent) as AdmittedKnoxMessage;
          const normalized = normalizeKnoxInbound(stored);
          if ((normalized.schemaVersion === 2) !== Boolean(options.executionMode)) {
            throw new Error("Knox stored execution mode does not match its queue owner");
          }
          if (normalized.schemaVersion === 2) {
            const route = parseKnoxRoute(stored.selfInSpaceRoute);
            if (
              !route ||
              (route.status === "resolved" &&
                (!route.selfInSpace || route.selfInSpace.requestId !== normalized.messageId))
            ) {
              throw new Error("Knox stored personal request has no valid pinned route");
            }
            message = { ...normalized, selfInSpaceRoute: route };
          } else {
            message = { ...normalized, questionAnswerBinding: stored.questionAnswerBinding };
          }
        } catch (error) {
          throw new KnoxIngressPermanentError("invalid-event", "Knox ingress JSON is invalid", {
            cause: error,
          });
        }
        if (inspect(message).eventId !== claim.id) {
          throw new KnoxIngressPermanentError(
            "invalid-event",
            "Knox ingress event identity changed after admission",
          );
        }
        return message;
      },
      createClaimError: () =>
        new KnoxIngressPermanentError("invalid-event", "Knox ingress payload is invalid"),
    },
    // A delivery may outlive the pump that claimed it when another lane (notably
    // /stop) repumps. Give every delivery its own Gateway root lease.
    deliver: async (message, lifecycle) =>
      await runDetachedWebhookWork(
        async () =>
          await options.dispatch(
            message,
            lifecycle,
            message.questionAnswerBinding,
            message.selfInSpaceRoute,
          ),
      ),
    pollIntervalMs: 500,
    sequencedAdmission: true,
    onQueued: options.notifyQueued
      ? async (message, context) => {
          if (inspect(message).laneKey === `${message.conversation.conversationId}:control`) {
            return;
          }
          await runDetachedWebhookWork(async () => {
            try {
              if (!context.abortSignal.aborted) {
                await options.notifyQueued?.(message, {
                  ...context,
                  ...(message.selfInSpaceRoute ? { route: message.selfInSpaceRoute } : {}),
                });
              }
            } catch (error) {
              if (!context.abortSignal.aborted) {
                throw error;
              }
            }
          });
        }
      : undefined,
    retention: "standard",
    drain: {
      orderBy: "admission",
      adoptedLaneOccupancy: "hold",
      startLimit: 8,
      resolveNonRetryableFailure: (error) =>
        error instanceof KnoxIngressPermanentError
          ? { reason: error.reason, message: error.message }
          : error instanceof KnoxOutboundError && !error.retryable
            ? { reason: "outbound-rejected", message: error.message }
            : null,
      onLog: (message) => options.log?.(`knox: ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    // The durable drain outlives the relay HTTP acknowledgement. Reserve an
    // independent Gateway root for queue work; delivery owns a separate root above.
    runPumpTask: runDetachedWebhookWork,
    waitForDeliveryIdleBeforeRepump: false,
    admissionMode: "while-running",
    createStoppedError: () => new Error("Knox ingress is stopped"),
    onError: (error) => options.log?.(`knox ingress failed: ${String(error)}`),
  });

  let admission = Promise.resolve();
  const admit = async (message: KnoxInboundMessage) => {
    if ((message.schemaVersion === 2) !== Boolean(options.executionMode)) {
      throw new KnoxIngressPermanentError(
        "invalid-event",
        "Knox ingress mode does not match queue owner",
      );
    }
    const selfInSpaceRoute =
      message.schemaVersion === 2 ? await options.resolveSelfInSpaceRoute?.(message) : undefined;
    if (message.schemaVersion === 2 && !selfInSpaceRoute) {
      throw new KnoxIngressPermanentError(
        "invalid-event",
        "Knox personal request has no pinned route",
      );
    }
    const questionAnswerBinding =
      message.schemaVersion !== 2 &&
      inspect(message).laneKey === message.conversation.conversationId
        ? await options.resolveQuestionAnswerBinding?.(message)
        : undefined;
    const admitted = {
      ...message,
      questionAnswerBinding,
      ...(selfInSpaceRoute ? { selfInSpaceRoute } : {}),
    };
    const result = await monitor.admit(admitted, { facts: inspect(admitted) });
    return { duplicate: result.kind === "durable" && result.queueResult.duplicate };
  };
  return {
    has: async (id: string) => {
      const nativeQueue = resolveQueue();
      if (!nativeQueue.has) {
        throw new Error("Knox personal admission requires native ingress identity lookup");
      }
      return await nativeQueue.has(id);
    },
    start: monitor.start,
    stop: monitor.stop,
    admit: async (message: KnoxInboundMessage) => {
      // Async routing must not reorder otherwise FIFO transport arrivals.
      const result = admission.then(async () => await admit(message));
      admission = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    },
  };
}
