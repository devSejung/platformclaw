import { createHash, randomUUID } from "node:crypto";
import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { ControlPlaneIdFactory } from "./contracts.js";

const MAX_AGENT_ID_LENGTH = 64;
const ROOM_AGENT_PREFIX = "group-";
const ROOM_AGENT_DIGEST_LENGTH = 12;

export const defaultControlPlaneIdFactory: ControlPlaneIdFactory = {
  nextUserId: () => `user-${randomUUID()}`,
  nextBindingId: () => `binding-${randomUUID()}`,
  nextSessionId: () => `session-${randomUUID()}`,
  nextManagedScopeId: () => `scope-${randomUUID()}`,
  nextAuditEventId: () => `audit-${randomUUID()}`,
  nextExecutionResourceId: (kind) => `${kind}-${randomUUID()}`,
};

export function nextExecutionResourceId(
  idFactory: ControlPlaneIdFactory,
  kind: import("./execution-contracts.js").ExecutionResourceKind,
): string {
  return idFactory.nextExecutionResourceId?.(kind) ?? `${kind}-${randomUUID()}`;
}

/** Preserve the deployed personal-agent naming contract while validating its output. */
export function derivePersonalAgentId(accountId: string): string {
  const candidate = accountId.trim().replaceAll(".", "_").toLowerCase();
  if (!isValidAgentId(candidate)) {
    throw new Error(`account id cannot form a valid personal agent id: ${accountId}`);
  }
  return candidate;
}

/**
 * Builds a stable OpenClaw-safe room agent id without exposing raw unsafe path characters.
 * Safe room ids retain the deployed `group-<chatroomId>` contract. The store fails closed if
 * two Knox accounts claim the same legacy id; changing that namespace requires operator policy.
 */
export function deriveKnoxRoomAgentId(roomId: string): string {
  const legacyCandidate = `${ROOM_AGENT_PREFIX}${roomId.trim().toLowerCase()}`;
  if (isValidAgentId(legacyCandidate)) {
    return legacyCandidate;
  }
  const normalizedRoomId = normalizeAgentId(roomId);
  const digest = createHash("sha256")
    .update(roomId)
    .digest("hex")
    .slice(0, ROOM_AGENT_DIGEST_LENGTH);
  const readableLength =
    MAX_AGENT_ID_LENGTH - ROOM_AGENT_PREFIX.length - 1 - ROOM_AGENT_DIGEST_LENGTH;
  const readable = normalizedRoomId.slice(0, readableLength);
  return `${ROOM_AGENT_PREFIX}${readable}-${digest}`;
}
