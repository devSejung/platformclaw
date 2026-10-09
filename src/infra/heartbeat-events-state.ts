import { resolveGlobalSingleton } from "../shared/global-singleton.js";

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

type HeartbeatEventState = {
  lastHeartbeat: HeartbeatEventPayload | null;
  listeners: Set<(evt: HeartbeatEventPayload) => void>;
};

// Runtime copies and test cleanup share this owner so resets preserve listener identity.
export const heartbeatEventState = resolveGlobalSingleton<HeartbeatEventState>(
  Symbol.for("openclaw.heartbeatEvents.state"),
  () => ({ lastHeartbeat: null, listeners: new Set() }),
);
