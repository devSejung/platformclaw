type JsonObject = Record<string, unknown>;

const SECONDARY_SESSION_KEY_FIELDS = [
  "parentSessionKey",
  "childSessionKey",
  "spawnedBy",
  "controlOwnerSessionKey",
] as const;

type BrowserOwnershipAccess = {
  agentId: string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function primarySessionBelongsToAccess(
  access: BrowserOwnershipAccess,
  record: JsonObject,
  requireSessionKey: boolean,
): boolean {
  if (record.agentId !== undefined && optionalString(record.agentId) !== access.agentId) {
    return false;
  }
  let hasSessionKey = false;
  for (const field of ["sessionKey", "key"] as const) {
    if (record[field] === undefined) {
      continue;
    }
    hasSessionKey = true;
    const sessionKey = optionalString(record[field]);
    if (!sessionKey || access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId) {
      return false;
    }
  }
  return hasSessionKey || (!requireSessionKey && optionalString(record.agentId) === access.agentId);
}

function secondaryLineageBelongsToAccess(
  access: BrowserOwnershipAccess,
  record: JsonObject,
): boolean {
  for (const field of SECONDARY_SESSION_KEY_FIELDS) {
    if (record[field] === undefined) {
      continue;
    }
    const sessionKey = optionalString(record[field]);
    if (!sessionKey || access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId) {
      return false;
    }
  }
  return (
    record.childSessions === undefined ||
    (Array.isArray(record.childSessions) &&
      record.childSessions.every((childSession) => {
        const sessionKey = optionalString(childSession);
        return Boolean(
          sessionKey && access.resolveAgentIdFromSessionKey(sessionKey) === access.agentId,
        );
      }))
  );
}

function forkSourceBelongsToAccess(access: BrowserOwnershipAccess, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const source = value as JsonObject;
  const sessionKey = optionalString(source.sessionKey);
  return Boolean(
    sessionKey &&
    access.resolveAgentIdFromSessionKey(sessionKey) === access.agentId &&
    typeof source.sessionId === "string" &&
    (source.entryId === undefined || typeof source.entryId === "string"),
  );
}

export function projectBrowserSessionPayloadForAccess(
  access: BrowserOwnershipAccess,
  payload: unknown,
): JsonObject | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as JsonObject;
  if (!primarySessionBelongsToAccess(access, record, true)) {
    return null;
  }
  if (record.childSessions !== undefined && !Array.isArray(record.childSessions)) {
    return null;
  }
  let projected = record;
  const omit = (field: string) => {
    if (projected === record) {
      projected = { ...record };
    }
    delete projected[field];
  };
  for (const field of SECONDARY_SESSION_KEY_FIELDS) {
    if (record[field] === undefined) {
      continue;
    }
    const sessionKey = optionalString(record[field]);
    if (!sessionKey || access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId) {
      omit(field);
    }
  }
  if (record.forkSource !== undefined && !forkSourceBelongsToAccess(access, record.forkSource)) {
    omit("forkSource");
  }
  if (Array.isArray(record.childSessions)) {
    const childSessions = record.childSessions.filter((childSession) => {
      const sessionKey = optionalString(childSession);
      return Boolean(
        sessionKey && access.resolveAgentIdFromSessionKey(sessionKey) === access.agentId,
      );
    });
    if (childSessions.length !== record.childSessions.length) {
      projected = { ...projected, childSessions };
    }
  }
  // Secondary lineage is display metadata, not authority. Keep the owned record but
  // never expose a related session key the browser binding cannot independently own.
  return projected;
}

export function browserPayloadBelongsToAccess(
  access: BrowserOwnershipAccess,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as JsonObject;
  return (
    primarySessionBelongsToAccess(access, record, false) &&
    secondaryLineageBelongsToAccess(access, record)
  );
}

export function browserEventPayloadBelongsToAccess(
  access: BrowserOwnershipAccess,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as JsonObject;
  return (
    primarySessionBelongsToAccess(access, record, true) &&
    secondaryLineageBelongsToAccess(access, record)
  );
}
