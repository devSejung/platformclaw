import type { ReplyPayload } from "../reply-payload.js";

export type ReplyDispatchDeliveryOutcome =
  | "delivered"
  | "not-visible"
  | "cancelled"
  | "failed-before-deliver"
  | "failed-deliver";

type ReplyDispatchDeliveryOutcomeTracker = {
  promise: Promise<ReplyDispatchDeliveryOutcome>;
  finalization: Promise<ReplyDispatchDeliveryOutcome>;
  resolve: (
    outcome: ReplyDispatchDeliveryOutcome,
    finalization?: Promise<ReplyDispatchDeliveryOutcome>,
  ) => void;
  tracked: boolean;
};

export const replyDispatchDeliveryOutcomeTrackers = new WeakMap<
  ReplyPayload,
  ReplyDispatchDeliveryOutcomeTracker
>();

/** Capture dispatch admission separately from native settlement, which may need onIdle. */
export function captureReplyDispatchDeliveryOutcome(payload: ReplyPayload): {
  promise: Promise<ReplyDispatchDeliveryOutcome>;
  finalization: Promise<ReplyDispatchDeliveryOutcome>;
  isTracked: () => boolean;
} {
  let resolveOutcome!: (outcome: ReplyDispatchDeliveryOutcome) => void;
  let resolveFinalization!: (
    outcome: ReplyDispatchDeliveryOutcome | Promise<ReplyDispatchDeliveryOutcome>,
  ) => void;
  const tracker: ReplyDispatchDeliveryOutcomeTracker = {
    promise: new Promise((resolve) => {
      resolveOutcome = resolve;
    }),
    finalization: new Promise((resolve) => {
      resolveFinalization = resolve;
    }),
    resolve: (outcome, finalization) => {
      resolveOutcome(outcome);
      resolveFinalization(finalization ?? outcome);
    },
    tracked: false,
  };
  replyDispatchDeliveryOutcomeTrackers.set(payload, tracker);
  return {
    promise: tracker.promise,
    finalization: tracker.finalization,
    isTracked: () => tracker.tracked,
  };
}
