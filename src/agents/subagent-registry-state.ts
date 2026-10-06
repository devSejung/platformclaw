import { isDeepStrictEqual } from "node:util";
import { isVitestRuntimeEnv } from "../infra/env.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges process-local active runs with persisted SQLite state for cross-process readers.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentSessionListRunsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunReadRecord, SubagentRunRecord } from "./subagent-registry.types.js";

const SUBAGENT_RUNS_READ_CACHE_TTL_MS = 500;

// A restored collector is a read replica until this process changes its owner
// state or actually dispatches it. Keep provenance on the exact object so a
// replacement/new generation can never borrow an older replica's authority.
const restoredCollectorReadSnapshots = new WeakMap<SubagentRunRecord, SubagentRunRecord>();

function collectorReadOwnerState(entry: SubagentRunRecord): SubagentRunRecord {
  const snapshot = { ...entry };
  // Retention backfill is metadata, not adoption of execution or wait ownership.
  delete snapshot.archiveAtMs;
  return snapshot;
}

/** An actual restored dispatch takes local authority before asynchronous effects. */
export function adoptRestoredSubagentRun(entry: SubagentRunRecord): void {
  restoredCollectorReadSnapshots.delete(entry);
}

function isUnchangedRestoredCollector(entry: SubagentRunRecord): boolean {
  const snapshot = restoredCollectorReadSnapshots.get(entry);
  if (!snapshot) {
    return false;
  }
  if (isDeepStrictEqual(collectorReadOwnerState(entry), snapshot)) {
    return true;
  }
  // A local lifecycle, generation, cancellation, or authorization mutation is
  // authoritative even if its persistence subsequently fails.
  adoptRestoredSubagentRun(entry);
  return false;
}

type SubagentRunsSnapshot<T extends SubagentRunReadRecord> = {
  loadedAtMs: number;
  runs: Map<string, T>;
};

type SubagentRunsCache<T extends SubagentRunReadRecord> = {
  snapshot?: SubagentRunsSnapshot<T>;
  load: () => Map<string, T>;
  copy: (entry: SubagentRunRecord) => T;
  project: (entry: SubagentRunRecord) => T;
};

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  load: loadSubagentRegistryFromSqlite,
  copy: structuredClone,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  load: () => loadSubagentSessionListRunsFromSqlite(),
  copy: projectSubagentRunForSessionList,
  project: projectSubagentRunForSessionList,
};

type SubagentRegistryPersistListener = () => void;

const SUBAGENT_REGISTRY_PERSIST_LISTENERS = new Set<SubagentRegistryPersistListener>();

function emitSubagentRegistryPersisted(): void {
  for (const listener of SUBAGENT_REGISTRY_PERSIST_LISTENERS) {
    try {
      listener();
    } catch {
      // Persistence already succeeded; observers are best-effort.
    }
  }
}

/** Observe local writes immediately and remote SQLite writes at the read-cache cadence. */
export function observeSubagentRegistryChanges(
  listener: SubagentRegistryPersistListener,
): () => void {
  SUBAGENT_REGISTRY_PERSIST_LISTENERS.add(listener);
  // SQLite completions can be persisted by a different Gateway worker. The
  // process-local event alone cannot wake that reader; keep one bounded probe
  // per active observer, and release it together with the local subscription.
  const timer = setInterval(listener, SUBAGENT_RUNS_READ_CACHE_TTL_MS);
  return () => {
    clearInterval(timer);
    SUBAGENT_REGISTRY_PERSIST_LISTENERS.delete(listener);
  };
}

function projectSubagentRunForSessionList(entry: SubagentRunRecord): SubagentRunReadRecord {
  return {
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    ...(entry.controllerSessionKey ? { controllerSessionKey: entry.controllerSessionKey } : {}),
    requesterSessionKey: entry.requesterSessionKey,
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.generation !== undefined ? { generation: entry.generation } : {}),
    createdAt: entry.createdAt,
    execution: {
      ...(entry.execution.startedAt !== undefined ? { startedAt: entry.execution.startedAt } : {}),
      ...(entry.execution.endedAt !== undefined ? { endedAt: entry.execution.endedAt } : {}),
      ...(entry.execution.outcome ? { outcome: { status: entry.execution.outcome.status } } : {}),
    },
    ...(entry.sessionStartedAt !== undefined ? { sessionStartedAt: entry.sessionStartedAt } : {}),
    ...(entry.accumulatedRuntimeMs !== undefined
      ? { accumulatedRuntimeMs: entry.accumulatedRuntimeMs }
      : {}),
    ...(entry.runTimeoutSeconds !== undefined
      ? { runTimeoutSeconds: entry.runTimeoutSeconds }
      : {}),
    ...(entry.endedReason ? { endedReason: entry.endedReason } : {}),
    ...(entry.cleanupCompletedAt !== undefined
      ? { cleanupCompletedAt: entry.cleanupCompletedAt }
      : {}),
    ...(entry.delivery
      ? {
          delivery: {
            status: entry.delivery.status,
            ...(entry.delivery.suspendedAt !== undefined
              ? { suspendedAt: entry.delivery.suspendedAt }
              : {}),
          },
        }
      : {}),
  };
}

function rememberSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  loadedAtMs: number,
): void {
  const snapshot = cache.snapshot;
  if (!changedRunIds || !snapshot) {
    cache.snapshot = {
      loadedAtMs,
      runs: new Map([...runs].map(([runId, entry]) => [runId, cache.copy(entry)])),
    };
    return;
  }
  for (const runId of new Set(changedRunIds)) {
    const entry = runs.get(runId);
    if (entry) {
      snapshot.runs.set(runId, cache.copy(entry));
    } else {
      snapshot.runs.delete(runId);
    }
  }
  // A partial write refreshes named rows, not the age of unrelated SQLite
  // observations. Otherwise steady local traffic can hide remote writes forever.
}

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): void {
  const loadedAtMs = Date.now();
  rememberSubagentRunsSnapshot(persistedSubagentRunsReadCache, runs, changedRunIds, loadedAtMs);
  rememberSubagentRunsSnapshot(
    persistedSubagentSessionListRunsReadCache,
    runs,
    changedRunIds,
    loadedAtMs,
  );
}

function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

function getFreshPersistedSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
  nowMs: number,
): Map<string, T> | null {
  const cached = cache.snapshot;
  return cached &&
    nowMs >= cached.loadedAtMs &&
    nowMs - cached.loadedAtMs < SUBAGENT_RUNS_READ_CACHE_TTL_MS
    ? cached.runs
    : null;
}

function loadPersistedSubagentRunsForRead<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): Map<string, T> {
  const nowMs = Date.now();
  const cached = getFreshPersistedSubagentRunsSnapshot(cache, nowMs);
  if (cached) {
    return cached;
  }
  cache.snapshot = { loadedAtMs: nowMs, runs: cache.load() };
  return cache.snapshot.runs;
}

export function clearSubagentRunsReadCacheForTest(): void {
  persistedSubagentRunsReadCache.snapshot = undefined;
  persistedSubagentSessionListRunsReadCache.snapshot = undefined;
}

function persistSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  strict: boolean,
): void {
  try {
    if (changedRunIds) {
      saveSubagentRegistryChangesToSqlite(runs, changedRunIds);
    } else {
      saveSubagentRegistryToSqlite(runs);
    }
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  for (const runId of changedRunIds ?? runs.keys()) {
    const entry = runs.get(runId);
    if (entry) {
      isUnchangedRestoredCollector(entry);
    }
  }
  // In-process readers must observe the authoritative memory snapshot before the wake.
  rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  emitSubagentRegistryPersisted();
}

export function persistSubagentRunsToDisk(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, false);
}

export function persistSubagentRunsToDiskOrThrow(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, true);
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  if (restored.size === 0) {
    return 0;
  }
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    if (
      entry.collect &&
      !entry.collectorCompletion &&
      entry.execution.status !== "terminal" &&
      !entry.execution.suppressSessionEffects &&
      !entry.killIntent &&
      !entry.killReconciliation &&
      !entry.execution.restartRecovery &&
      entry.terminalOwner !== "interrupted-recovery"
    ) {
      restoredCollectorReadSnapshots.set(entry, structuredClone(collectorReadOwnerState(entry)));
    }
    params.runs.set(runId, entry);
    added += 1;
  }
  return added;
}

function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    key: string;
    load: (key: string) => T[];
    matches: (entry: T, key: string) => boolean;
  },
): Map<string, T> {
  const merged = new Map<string, T>();
  const key = scope?.key.trim() ?? "";
  if (scope && !key) {
    return merged;
  }
  let persistedAvailable = false;
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Persisted state lets other worker processes observe active runs.
      // Scoped reads use indexed SQL unless a fresh local write owns the result.
      const cached = scope ? getFreshPersistedSubagentRunsSnapshot(cache, Date.now()) : null;
      const persisted = scope
        ? cached
          ? [...cached.values()].filter((entry) => scope.matches(entry, key))
          : scope.load(key)
        : loadPersistedSubagentRunsForRead(cache).values();
      for (const entry of persisted) {
        merged.set(entry.runId, scope ? structuredClone(entry) : entry);
      }
      persistedAvailable = true;
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    // Only unchanged restored replicas defer to SQLite, including revocation
    // or deletion. Locally created/adopted/mutated rows keep existing authority.
    if (persistedAvailable && isUnchangedRestoredCollector(entry)) {
      continue;
    }
    const projected = cache.project(entry);
    if (!scope || scope.matches(projected, key)) {
      merged.set(runId, projected);
    } else {
      // Live memory wins even when a run moved out of the persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache);
}

export function getSubagentSessionListRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunReadRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    key: controllerSessionKey,
    load: loadSubagentRunsForControllerFromSqlite,
    matches: (entry, key) =>
      (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === key,
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    key: childSessionKey,
    load: loadSubagentRunsForChildSessionFromSqlite,
    matches: (entry, key) => entry.childSessionKey === key,
  });
}
