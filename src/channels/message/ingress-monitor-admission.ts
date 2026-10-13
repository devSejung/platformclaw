import { formatErrorMessage, toErrorObject } from "../../infra/errors.js";
import { ChannelIngressUnavailableError } from "./ingress-unavailable.js";

export function ensureIngressQueueAvailable(getQueue: () => unknown): void {
  try {
    getQueue();
  } catch (error) {
    throw new ChannelIngressUnavailableError(
      `Channel ingress queue is unavailable: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

/** Admission and claiming share one FIFO lock; append retry order stays in the monitor. */
function createIngressAdmissionClaimLock() {
  let locked = false;
  const waiters: Array<() => void> = [];
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = (): Promise<T> => {
      locked = true;
      let result: Promise<T>;
      try {
        result = Promise.resolve(task());
      } catch (error) {
        result = Promise.reject(toErrorObject(error, "Channel ingress admission task failed"));
      }
      return result.finally(() => {
        const next = waiters.shift();
        if (next) {
          next();
        } else {
          locked = false;
        }
      });
    };
    if (!locked) {
      return run();
    }
    return new Promise<T>((resolve, reject) => {
      waiters.push(() => {
        void run().then(resolve, reject);
      });
    });
  };
}

export function createIngressAdmissionScheduler() {
  const withAdmissionClaimLock = createIngressAdmissionClaimLock();
  let admissionTail: Promise<void> = Promise.resolve();
  return {
    withAdmissionClaimLock,
    scheduleAdmission: <T>(work: () => Promise<T>): Promise<T> => {
      // Append retries stay serialized so backoff cannot invert arrival order.
      const admission = admissionTail.then(() => withAdmissionClaimLock(work));
      admissionTail = admission.then(
        () => undefined,
        () => undefined,
      );
      return admission;
    },
    waitForAdmissionIdle: () => admissionTail,
  };
}

type QueuedNoticeCallback<TRaw> = (
  raw: TRaw,
  context: { aheadCount: number; abortSignal: AbortSignal },
) => void | Promise<void>;

/** Best-effort notices own no durable claim and never hold the admission lock. */
export function createIngressQueuedNotices<TRaw>(options: {
  resolveCallback: () => QueuedNoticeCallback<TRaw> | undefined;
  abortSignal: AbortSignal;
  isRunning: () => boolean;
  reportError: (error: unknown) => void;
}) {
  const controllers = new Map<string, AbortController>();
  return {
    prepare: (eventId: string, aheadCount: number | undefined) => {
      if ((aheadCount ?? 0) > 0 && options.resolveCallback() && options.isRunning()) {
        controllers.set(eventId, new AbortController());
      }
    },
    cancel: (eventId: string) => {
      controllers.get(eventId)?.abort();
      controllers.delete(eventId);
    },
    notify: (raw: TRaw, eventId: string, aheadCount: number | undefined) => {
      const controller = controllers.get(eventId);
      if (!controller) {
        return;
      }
      const callback = options.resolveCallback();
      if (!callback || aheadCount === undefined) {
        return;
      }
      const abortSignal = AbortSignal.any([controller.signal, options.abortSignal]);
      const cleanup = () => {
        if (controllers.get(eventId) === controller) {
          controllers.delete(eventId);
        }
      };
      if (!options.isRunning() || abortSignal.aborted) {
        cleanup();
        return;
      }
      try {
        void Promise.resolve(callback(raw, { aheadCount, abortSignal }))
          .catch(options.reportError)
          .finally(cleanup);
      } catch (error) {
        cleanup();
        options.reportError(error);
      }
    },
    clear: () => controllers.clear(),
  };
}
