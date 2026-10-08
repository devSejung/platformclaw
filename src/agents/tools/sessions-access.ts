/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway } from "../../gateway/call.js";
import {
  resolveSandboxSessionToolsVisibility,
  sessionVisibilityRowDeniedByRestrictions,
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

export function sessionVisibilityRestrictionIdentity(
  row: Pick<SessionVisibilityRow, "key" | "agentId">,
): string {
  const key = normalizeOptionalString(row.key) ?? "";
  if (!key) {
    return "";
  }
  const parsed = parseAgentSessionKey(key);
  if (parsed?.agentId) {
    return key;
  }
  const agentId = row.agentId ? normalizeAgentId(row.agentId) : "";
  return `${agentId}\0${key}`;
}

function lineageReferenceRow(parent: string, referenceAgentId?: string): SessionVisibilityRow {
  const parsedAgentId = parseAgentSessionKey(parent)?.agentId;
  return {
    key: parent,
    ...(parsedAgentId
      ? { agentId: parsedAgentId }
      : referenceAgentId
        ? { agentId: referenceAgentId }
        : {}),
  };
}

function lineageReferences(row: SessionVisibilityRow) {
  return [
    [row.ownerSessionKey, row.ownerAgentId] as const,
    [row.spawnedBy, row.spawnedByAgentId] as const,
    [row.parentSessionKey, row.parentSessionAgentId] as const,
  ];
}

function resolveDeniedVisibilityIdentities(
  rows: ReadonlyMap<string, SessionVisibilityRow>,
  restrictions: SessionToolVisibilityRestrictions,
  seedDenied: Iterable<string> = [],
): Set<string> {
  const denied = new Set(seedDenied);
  for (const [identity, row] of rows) {
    if (sessionVisibilityRowDeniedByRestrictions(row, restrictions)) {
      denied.add(identity);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [identity, row] of rows) {
      if (denied.has(identity)) {
        continue;
      }
      const parentIdentities = lineageReferences(row)
        .flatMap(([raw, referenceAgentId]) => {
          const parent = normalizeOptionalString(raw);
          return parent
            ? [sessionVisibilityRestrictionIdentity(lineageReferenceRow(parent, referenceAgentId))]
            : [];
        })
        .filter(Boolean);
      if (parentIdentities.some((parentIdentity) => denied.has(parentIdentity))) {
        denied.add(identity);
        changed = true;
      }
    }
  }
  return denied;
}

function mergeVisibilityRow(
  rows: Map<string, SessionVisibilityRow>,
  row: SessionVisibilityRow,
): void {
  const key = normalizeOptionalString(row.key);
  if (!key) {
    return;
  }
  const normalizedRow = { ...row, key };
  const identity = sessionVisibilityRestrictionIdentity(normalizedRow);
  rows.set(identity, { ...rows.get(identity), ...normalizedRow });
}

function resolvedVisibilityRow(
  value: unknown,
  key: string,
  agentId?: string,
): SessionVisibilityRow | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || typeof result.key !== "string") {
    return undefined;
  }
  const lineage =
    result.lineage && typeof result.lineage === "object"
      ? (result.lineage as Record<string, unknown>)
      : {};
  return {
    key,
    ...(agentId ? { agentId } : {}),
    ...(typeof lineage.spawnedBy === "string" ? { spawnedBy: lineage.spawnedBy } : {}),
    ...(typeof lineage.spawnedByAgentId === "string"
      ? { spawnedByAgentId: lineage.spawnedByAgentId }
      : {}),
    ...(typeof lineage.parentSessionKey === "string"
      ? { parentSessionKey: lineage.parentSessionKey }
      : {}),
    ...(typeof lineage.parentSessionAgentId === "string"
      ? { parentSessionAgentId: lineage.parentSessionAgentId }
      : {}),
  };
}

