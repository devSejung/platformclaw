// Managed-room authority and transition outcomes are shared by all Talk transports.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getTalkHandoff, type TalkHandoffTurnResult } from "../talk-handoff.js";
import type { UnifiedTalkSessionRecord } from "../talk-session-registry.js";
import { broadcastTalkRoomEvents, talkHandoffErrorCode } from "./talk-shared.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type ManagedRoomTalkSession = Extract<UnifiedTalkSessionRecord, { kind: "managed-room" }>;

export function isActiveManagedRoomClient(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  if (!connId) {
    return false;
  }
  const handoff = getTalkHandoff(session.handoffId);
  return handoff?.room.activeClientId === connId;
}

export function canCloseManagedRoomSession(
  session: { handoffId: string },
  connId: string | undefined,
): boolean {
  const handoff = getTalkHandoff(session.handoffId);
  return !handoff?.room.activeClientId || handoff.room.activeClientId === connId;
}

export function managedRoomOwnershipError(action: string) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    `talk.session.${action} requires the active managed-room connection`,
  );
}

export function respondManagedRoomTurn(params: {
  session: UnifiedTalkSessionRecord;
  connId?: string;
  context: GatewayRequestContext;
  respond: RespondFn;
  method: "talk.session.startTurn" | "talk.session.endTurn" | "talk.session.cancelTurn";
  ownershipAction: "startTurn" | "endTurn" | "cancelTurn";
  failureVerb: "start" | "end" | "cancel";
  run: (session: ManagedRoomTalkSession) => TalkHandoffTurnResult;
}) {
  if (params.session.kind !== "managed-room") {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `${params.method} requires managed-room`),
    );
    return;
  }
  if (!isActiveManagedRoomClient(params.session, params.connId)) {
    params.respond(false, undefined, managedRoomOwnershipError(params.ownershipAction));
    return;
  }
  const result = params.run(params.session);
  if (!result.ok) {
    params.respond(
      false,
      undefined,
      errorShape(
        talkHandoffErrorCode(result.reason),
        `talk turn ${params.failureVerb} failed: ${result.reason}`,
      ),
    );
    return;
  }
  broadcastTalkRoomEvents(params.context, result.record.room.activeClientId, {
    handoffId: result.record.id,
    roomId: result.record.roomId,
    events: result.events,
  });
  params.respond(true, { ok: true, turnId: result.turnId, events: result.events }, undefined);
}
