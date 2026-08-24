import {
  ControlPlaneStateError,
  type OrganizationAuditCursor,
  type OrganizationAuditRecord,
} from "./contracts.js";

export function projectOrganizationAuditRecord(record: OrganizationAuditRecord) {
  return {
    key: encodeOrganizationAuditCursor({ occurredAt: record.occurredAt, id: record.id }),
    action: record.action,
    category: record.category,
    occurredAt: record.occurredAt,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.actor
      ? {
          actor: {
            accountId: record.actor.accountId,
            ...(record.actor.displayName ? { displayName: record.actor.displayName } : {}),
            status: record.actor.status,
          },
        }
      : {}),
    target:
      record.target?.type === "scope"
        ? {
            type: "scope" as const,
            scope: record.target.scope,
            lineage: record.target.lineage,
          }
        : record.target?.type === "user"
          ? {
              type: "user" as const,
              user: {
                accountId: record.target.user.accountId,
                ...(record.target.user.displayName
                  ? { displayName: record.target.user.displayName }
                  : {}),
                status: record.target.user.status,
              },
            }
          : { type: "unavailable" as const },
    ...(record.subject ? { subject: record.subject } : {}),
    ...(record.change && Object.values(record.change).some((value) => value !== undefined)
      ? { change: record.change }
      : {}),
  };
}

export function encodeOrganizationAuditCursor(cursor: OrganizationAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeOrganizationAuditCursor(value: string | null) {
  if (!value) {
    return undefined;
  }
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ControlPlaneStateError("invalid audit cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Object.keys(parsed).length !== 2 ||
      !Number.isSafeInteger((parsed as { occurredAt?: unknown }).occurredAt) ||
      (parsed as { occurredAt: number }).occurredAt < 0 ||
      typeof (parsed as { id?: unknown }).id !== "string" ||
      !(parsed as { id: string }).id ||
      (parsed as { id: string }).id.length > 160
    ) {
      throw new Error("invalid cursor shape");
    }
    return parsed as OrganizationAuditCursor;
  } catch {
    throw new ControlPlaneStateError("invalid audit cursor");
  }
}
