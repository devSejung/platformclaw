import { GatewayProtocolRequestError } from "./protocol-request.js";

/** Owned settlement, cleanup, and timing state for one Gateway wire request. */
export type GatewayPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  acceptedNotified: boolean;
  onAccepted?: (payload: unknown) => void;
  cleanup?: () => void;
  unbounded: boolean;
  requestSent: boolean;
  method: string;
  startedAtMs: number;
};

export function interruptPendingRequest(pending: GatewayPendingRequest, error: Error): void {
  // A close/stop does not cancel remote mutations. Structured connect rejections
  // retain their auth contract; sent application requests have unknown outcomes.
  pending.reject(
    pending.requestSent &&
      pending.method !== "connect" &&
      !(error instanceof GatewayProtocolRequestError)
      ? Object.assign(new Error(error.message, { cause: error }), {
          details: { requestDisposition: "outcome-unknown" },
        })
      : error,
  );
}