/** Resolve deny-only session restrictions through authoritative stored ancestry before reads. */
export async function resolveSessionVisibilityRestrictionDenials(params: {
  candidates: readonly SessionVisibilityRow[];
  restrictions: SessionToolVisibilityRestrictions;
  gatewayCall: GatewayCaller;
  hydrateKeys?: Iterable<string>;
}): Promise<Set<string>> {
  if (
    ((params.restrictions.denyKeyPatterns?.length ?? 0) === 0 &&
      params.restrictions.denyKeySubstrings.length === 0) ||
    params.candidates.length === 0
  ) {
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
    const denied = resolveDeniedVisibilityIdentities(rows, params.restrictions, forcedDenied);
    const toDescribe = new Map<string, { key: string; agentId?: string }>();
    for (const key of explicitHydration) {
      let matched = false;
      for (const [identity, row] of rows) {
        if (row.key !== key) {
          continue;
        }
        matched = true;
        if (!hydrated.has(identity) && !denied.has(identity)) {
          toDescribe.set(identity, { key, ...(row.agentId ? { agentId: row.agentId } : {}) });
        }
      }
      if (!matched) {
        const agentId = parseAgentSessionKey(key)?.agentId;
        const identity = sessionVisibilityRestrictionIdentity({ key, agentId });
        if (!hydrated.has(identity) && !denied.has(identity)) {
          toDescribe.set(identity, { key, ...(agentId ? { agentId } : {}) });
        }
      }
    }
    for (const [identity, row] of rows) {
      if (denied.has(identity)) {
        continue;
      }
      for (const [raw, referenceAgentId] of lineageReferences(row)) {
        const parent = normalizeOptionalString(raw);
        if (!parent) {
          continue;
        }
        const parsedAgentId = parseAgentSessionKey(parent)?.agentId;
        if (!parsedAgentId && !referenceAgentId) {
          if (!hydrated.has(identity)) {
            toDescribe.set(identity, {
              key: row.key,
              ...(row.agentId ? { agentId: row.agentId } : {}),
            });
          } else {
            forcedDenied.add(sessionVisibilityRestrictionIdentity({ key: parent }));
          }
          continue;
        }
        const parentRow = lineageReferenceRow(parent, referenceAgentId);
        const parentIdentity = sessionVisibilityRestrictionIdentity(parentRow);
        if (
          parentIdentity &&
          !rows.has(parentIdentity) &&
          !hydrated.has(parentIdentity) &&
          !forcedDenied.has(parentIdentity)
        ) {
          toDescribe.set(parentIdentity, {
            key: parent,
            ...(parentRow.agentId ? { agentId: parentRow.agentId } : {}),
          });
        }
      }
    }
    if (toDescribe.size === 0) {
      return resolveDeniedVisibilityIdentities(rows, params.restrictions, forcedDenied);
    }
    if (depth === SESSION_VISIBILITY_ANCESTRY_DEPTH - 1) {
      for (const identity of toDescribe.keys()) {
        forcedDenied.add(identity);
      }
      return resolveDeniedVisibilityIdentities(rows, params.restrictions, forcedDenied);
    }

    const descriptions = [...toDescribe.entries()];
    for (
      let offset = 0;
      offset < descriptions.length;
      offset += SESSION_VISIBILITY_DESCRIBE_BATCH
    ) {
      const batch = descriptions.slice(offset, offset + SESSION_VISIBILITY_DESCRIBE_BATCH);
      await Promise.all(
        batch.map(async ([identity, descriptor]) => {
          hydrated.add(identity);
          try {
            const { key, agentId } = descriptor;
            const resolved = await params.gatewayCall<unknown>({
              method: "sessions.resolve",
              params: {
                key,
                allowMissing: true,
                includeLineage: true,
                ...(agentId ? { agentId } : {}),
              },
            });
            const row = resolvedVisibilityRow(resolved, key, agentId);
            if (row) {
              mergeVisibilityRow(rows, row);
            } else {
              forcedDenied.add(identity);
            }
          } catch {
            forcedDenied.add(identity);
          }
        }),
      );
    }
  }

  return resolveDeniedVisibilityIdentities(rows, params.restrictions, forcedDenied);
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
