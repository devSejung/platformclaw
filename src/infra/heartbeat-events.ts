// Stores and broadcasts heartbeat status events for UI surfaces.
import { notifyListeners, registerListener } from "../shared/listeners.js";
import { heartbeatEventState as state } from "./heartbeat-events-state.js";

type HeartbeatIndicatorType = "ok" | "alert" | "error";

export type HeartbeatEventPayload = {
  ts: number;
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
  to?: string;
  accountId?: string;
  preview?: string;
  durationMs?: number;
  hasMedia?: boolean;
  reason?: string;
  /** The channel this heartbeat was sent to. */
  channel?: string;
  /** Whether the message was silently suppressed (showOk: false). */
  silent?: boolean;
  /** Indicator type for UI status display. */
  indicatorType?: HeartbeatIndicatorType;
};

export function resolveIndicatorType(
  status: HeartbeatEventPayload["status"],
): HeartbeatIndicatorType | undefined {
  switch (status) {
    case "ok-empty":
    case "ok-token":
      return "ok";
    case "sent":
      return "alert";
    case "failed":
      return "error";
    case "skipped":
      return undefined;
  }
  throw new Error("Unsupported heartbeat status");
}

export function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">) {
  const enriched: HeartbeatEventPayload = { ts: Date.now(), ...evt };
  state.lastHeartbeat = enriched;
  notifyListeners(state.listeners, enriched);
}

export function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void {
  return registerListener(state.listeners, listener);
}

export function getLastHeartbeatEvent(): HeartbeatEventPayload | null {
  return state.lastHeartbeat;
}
