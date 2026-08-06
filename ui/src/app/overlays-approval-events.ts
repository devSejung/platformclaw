import type { GatewayEventFrame } from "../api/gateway.ts";
import {
  clearResolvedExecApprovalPrompt,
  enqueueExecApprovalPrompt,
  parseApprovalRequestedEvent,
  parseExecApprovalResolved,
  parseSessionApprovalTransition,
  type ExecApprovalPromptState,
} from "./exec-approval.ts";

export function handleOverlayApprovalEvent(
  event: GatewayEventFrame,
  state: ExecApprovalPromptState,
  publish: () => void,
): void {
  if (event.event === "session.approval") {
    const transition = parseSessionApprovalTransition(event.payload);
    if (transition?.phase === "pending") {
      enqueueExecApprovalPrompt(state, transition.approval);
      publish();
    } else if (transition?.phase === "terminal") {
      clearResolvedExecApprovalPrompt(state, transition.id);
      publish();
    }
    return;
  }
  const requestedApproval = parseApprovalRequestedEvent(event.event, event.payload);
  if (requestedApproval) {
    enqueueExecApprovalPrompt(state, requestedApproval);
    publish();
    return;
  }
  if (
    event.event === "exec.approval.resolved" ||
    event.event === "plugin.approval.resolved" ||
    event.event === "openclaw.approval.resolved"
  ) {
    const resolved = parseExecApprovalResolved(event.payload);
    if (resolved) {
      clearResolvedExecApprovalPrompt(state, resolved.id);
      publish();
    }
  }
}
