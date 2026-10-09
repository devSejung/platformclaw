// Stores and broadcasts heartbeat status events for UI surfaces.
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  type HeartbeatEventPayload,
  heartbeatEventState as state,
} from "./heartbeat-events-state.js";

export type { HeartbeatEventPayload } from "./heartbeat-events-state.js";

export function resolveIndicatorType(
  status: HeartbeatEventPayload["status"],
): HeartbeatEventPayload["indicatorType"] {
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
