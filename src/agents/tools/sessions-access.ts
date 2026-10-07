/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway } from "../../gateway/call.js";
import {
  resolveDeniedSessionVisibilityKeys,
  resolveSandboxSessionToolsVisibility,
  type SessionToolVisibilityRestrictions,
  type SessionVisibilityRow,
} from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";

type GatewayCaller = typeof callGateway;
const SESSION_VISIBILITY_ANCESTRY_DEPTH = 32;
const SESSION_VISIBILITY_DESCRIBE_BATCH = 16;

function mergeVisibilityRow(
  rows: Map<string, SessionVisibilityRow>,
  row: SessionVisibilityRow,
): void {
  const key = normalizeOptionalString(row.key);
  if (!key) {
    return;
  }
  rows.set(key, { ...rows.get(key), ...row, key });
}

function listedVisibilityRow(value: unknown, key: string): SessionVisibilityRow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    return undefined;
  }
  const row = sessions.find(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as { key?: unknown }).key === "string" &&
      (entry as { key: string }).key === key,
  );
  if (!row) {
    return undefined;
  }
  return {
    key,
    ...(typeof row.agentId === "string" ? { agentId: row.agentId } : {}),
    ...(typeof row.ownerSessionKey === "string" ? { ownerSessionKey: row.ownerSessionKey } : {}),
    ...(typeof row.spawnedBy === "string" ? { spawnedBy: row.spawnedBy } : {}),
    ...(typeof row.parentSessionKey === "string" ? { parentSessionKey: row.parentSessionKey } : {}),
  };
}

/** Resolve deny-only session restrictions through authoritative stored ancestry before reads. */
export async function resolveSessionVisibilityRestrictionDenials(params: {
  candidates: readonly SessionVisibilityRow[];
  restrictions: SessionToolVisibilityRestrictions;
  gatewayCall: GatewayCaller;
  hydrateKeys?: Iterable<string>;
}): Promise<Set<string>> {
  if (params.restrictions.denyKeySubstrings.length === 0 || params.candidates.length === 0) {
    return new Set();
  }
  const rows = new Map<string, SessionVisibilityRow>();
  for (const candidate of params.candidates) {
    mergeVisibilityRow(rows, candidate);
  }
  const forcedDenied = new Set<string>();
  const hydrated = new Set<string>();
  const explicitHydration = new Set(
    Array.from(params.hydrateKeys ?? []).flatMap((value) => {
      const key = normalizeOptionalString(value);
      return key ? [key] : [];
    }),
  );

  for (let depth = 0; depth < SESSION_VISIBILITY_ANCESTRY_DEPTH; depth += 1) {
    const denied = resolveDeniedSessionVisibilityKeys(
      [...rows.values()],
      params.restrictions,
      forcedDenied,
    );
    const toDescribe = new Set<string>();
    for (const key of explicitHydration) {
      if (!hydrated.has(key) && !denied.has(key)) {
        toDescribe.add(key);
      }
    }
    for (const row of rows.values()) {
      if (denied.has(row.key)) {
        continue;
      }
      for (const raw of [row.ownerSessionKey, row.spawnedBy, row.parentSessionKey]) {
        const parent = normalizeOptionalString(raw);
        if (parent && !rows.has(parent) && !hydrated.has(parent) && !forcedDenied.has(parent)) {
          toDescribe.add(parent);
        }
      }
    }
    if (toDescribe.size === 0) {
      return denied;
    }
    if (depth === SESSION_VISIBILITY_ANCESTRY_DEPTH - 1) {
      for (const key of toDescribe) {
        forcedDenied.add(key);
      }
      return resolveDeniedSessionVisibilityKeys(
        [...rows.values()],
        params.restrictions,
        forcedDenied,
      );
    }

    const keys = [...toDescribe];
    for (let offset = 0; offset < keys.length; offset += SESSION_VISIBILITY_DESCRIBE_BATCH) {
      const batch = keys.slice(offset, offset + SESSION_VISIBILITY_DESCRIBE_BATCH);
      await Promise.all(
        batch.map(async (key) => {
          hydrated.add(key);
          try {
            const agentId = parseAgentSessionKey(key)?.agentId;
            const listed = await params.gatewayCall<unknown>({
              method: "sessions.list",
              params: {
                search: key,
                limit: 20,
                archived: "all",
                includeGlobal: true,
                includeUnknown: true,
                includeDerivedTitles: false,
                includeLastMessage: false,
                ...(agentId ? { agentId } : {}),
              },
            });
            const row = listedVisibilityRow(listed, key);
            if (row) {
              mergeVisibilityRow(rows, row);
            } else {
              forcedDenied.add(key);
            }
          } catch {
            forcedDenied.add(key);
          }
        }),
      );
    }
  }

  return resolveDeniedSessionVisibilityKeys([...rows.values()], params.restrictions, forcedDenied);
}

/** Resolves the requester context used to filter sandboxed session-tool access. */
export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): {
  mainKey: string;
  alias: string;
  visibility: "spawned" | "all";
  requesterInternalKey: string | undefined;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
} {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : undefined;
  const effectiveRequesterKey = requesterInternalKey ?? alias;
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    Boolean(requesterInternalKey) &&
    !isSubagentSessionKey(requesterInternalKey);
  // Main sessions can see all sessions; sandboxed non-subagent callers stay scoped to spawned rows.
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}
