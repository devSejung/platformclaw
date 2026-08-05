import type { BrowserGatewayEvent } from "./browser-gateway-contracts.js";
import { projectBrowserCronEvent } from "./browser-gateway-cron-policy.js";
import type {
  BrowserGatewayInteractiveOwnership,
  BrowserInteractiveAccess,
} from "./browser-gateway-interactive-ownership.js";
import type { BrowserGatewaySessionPullRequestSubscriptions } from "./browser-gateway-session-pull-requests.js";

export const PLATFORMCLAW_WEB_GATEWAY_EVENTS = [
  "shutdown",
  "tick",
  "agent",
  "chat",
  "chat.send_timing",
  "chat.side_result",
  "session.message",
  "session.observer",
  "session.operation",
  "session.tool",
  "sessions.changed",
  "session.approval",
  "question.requested",
  "question.resolved",
  "cron",
  "controlUi.sessionPullRequests.changed",
  "task.suggestion",
  "skills.changed",
  "task",
] as const;

const SAFE_GLOBAL_EVENTS = new Set<string>(["shutdown", "tick", "skills.changed"]);
const SESSION_SCOPED_EVENTS = new Set<string>([
  "agent",
  "chat",
  "chat.send_timing",
  "chat.side_result",
  "session.message",
  "session.observer",
  "session.operation",
  "session.tool",
  "sessions.changed",
]);

export function projectBrowserGatewayEvent(options: {
  event: BrowserGatewayEvent;
  agentId: string;
  connectionId?: string;
  interactiveAccess: BrowserInteractiveAccess;
  interactiveOwnership: BrowserGatewayInteractiveOwnership;
  pullRequestSubscriptions: BrowserGatewaySessionPullRequestSubscriptions;
  sessionKeyBelongsToAgent: (sessionKey: string) => boolean;
  taskEventBelongsToAccess: (payload: unknown) => boolean;
  eventPayloadBelongsToAccess: (payload: unknown) => boolean;
}): BrowserGatewayEvent | null {
  if (SAFE_GLOBAL_EVENTS.has(options.event.event)) {
    return options.event;
  }
  const interactiveEvent = options.interactiveOwnership.filterEvent(
    options.interactiveAccess,
    options.event,
  );
  if (interactiveEvent !== undefined) {
    return interactiveEvent;
  }
  if (options.event.event === "cron") {
    const payload = projectBrowserCronEvent({
      payload: options.event.payload,
      agentId: options.agentId,
      sessionKeyBelongsToAgent: options.sessionKeyBelongsToAgent,
    });
    return payload ? { ...options.event, payload } : null;
  }
  if (options.event.event === "controlUi.sessionPullRequests.changed") {
    if (!options.connectionId) {
      return null;
    }
    const payload = options.pullRequestSubscriptions.projectEvent(
      options.connectionId,
      options.agentId,
      options.event.payload,
    );
    return payload ? { ...options.event, payload } : null;
  }
  if (options.event.event === "task") {
    return options.taskEventBelongsToAccess(options.event.payload) ? options.event : null;
  }
  if (
    !SESSION_SCOPED_EVENTS.has(options.event.event) ||
    !options.eventPayloadBelongsToAccess(options.event.payload)
  ) {
    return null;
  }
  return options.event;
}
