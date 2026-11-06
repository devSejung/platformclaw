import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { ChatSenderAttribution } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { SessionEntry } from "../../config/sessions.js";
import { parseAgentSessionKey, parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { chatSendScopeDedupeKey, pendingChatSendDedupeKey } from "../server-shared.js";
import {
  gatewayClientSenderFields,
  gatewayClientSenderIsOwner,
} from "./gateway-client-identity.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function resolvePersonalAutomationsAgentId(params: {
  personalAutomations?: true;
  senderAttribution?: ChatSenderAttribution;
  requestedKey: string;
  sessionKey: string;
  agentId: string;
  chatType?: SessionEntry["chatType"];
}): string | undefined {
  // The relay checked the requested key against its Space registry. A canonical
  // route change must not carry that proof over to another conversation.
  if (
    !params.personalAutomations ||
    params.senderAttribution?.isOwner !== false ||
    params.senderAttribution.agentId !== params.agentId ||
    params.requestedKey.trim() !== params.sessionKey ||
    parseAgentSessionKey(params.sessionKey)?.agentId !== params.agentId ||
    params.chatType === "group" ||
    params.chatType === "channel"
  ) {
    return undefined;
  }
  const peerKind = parseSessionDeliveryRoute(params.sessionKey)?.peerKind;
  return peerKind === "group" || peerKind === "channel" ? undefined : params.agentId;
}

/** Bind globally indexed run IDs before any replay, await, or steer interruption. */
export function requireChatSendScope(params: {
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
  respond: GatewayRequestHandlerOptions["respond"];
  runId: string;
  agentId: string;
  sessionKey: string;
  senderAttribution?: ChatSenderAttribution;
  personalAutomationsAgentId?: string;
}): { requestIdentity: string } | undefined {
  const { context, runId } = params;
  const sender = gatewayClientSenderFields(params.client, params.senderAttribution).sender;
  const owner = sender
    ? ["sender", sender.profileId?.trim() || sender.id.trim()]
    : params.client?.connect?.device?.id
      ? ["device", params.client.connect.device.id]
      : null;
  // A restricted proxy sender must not replay results or join work admitted
  // under that same human's separate Gateway-owner authority.
  const requestIdentity = JSON.stringify([
    params.agentId,
    params.sessionKey,
    owner,
    gatewayClientSenderIsOwner(params.client, params.senderAttribution),
    sender?.agentId ?? null,
    ...(params.personalAutomationsAgentId ? [params.personalAutomationsAgentId] : []),
  ]);
  const scopeKey = chatSendScopeDedupeKey(runId);
  const prior = context.dedupe.get(scopeKey);
  const active = context.chatAbortControllers.get(runId);
  const queued = context.chatQueuedTurns?.get(runId);
  const pending = context.dedupe.get(pendingChatSendDedupeKey(runId))?.payload;
  const outsideScope = (entry: { sessionKey?: unknown; agentId?: unknown }) =>
    entry.sessionKey !== params.sessionKey ||
    (typeof entry.agentId === "string" && entry.agentId !== params.agentId);
  const conflictingRun =
    (active && (active.kind === "agent" || outsideScope(active))) ||
    (queued && outsideScope(queued)) ||
    (isRecord(pending) && outsideScope(pending)) ||
    // Retained registrations still route events. Their mere presence is not
    // active work, but reusing a foreign route would send new output there.
    context.chatRunState.runs.get(runId)?.registrations?.some(outsideScope);
  // Unattributed cached/run state must not be adopted by the next caller. All
  // chat and session messaging entrypoints reserve the scope before creating it.
  // Registry/progress/tool-recipient projections can outlive completed agent
  // runs; only an abort marker there can settle a chat retry without new work.
  const unownedRun =
    !prior &&
    (context.dedupe.has(`chat:${runId}`) ||
      context.dedupe.has(pendingChatSendDedupeKey(runId)) ||
      context.chatAbortControllers.has(runId) ||
      context.chatQueuedTurns?.has(runId) ||
      context.chatRunState.runs.get(runId)?.abortMarker !== undefined);
  if (unownedRun || conflictingRun || (prior && prior.requestIdentity !== requestIdentity)) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "idempotency key belongs to another send scope", {
        details: { reason: "idempotency-key-conflict" },
      }),
    );
    return undefined;
  }
  context.dedupe.set(scopeKey, { ts: Date.now(), ok: true, requestIdentity });
  return { requestIdentity };
}
