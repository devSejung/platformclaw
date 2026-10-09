import { heartbeatEventState } from "./heartbeat-events-state.js";

export function resetHeartbeatEventsForTest(): void {
  heartbeatEventState.lastHeartbeat = null;
  heartbeatEventState.listeners.clear();
}
