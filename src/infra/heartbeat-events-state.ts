import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { HeartbeatEventPayload } from "./heartbeat-events.js";

type HeartbeatEventState = {
  lastHeartbeat: HeartbeatEventPayload | null;
  listeners: Set<(evt: HeartbeatEventPayload) => void>;
};

// Runtime copies and test cleanup share this owner so resets preserve listener identity.
export const heartbeatEventState = resolveGlobalSingleton<HeartbeatEventState>(
  Symbol.for("openclaw.heartbeatEvents.state"),
  () => ({ lastHeartbeat: null, listeners: new Set() }),
);
