import {
  createChannelIngressError,
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveKnoxCommandText } from "./command-text.js";
import { KnoxOutboundError } from "./outbound.js";
import { getKnoxRuntime } from "./runtime.js";
import type { KnoxInboundMessage } from "./types.js";

const VERSION = 1;

type StoredKnoxIngress = { version: 1; rawEvent: string };
export type KnoxIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "onAdoptionFinalizing">;

export const KnoxIngressPermanentError = createChannelIngressError<
  "agent-unavailable" | "invalid-event" | "login-required" | "room-disabled"
>("KnoxIngressPermanentError", { withReason: true });

export function createKnoxIngress(options: {
  accountId: string;
  queue?: ChannelIngressQueue<StoredKnoxIngress>;
  dispatch: (message: KnoxInboundMessage, lifecycle: KnoxIngressLifecycle) => Promise<void>;
  log?: (message: string) => void;
  abortSignal?: AbortSignal;
}) {
  const inspect = (message: KnoxInboundMessage) => {
    const command = resolveKnoxCommandText(message.message.text).trim().split(/\s+/u)[0];
    const control = command?.toLowerCase() === "/stop";
    return {
      eventId: message.messageId,
      // Stop must enter while ordinary work owns the conversation lane; otherwise
      // the command cannot interrupt the run it was sent to stop.
      laneKey: control
        ? `${message.conversation.conversationId}:control`
        : message.conversation.conversationId,
    };
  };
  const monitor = createChannelIngressMonitor<KnoxInboundMessage, string, StoredKnoxIngress>({
    queue:
      options.queue ??
      (() =>
        getKnoxRuntime().state.openChannelIngressQueue<StoredKnoxIngress>({
          accountId: options.accountId,
        })),
    inspect,
    payload: {
      storage: "raw-event",
      version: VERSION,
      serialize: (message) => JSON.stringify(message),
      deserialize: (rawEvent, { claim }) => {
        let message: KnoxInboundMessage;
        try {
          message = JSON.parse(rawEvent) as KnoxInboundMessage;
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
      await runDetachedWebhookWork(async () => await options.dispatch(message, lifecycle)),
    pollIntervalMs: 500,
    retention: "standard",
    drain: {
      orderBy: "received",
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

  return {
    start: monitor.start,
    stop: monitor.stop,
    admit: async (message: KnoxInboundMessage) => {
      const result = await monitor.admit(message, { facts: inspect(message) });
      return {
        duplicate: result.kind === "durable" && result.queueResult.duplicate,
      };
    },
  };
}
