import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type DirectoryOrganization = {
  part: { id: string; name: string };
  group: { id: string; name: string } | null;
  team: string | null;
  sourceUpdatedAt: number;
};

export type DirectoryOrganizationSyncResult =
  | { status: "synced"; scopeId: string }
  | {
      status: "skipped";
      reason:
        | "test-account"
        | "no-organization"
        | "unsupported-version"
        | "untrusted-source"
        | "no-part"
        | "invalid-organization"
        | "missing-parent"
        | "inactive-organization"
        | "inactive-user"
        | "stale-organization"
        | "conflicting-organization";
    };

type OrganizationParseResult =
  | { status: "eligible"; organization: DirectoryOrganization }
  | Extract<DirectoryOrganizationSyncResult, { status: "skipped" }>;

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function directoryNode(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const id = boundedText(value.id, 512);
  const name = boundedText(value.name, 120);
  return id && name ? { id, name } : null;
}

export function parseDirectoryOrganization(value: unknown): OrganizationParseResult {
  if (value === undefined || value === null) {
    return { status: "skipped", reason: "no-organization" };
  }
  if (!isRecord(value)) {
    return { status: "skipped", reason: "invalid-organization" };
  }
  if (value.version !== 1) {
    return { status: "skipped", reason: "unsupported-version" };
  }
  if (value.source !== "aicm") {
    return { status: "skipped", reason: "untrusted-source" };
  }
  if (value.part === null || (isRecord(value.part) && !value.part.id)) {
    return { status: "skipped", reason: "no-part" };
  }
  const part = directoryNode(value.part);
  const group = value.group === null ? null : directoryNode(value.group);
  const team = value.team === null ? null : boundedText(value.team, 120);
  const timestamp = value.updatedAt;
  const sourceUpdatedAt = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  if (
    !part ||
    (value.group !== null && !group) ||
    (value.team !== null && !team) ||
    typeof timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp) ||
    !Number.isFinite(sourceUpdatedAt)
  ) {
    return { status: "skipped", reason: "invalid-organization" };
  }
  return { status: "eligible", organization: { part, group, team, sourceUpdatedAt } };
}
