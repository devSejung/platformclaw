import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
} from "../../routing/session-key.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { createCronExecutionId } from "../run-id.js";
import {
  buildDirectCronTranscriptMirrorPayloads,
  resolveDirectCronTranscriptMirrorText,
} from "./delivery-dispatch-awareness.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import type { RunCronAgentTurnResult } from "./run.types.js";

type CurrentSessionCompletionResult =
  | { ok: false; reason: string }
  | { ok: true; requiresExternalDelivery: boolean };

export async function failCurrentSessionCronCompletion(params: {
  dispatch: DispatchCronDeliveryParams;
  reason: string;
  summary?: string;
  outputText?: string;
  cleanup: () => Promise<unknown>;
}): Promise<RunCronAgentTurnResult> {
  await params.cleanup();
  const error = params.dispatch.sourceDeliveryOutcome.unverifiedMessageToolDelivery
    ? `${params.reason}; the agent used the message tool, but OpenClaw could not verify that message matched the cron delivery target`
    : params.reason;
  return params.dispatch.withRunSession({
    status: "error",
    error,
    errorKind: "delivery-target",
    summary: params.summary,
    outputText: params.outputText,
    delivered: false,
    deliveryAttempted: true,
    deliveryError: params.reason,
    ...params.dispatch.telemetry,
  });
}

export async function commitCurrentSessionCronCompletion(
  params: DispatchCronDeliveryParams,
  text?: string,
): Promise<CurrentSessionCompletionResult> {
  const sourceSessionKey = params.sourceSessionKey?.trim();
  if (!sourceSessionKey) {
    return { ok: false, reason: "current cron delivery is missing its source session binding" };
  }
  const ownerSessionKey = params.job.owner?.sessionKey?.trim();
  const ownerAgentId = params.job.owner?.agentId?.trim();
  const parsedOwner = ownerSessionKey ? parseAgentSessionKey(ownerSessionKey) : undefined;
  if (
    !ownerSessionKey ||
    ownerSessionKey !== sourceSessionKey ||
    !ownerAgentId ||
    normalizeAgentId(ownerAgentId) !== normalizeAgentId(params.agentId) ||
    !parsedOwner ||
    normalizeAgentId(parsedOwner.agentId) !== normalizeAgentId(params.agentId)
  ) {
    return { ok: false, reason: "current cron delivery does not match its signed owner session" };
  }
  const completionText =
    resolveDirectCronTranscriptMirrorText(
      projectOutboundPayloadPlanForMirror(
        createOutboundPayloadPlan(buildDirectCronTranscriptMirrorPayloads(params.deliveryPayloads)),
      ),
    ) ?? normalizeOptionalString(text);
  if (!completionText) {
    return { ok: false, reason: "current cron completion has no durable transcript projection" };
  }
  const runId = createCronExecutionId(params.job.id, params.runStartedAt);
  const committed = await commitBackgroundResultToSession({
    agentId: params.agentId,
    sessionKey: sourceSessionKey,
    text: completionText,
    idempotencyKey: `cron-current-completion:${runId}`,
    provenance: { kind: "cron", jobId: params.job.id, runId },
    config: params.cfgWithAgentDefaults,
    signal: params.abortSignal,
  });
  if (!committed.ok) {
    return committed;
  }
  if (params.sourceDeliveryOutcome.satisfiesSourceDelivery) {
    return { ok: true, requiresExternalDelivery: false };
  }
  if (params.resolvedDelivery.ok) {
    return { ok: true, requiresExternalDelivery: true };
  }
  // Internal owner sessions have no transport route: their durable transcript
  // commit is the delivery. Complete external routes must still fail closed.
  const sourceRoute = parseSessionDeliveryRoute(sourceSessionKey);
  if (
    params.resolvedDelivery.channel === "webchat" ||
    sourceRoute?.channel === "webchat" ||
    !sourceRoute
  ) {
    return { ok: true, requiresExternalDelivery: false };
  }
  return { ok: false, reason: params.resolvedDelivery.error.message };
}
