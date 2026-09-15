import { randomUUID } from "node:crypto";
import type { SessionEntry } from "./types.js";

export function createFallbackSessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  const now = Date.now();
  return {
    sessionId: patch.sessionId ?? randomUUID(),
    updatedAt: patch.updatedAt ?? now,
    ...patch,
    // Missing-row upserts create a durable identity and must own a revision at
    // that boundary; consumers use it to reject stale lifecycle work.
    lifecycleRevision: patch.lifecycleRevision?.trim() || randomUUID(),
  };
}

export function normalizeSqliteText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeSqliteChatType(value: unknown): "direct" | "group" | "channel" | null {
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  return null;
}

export function normalizeSqliteNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}
