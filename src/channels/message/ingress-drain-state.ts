import type { ChannelIngressQueueClaim, ChannelIngressQueueRecord } from "./ingress-queue.js";

export class IngressAdoptionLostError extends Error {
  readonly code: "guillotined" | "superseded" | "reclaimed";

  constructor(code: "guillotined" | "superseded" | "reclaimed") {
    super(`ingress adoption lost: ${code}`);
    this.name = "IngressAdoptionLostError";
    this.code = code;
  }
}

export function isIngressAdoptionLostError(error: unknown): error is IngressAdoptionLostError {
  return error instanceof IngressAdoptionLostError;
}

export type ChannelIngressDrainDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

export type ActiveHandlerState<TPayload, TMetadata> = {
  eventId: string;
  laneKey: string;
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>;
  abortController: AbortController;
  startedAt: number;
  phase: "dispatching" | "deferred" | "adopted" | "settled";
  occupiesLane: boolean;
  deliverySettled: boolean;
  task: Promise<void>;
  stallTimer?: ReturnType<typeof setTimeout>;
  claimRefreshTimer?: ReturnType<typeof setInterval>;
  /** Closed code: pre-adoption stall watchdog has claimed settle ownership. */
  guillotined: boolean;
  /** Closed code: pre-adoption supersede has claimed settle ownership. */
  superseded: boolean;
  /** Single settle owner for complete / fail / release / supersede / guillotine. */
  settleOnce: (fn: () => Promise<void>) => Promise<void>;
};

export function activeClaimKey<TPayload, TMetadata>(
  claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
): string {
  return `${claim.id}\0${claim.claim.token}`;
}

export function clearIngressStallTimer<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
): void {
  if (state.stallTimer) {
    clearTimeout(state.stallTimer);
    state.stallTimer = undefined;
  }
}

export function clearIngressClaimRefresh<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
): void {
  if (state.claimRefreshTimer) {
    clearInterval(state.claimRefreshTimer);
    state.claimRefreshTimer = undefined;
  }
}

export function removeActiveIngressHandler<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  activeByClaim: Map<string, ActiveHandlerState<TPayload, TMetadata>>,
  laneOwnerByKey: Map<string, ActiveHandlerState<TPayload, TMetadata>>,
): void {
  clearIngressStallTimer(state);
  clearIngressClaimRefresh(state);
  activeByClaim.delete(activeClaimKey(state.claim));
  if (laneOwnerByKey.get(state.laneKey) === state) {
    laneOwnerByKey.delete(state.laneKey);
  }
  state.occupiesLane = false;
}

export function resolveLaneKey<TPayload, TMetadata>(
  record: ChannelIngressQueueRecord<TPayload, TMetadata>,
  deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined,
  reconcileStoredLaneKey?: (
    record: ChannelIngressQueueRecord<TPayload, TMetadata>,
    storedLaneKey: string,
    derivedLaneKey: string,
  ) => boolean,
): string {
  const derivedLaneKey = deriveLaneKey?.(record);
  const storedLaneKey = record.laneKey;
  if (
    !reconcileStoredLaneKey ||
    storedLaneKey === undefined ||
    derivedLaneKey === undefined ||
    storedLaneKey === derivedLaneKey
  ) {
    return derivedLaneKey ?? storedLaneKey ?? record.id;
  }
  return reconcileStoredLaneKey(record, storedLaneKey, derivedLaneKey)
    ? derivedLaneKey
    : storedLaneKey;
}

export function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].toSorted((a, b) => a.localeCompare(b));
}
