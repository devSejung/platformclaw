/** Session MCP runtime manager lifecycle: maps, idle sweep, dispose, advertised catalog. */
import { logWarn } from "../logger.js";
import {
  DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS,
  SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES,
  SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

type ManagerCreateInFlight = {
  promise: Promise<SessionMcpRuntime>;
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
  generation: SessionMcpConfigGeneration;
};

type AdvertisedScopedCatalogEntry = {
  servers: Map<string, McpServerCatalog>;
  toolsByServer: Map<string, McpCatalogTool[]>;
  signaturesByServer: Map<string, string>;
};

export type SessionMcpConfigGeneration = {
  digest: string;
  retirement: Promise<void>;
};

type SessionMcpRuntimeManagerStore = {
  runtimesBySessionId: Map<string, SessionMcpRuntime>;
  sessionIdBySessionKey: Map<string, string>;
  idleTtlMsBySessionId: Map<string, number>;
  deferredRetirementSessionIds: Set<string>;
  // Reset/delete retirement survives late creation or reuse by the stopping run.
  requiredRetirementSessionIds: Set<string>;
  connectionMetaByRuntimeKey: Map<
    string,
    {
      connectionHash: string;
      resolvedAt: number;
      expiresAt?: number;
      generation: SessionMcpConfigGeneration;
    }
  >;
  configGenerationBySessionId: Map<string, SessionMcpConfigGeneration>;
  advertisedScopedCatalogBySessionId: Map<string, AdvertisedScopedCatalogEntry>;
  requesterWorkChains: Map<string, Promise<unknown>>;
  createInFlight: Map<string, ManagerCreateInFlight>;
  createRuntime: CreateSessionMcpRuntime;
  now: () => number;
  idleSweepIntervalMs: number;
  maxIdleRequesterRuntimes: number;
  enableIdleSweepTimer: boolean;
  idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  idleSweepInFlight: Promise<void> | undefined;
};

export type SessionMcpRuntimeManagerOpts = {
  createRuntime?: CreateSessionMcpRuntime;
  now?: () => number;
  enableIdleSweepTimer?: boolean;
  idleSweepIntervalMs?: number;
  maxIdleRequesterRuntimesPerSession?: number;
};

function parseRuntimeCacheSessionId(runtimeKey: string): string {
  if (!runtimeKey.startsWith("{")) {
    return runtimeKey;
  }
  try {
    const parsed = JSON.parse(runtimeKey) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" ? parsed.sessionId : runtimeKey;
  } catch {
    return runtimeKey;
  }
}

export function createSessionMcpRuntimeManagerStore(
  opts: SessionMcpRuntimeManagerOpts,
  createSessionMcpRuntime: CreateSessionMcpRuntime,
): SessionMcpRuntimeManagerStore {
  return {
    // Keys are bare sessionId for static runtimes, or requester composite JSON keys.
    runtimesBySessionId: new Map<string, SessionMcpRuntime>(),
    sessionIdBySessionKey: new Map<string, string>(),
    idleTtlMsBySessionId: new Map<string, number>(),
    deferredRetirementSessionIds: new Set<string>(),
    requiredRetirementSessionIds: new Set<string>(),
    // Manager-side only: connection hash + resolve time. Never stores raw url/headers.
    connectionMetaByRuntimeKey: new Map(),
    configGenerationBySessionId: new Map(),
    /**
     * Session-stable advertised catalogs for requester-scoped servers.
     * Keyed by sessionId → serverName. Specs must not vary per sender or shared
     * Codex threads rotate (dynamicToolsFingerprint churn).
     */
    advertisedScopedCatalogBySessionId: new Map(),
    /**
     * Per-key serialization for requester resolve/install and cleanup drains.
     * Eager detach revokes ownership before a blocked chain drains; generation
     * checks prevent its remaining work from publishing into a replacement.
     */
    requesterWorkChains: new Map(),
    createRuntime: opts.createRuntime ?? createSessionMcpRuntime,
    now: opts.now ?? Date.now,
    // Creation claims span static and scoped keys; requester resolution also serializes above.
    createInFlight: new Map(),
    idleSweepIntervalMs: opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
    maxIdleRequesterRuntimes:
      opts.maxIdleRequesterRuntimesPerSession ?? SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES,
    enableIdleSweepTimer: opts.enableIdleSweepTimer !== false,
    idleSweepTimer: undefined,
    idleSweepInFlight: undefined,
  };
}

export type SessionMcpRuntimeManagerLifecycle = {
  store: SessionMcpRuntimeManagerStore;
  runtimeKeysForSessionId: (sessionId: string) => string[];
  totalActiveLeasesForSessionId: (sessionId: string) => number;
  runExclusiveOnRuntimeKey: <T>(runtimeKey: string, work: () => Promise<T>) => Promise<T>;
  retainRuntimeKeyCleanup: (runtimeKey: string, cleanup: Promise<void>) => Promise<void>;
  sweepIdleRuntimes: () => Promise<number>;
  enforceRequesterRuntimeCap: (sessionId: string, keepRuntimeKey: string) => Promise<void>;
  ensureIdleSweepTimer: () => void;
  disposeRuntimeKeyNow: (runtimeKey: string) => Promise<void>;
  disposeRuntimeKey: (runtimeKey: string) => Promise<void>;
  disposeManagedSession: (
    sessionId: string,
    opts?: { preserveRequiredRetirement?: boolean },
  ) => Promise<void>;
  disposeAllManagedSessions: () => Promise<void>;
  rememberAdvertisedScopedCatalog: (
    sessionId: string,
    catalog: McpToolCatalog,
    generation: SessionMcpConfigGeneration,
  ) => void;
  getAdvertisedScopedCatalog: (sessionId: string) => McpToolCatalog | null;
};

function scopedCatalogToolsSignature(tools: readonly McpCatalogTool[]): string {
  return JSON.stringify(
    tools.map((tool) => [
      tool.serverName,
      tool.safeServerName,
      tool.toolName,
      tool.title ?? "",
      tool.description ?? "",
      tool.fallbackDescription,
      tool.inputSchema,
      tool.uiResourceUri ?? "",
      tool.uiVisibility ?? null,
    ]),
  );
}

export function createSessionMcpRuntimeManagerLifecycle(
  store: SessionMcpRuntimeManagerStore,
): SessionMcpRuntimeManagerLifecycle {
  const forgetSessionKeysForSessionId = (sessionId: string) => {
    for (const [sessionKey, mappedSessionId] of store.sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) {
        store.sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const runtimeKeysForSessionId = (sessionId: string): string[] => {
    const keys: string[] = [];
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      if (runtime.sessionId === sessionId) {
        keys.push(runtimeKey);
      }
    }
    return keys;
  };

  const totalActiveLeasesForSessionId = (sessionId: string): number => {
    let total = 0;
    for (const runtimeKey of runtimeKeysForSessionId(sessionId)) {
      total += store.runtimesBySessionId.get(runtimeKey)?.activeLeases ?? 0;
    }
    return total;
  };

  const runExclusiveOnRuntimeKey = <T>(runtimeKey: string, work: () => Promise<T>): Promise<T> => {
    const previous = store.requesterWorkChains.get(runtimeKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => work());
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    store.requesterWorkChains.set(runtimeKey, settled);
    void settled.finally(() => {
      if (store.requesterWorkChains.get(runtimeKey) === settled) {
        store.requesterWorkChains.delete(runtimeKey);
      }
    });
    return run;
  };

  const retainRuntimeKeyCleanup = (runtimeKey: string, cleanup: Promise<void>): Promise<void> => {
    // Detached teardown remains discoverable to every revocation path. Only
    // the key's drain waits for prior resolver work; eager cleanup does not.
    const settled = cleanup.catch(() => undefined);
    void runExclusiveOnRuntimeKey(runtimeKey, () => settled);
    return cleanup;
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = store.now();
    const expired: Promise<void>[] = [];
    const touchedSessionIds = new Set<string>();
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      const connectionExpiresAt = store.connectionMetaByRuntimeKey.get(runtimeKey)?.expiresAt;
      const credentialNearExpiry =
        connectionExpiresAt !== undefined &&
        nowMs + store.idleSweepIntervalMs >= connectionExpiresAt;
      const idleTtlMs =
        store.idleTtlMsBySessionId.get(runtimeKey) ??
        store.idleTtlMsBySessionId.get(runtime.sessionId) ??
        DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
      // Credential expiry is an authorization boundary. Retire before expiry
      // even with an active lease; the next run resolves refreshed credentials.
      if (!credentialNearExpiry && (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0)) {
        continue;
      }
      if (!credentialNearExpiry && nowMs - runtime.lastUsedAt < idleTtlMs) {
        continue;
      }
      store.runtimesBySessionId.delete(runtimeKey);
      store.idleTtlMsBySessionId.delete(runtimeKey);
      store.connectionMetaByRuntimeKey.delete(runtimeKey);
      touchedSessionIds.add(runtime.sessionId);
      expired.push(
        retainRuntimeKeyCleanup(
          runtimeKey,
          Promise.resolve().then(() => runtime.dispose()),
        ),
      );
    }
    for (const sessionId of touchedSessionIds) {
      if (runtimeKeysForSessionId(sessionId).length === 0) {
        store.deferredRetirementSessionIds.delete(sessionId);
        forgetSessionKeysForSessionId(sessionId);
      }
    }
    await Promise.allSettled(expired);
    return expired.length;
  };

  /**
   * A busy shared channel can otherwise accumulate one live scoped runtime per
   * sender until the idle TTL fires. Evict LRU zero-lease requester runtimes
   * beyond the cap; leased runtimes and the bare static runtime never evict.
   */
  const enforceRequesterRuntimeCap = async (
    sessionId: string,
    keepRuntimeKey: string,
  ): Promise<void> => {
    const requesterKeys = runtimeKeysForSessionId(sessionId).filter(
      (runtimeKey) => runtimeKey !== sessionId,
    );
    const overflow = requesterKeys.length - store.maxIdleRequesterRuntimes;
    if (overflow <= 0) {
      return;
    }
    const evictable = requesterKeys
      .filter((runtimeKey) => runtimeKey !== keepRuntimeKey)
      .map((runtimeKey) => ({
        runtimeKey,
        runtime: store.runtimesBySessionId.get(runtimeKey),
      }))
      .filter(
        (entry): entry is { runtimeKey: string; runtime: SessionMcpRuntime } =>
          entry.runtime !== undefined && (entry.runtime.activeLeases ?? 0) === 0,
      )
      .toSorted((a, b) => a.runtime.lastUsedAt - b.runtime.lastUsedAt)
      .slice(0, overflow);
    for (const { runtimeKey, runtime } of evictable) {
      // Serialize with in-flight work on that key so eviction cannot clobber a
      // concurrent reuse or install for the same requester.
      await runExclusiveOnRuntimeKey(runtimeKey, async () => {
        const current = store.runtimesBySessionId.get(runtimeKey);
        if (current !== runtime || (current.activeLeases ?? 0) > 0) {
          return;
        }
        store.runtimesBySessionId.delete(runtimeKey);
        store.idleTtlMsBySessionId.delete(runtimeKey);
        store.connectionMetaByRuntimeKey.delete(runtimeKey);
        await current.dispose();
      });
    }
  };

  const queueIdleSweep = () => {
    if (store.idleSweepInFlight) {
      return;
    }
    store.idleSweepInFlight = sweepIdleRuntimes()
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
      })
      .finally(() => {
        store.idleSweepInFlight = undefined;
      });
  };

  const ensureIdleSweepTimer = () => {
    if (!store.enableIdleSweepTimer || store.idleSweepIntervalMs <= 0 || store.idleSweepTimer) {
      return;
    }
    store.idleSweepTimer = setInterval(queueIdleSweep, store.idleSweepIntervalMs);
    store.idleSweepTimer.unref?.();
  };

  const clearIdleSweepTimer = () => {
    if (!store.idleSweepTimer) {
      return;
    }
    clearInterval(store.idleSweepTimer);
    store.idleSweepTimer = undefined;
  };

  const disposeRuntimeKeyNow = async (runtimeKey: string): Promise<void> => {
    const inFlight = store.createInFlight.get(runtimeKey);
    store.createInFlight.delete(runtimeKey);
    const runtime = store.runtimesBySessionId.get(runtimeKey);
    // Detach before draining; a replacement may reuse this key during teardown.
    store.runtimesBySessionId.delete(runtimeKey);
    store.idleTtlMsBySessionId.delete(runtimeKey);
    store.connectionMetaByRuntimeKey.delete(runtimeKey);
    const lateRuntime = await inFlight?.promise.catch(() => undefined);
    await Promise.all(
      [...new Set([runtime, lateRuntime])].map((entry) => Promise.resolve(entry?.dispose())),
    );
  };

  const disposeRuntimeKey = (runtimeKey: string): Promise<void> => {
    const sessionId = parseRuntimeCacheSessionId(runtimeKey);
    const generation = store.configGenerationBySessionId.get(sessionId);
    // Capture existing cleanup now; a new generation can detach the runtime
    // while this key's resolver is still blocked. The queue retains that drain.
    const captured = Promise.allSettled([disposeRuntimeKeyNow(runtimeKey)]);
    return runExclusiveOnRuntimeKey(runtimeKey, async () => {
      // Same-generation revalidation may install after the eager detach.
      // Old disposal must never remove work from a newer generation.
      const late = Promise.allSettled([
        store.configGenerationBySessionId.get(sessionId) === generation
          ? disposeRuntimeKeyNow(runtimeKey)
          : Promise.resolve(),
      ]);
      const outcomes = [...(await captured), ...(await late)];
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          throw outcome.reason;
        }
      }
    });
  };

  const disposeManagedSession = async (
    sessionId: string,
    opts?: { preserveRequiredRetirement?: boolean },
  ): Promise<void> => {
    // Invalidate before draining: a late resolver/catalog must not republish
    // the retired session, even when a new generation reuses its session id.
    const retirement = store.configGenerationBySessionId.get(sessionId)?.retirement;
    store.configGenerationBySessionId.delete(sessionId);
    store.deferredRetirementSessionIds.delete(sessionId);
    if (opts?.preserveRequiredRetirement !== true) {
      store.requiredRetirementSessionIds.delete(sessionId);
    }
    store.advertisedScopedCatalogBySessionId.delete(sessionId);
    forgetSessionKeysForSessionId(sessionId);
    const runtimeKeys = new Set(runtimeKeysForSessionId(sessionId));
    for (const runtimeKey of store.createInFlight.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        runtimeKeys.add(runtimeKey);
      }
    }
    for (const runtimeKey of store.requesterWorkChains.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        runtimeKeys.add(runtimeKey);
      }
    }
    await Promise.allSettled([
      retirement,
      ...[...runtimeKeys].map((runtimeKey) => disposeRuntimeKey(runtimeKey)),
    ]);
  };

  const disposeAllManagedSessions = async (): Promise<void> => {
    clearIdleSweepTimer();
    const sessionIds = new Set([
      ...store.configGenerationBySessionId.keys(),
      ...store.sessionIdBySessionKey.values(),
      ...store.deferredRetirementSessionIds,
      ...store.requiredRetirementSessionIds,
      ...Array.from(store.runtimesBySessionId.values(), (runtime) => runtime.sessionId),
      ...[...store.createInFlight.keys(), ...store.requesterWorkChains.keys()].map(
        parseRuntimeCacheSessionId,
      ),
    ]);
    // Global shutdown uses the same eager, discoverable per-session cleanup.
    // Clearing ownership maps first would hide live transports from agent revocation.
    await Promise.allSettled([...sessionIds].map((sessionId) => disposeManagedSession(sessionId)));
  };

  const rememberAdvertisedScopedCatalog = (
    sessionId: string,
    catalog: McpToolCatalog,
    generation: SessionMcpConfigGeneration,
  ): void => {
    if (store.configGenerationBySessionId.get(sessionId) !== generation) {
      return;
    }
    let entry = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry) {
      entry = {
        servers: new Map(),
        toolsByServer: new Map(),
        signaturesByServer: new Map(),
      };
      store.advertisedScopedCatalogBySessionId.set(sessionId, entry);
    }
    const toolsByServerName = new Map<string, McpCatalogTool[]>();
    for (const tool of catalog.tools) {
      const list = toolsByServerName.get(tool.serverName) ?? [];
      list.push(tool);
      toolsByServerName.set(tool.serverName, list);
    }
    for (const [serverName, server] of Object.entries(catalog.servers)) {
      const tools = (toolsByServerName.get(serverName) ?? []).toSorted((a, b) =>
        a.toolName.localeCompare(b.toolName),
      );
      const signature = scopedCatalogToolsSignature(tools);
      // Utility permissions can change without changing listed MCP tools.
      entry.servers.set(serverName, server);
      // Identity compare: overwrite only when the listed tool surface changes.
      if (entry.signaturesByServer.get(serverName) === signature) {
        continue;
      }
      entry.toolsByServer.set(serverName, tools);
      entry.signaturesByServer.set(serverName, signature);
    }
  };

  const getAdvertisedScopedCatalog = (sessionId: string): McpToolCatalog | null => {
    const entry = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry || entry.servers.size === 0) {
      return null;
    }
    const servers: Record<string, McpServerCatalog> = {};
    const tools: McpCatalogTool[] = [];
    for (const serverName of [...entry.servers.keys()].toSorted((a, b) => a.localeCompare(b))) {
      servers[serverName] = entry.servers.get(serverName)!;
      tools.push(...(entry.toolsByServer.get(serverName) ?? []));
    }
    tools.sort((a, b) => {
      const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
      if (serverOrder !== 0) {
        return serverOrder;
      }
      return a.toolName.localeCompare(b.toolName);
    });
    return {
      version: 1,
      generatedAt: store.now(),
      servers,
      tools,
    };
  };

  return {
    store,
    runtimeKeysForSessionId,
    totalActiveLeasesForSessionId,
    runExclusiveOnRuntimeKey,
    retainRuntimeKeyCleanup,
    sweepIdleRuntimes,
    enforceRequesterRuntimeCap,
    ensureIdleSweepTimer,
    disposeRuntimeKeyNow,
    disposeRuntimeKey,
    disposeManagedSession,
    disposeAllManagedSessions,
    rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog,
  };
}
