// Session-scoped system event queue helpers for plugin runtime producers and consumers.

export {
  consumeSelectedSystemEventEntries,
  drainSystemEventEntries,
  drainSystemEvents,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  hasSystemEvents,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  peekSystemEvents,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "../infra/system-events.js";
export { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.runtime.js";
