type JsonObject = Record<string, unknown>;

const SESSION_KEY_FIELDS = new Set([
  "sessionKey",
  "parentSessionKey",
  "childSessionKey",
  "spawnedBy",
]);

type BrowserOwnershipAccess = {
  agentId: string;
  resolveAgentIdFromSessionKey(sessionKey: string): string | null;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hasForeignOwnershipFields(access: BrowserOwnershipAccess, record: JsonObject): boolean {
  const agentId = optionalString(record.agentId);
  if (agentId && agentId !== access.agentId) {
    return true;
  }
  for (const field of SESSION_KEY_FIELDS) {
    const sessionKey = optionalString(record[field]);
    if (sessionKey && access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId) {
      return true;
    }
  }
  const rowKey = optionalString(record.key);
  if (rowKey) {
    const resolvedAgentId = access.resolveAgentIdFromSessionKey(rowKey);
    if (resolvedAgentId && resolvedAgentId !== access.agentId) {
      return true;
    }
  }
  if (record.childSessions !== undefined) {
    if (!Array.isArray(record.childSessions)) {
      return true;
    }
    for (const childSession of record.childSessions) {
      const sessionKey = optionalString(childSession);
      if (!sessionKey || access.resolveAgentIdFromSessionKey(sessionKey) !== access.agentId) {
        return true;
      }
    }
  }
  return false;
}

export function browserPayloadBelongsToAccess(
  access: BrowserOwnershipAccess,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as JsonObject;
  if (hasForeignOwnershipFields(access, record)) {
    return false;
  }
  const agentId = optionalString(record.agentId);
  const sessionKey = optionalString(record.sessionKey) ?? optionalString(record.key);
  return sessionKey
    ? access.resolveAgentIdFromSessionKey(sessionKey) === access.agentId
    : agentId === access.agentId;
}

export function browserEventPayloadBelongsToAccess(
  access: BrowserOwnershipAccess,
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as JsonObject;
  const sessionKey = optionalString(record.sessionKey) ?? optionalString(record.key);
  return Boolean(
    sessionKey &&
    access.resolveAgentIdFromSessionKey(sessionKey) === access.agentId &&
    !hasForeignOwnershipFields(access, record),
  );
}
