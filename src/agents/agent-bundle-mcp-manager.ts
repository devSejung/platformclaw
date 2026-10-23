/** Session MCP runtime manager: get-or-create and requester-scoped install orchestration. */
import crypto from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createCombinedSessionMcpRuntime,
  isCombinedSessionMcpRuntime,
} from "./agent-bundle-mcp-combined.js";
import {
  createSessionMcpRuntimeManagerInstall,
  SessionMcpRuntimeSupersededError,
} from "./agent-bundle-mcp-manager-install.js";
import {
  createSessionMcpRuntimeManagerLifecycle,
  createSessionMcpRuntimeManagerStore,
  type SessionMcpRuntimeManagerOpts,
  type SessionMcpConfigGeneration,
} from "./agent-bundle-mcp-manager-lifecycle.js";
import { assignSafeServerNames } from "./agent-bundle-mcp-names.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import {
  resolveSessionMcpRuntimeIdleTtlMs,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { revokeMcpAppModelContext } from "./mcp-app-model-context.js";
import {
  buildMcpRequesterRuntimeCacheKey,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";

/** Bound from agent-bundle-mcp-runtime.ts to avoid an import cycle with the facade. */
let defaultCreateSessionMcpRuntime: CreateSessionMcpRuntime | undefined;

export function setDefaultCreateSessionMcpRuntime(fn: CreateSessionMcpRuntime): void {
  defaultCreateSessionMcpRuntime = fn;
}

function resolveCreateSessionMcpRuntime(
  createRuntime?: CreateSessionMcpRuntime,
): CreateSessionMcpRuntime {
  const resolved = createRuntime ?? defaultCreateSessionMcpRuntime;
  if (!resolved) {
    throw new Error("Session MCP runtime factory is not bound");
  }
  return resolved;
}

export function createSessionMcpRuntimeManager(
  opts: SessionMcpRuntimeManagerOpts = {},
): SessionMcpRuntimeManager {
  const store = createSessionMcpRuntimeManagerStore(
    opts,
    resolveCreateSessionMcpRuntime(opts.createRuntime),
  );
  const lifecycle = createSessionMcpRuntimeManagerLifecycle(store);
  const install = createSessionMcpRuntimeManagerInstall(lifecycle);
  const declarationDigestKey = crypto.randomBytes(32);
  const prepareConfig = (params: Parameters<SessionMcpRuntimeManager["getOrCreate"]>[0]) => {
    const fullConfig = loadSessionMcpConfig({ ...params, logDiagnostics: false });
    const safeServerNamesByServer = assignSafeServerNames(
      Object.keys(fullConfig.loaded.mcpServers),
    );
    const { staticServers, requesterScopedServerNames } = partitionMcpServersByConnectionScope(
      fullConfig.loaded.mcpServers,
    );
    const scopedNameSet = new Set(requesterScopedServerNames);
    // Declared endpoints can contain credentials. Keep their change token keyed
    // and process-local; resolved per-user connection material never enters it.
    const digest = crypto
      .createHmac("sha256", declarationDigestKey)
      .update(
        stableStringify({
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          servers: fullConfig.loaded.mcpServers,
          safeNames: [...safeServerNamesByServer],
          apps: params.cfg?.mcp?.apps?.enabled === true,
          denials: Object.fromEntries(
            [...safeServerNamesByServer.keys()].map((name) => [
              name,
              params.toolOverrides?.mcpToolsDeny &&
              Object.hasOwn(params.toolOverrides.mcpToolsDeny, name)
                ? [...new Set(params.toolOverrides.mcpToolsDeny[name])].toSorted()
                : [],
            ]),
          ),
        }),
      )
      .digest("hex");
    let generation = store.configGenerationBySessionId.get(params.sessionId);
    if (!generation || generation.digest !== digest) {
      const retired: Promise<void>[] = [];
      for (const [key, runtime] of store.runtimesBySessionId) {
        if (runtime.sessionId !== params.sessionId || !runtime.requesterScope) {
          continue;
        }
        store.runtimesBySessionId.delete(key);
        store.idleTtlMsBySessionId.delete(key);
        store.connectionMetaByRuntimeKey.delete(key);
        retired.push(
          lifecycle.retainRuntimeKeyCleanup(
            key,
            Promise.resolve().then(() => runtime.dispose()),
          ),
        );
      }
      store.advertisedScopedCatalogBySessionId.delete(params.sessionId);
      generation = {
        digest,
        agentIds: generation?.agentIds ?? new Set<string>(),
        // Carry detached cleanup forward when definitions change again before
        // teardown finishes; session disposal must still own that work.
        retirement: Promise.allSettled([generation?.retirement, ...retired]).then(() => {}),
      } satisfies SessionMcpConfigGeneration;
      // Object identity fences late work, including old -> new -> old definitions.
      store.configGenerationBySessionId.set(params.sessionId, generation);
    }
    const agentId = normalizeOptionalString(params.agentId);
    if (agentId && requesterScopedServerNames.length > 0) {
      generation.agentIds.add(agentId);
    }
    return {
      staticServers,
      requesterScopedServerNames,
      scopedNameSet,
      safeServerNamesByServer,
      generation,
    };
  };
  const assertCurrentSession = (
    sessionId: string,
    generation: SessionMcpConfigGeneration,
    runtime?: SessionMcpRuntime,
  ) => {
    if (
      store.configGenerationBySessionId.get(sessionId) !== generation ||
      (runtime && store.runtimesBySessionId.get(sessionId) !== runtime)
    ) {
      throw new SessionMcpRuntimeSupersededError("Session MCP runtime creation superseded");
    }
  };

  const manager: SessionMcpRuntimeManager = {
    async getOrCreate(params) {
      const {
        staticServers,
        requesterScopedServerNames,
        scopedNameSet,
        safeServerNamesByServer,
        generation,
      } = prepareConfig(params);
      await generation.retirement;
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs();
      await lifecycle.sweepIdleRuntimes();
      assertCurrentSession(params.sessionId, generation);
      if (idleTtlMs > 0) {
        lifecycle.ensureIdleSweepTimer();
      }
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }

      const hasRequesterScoped = requesterScopedServerNames.length > 0;

      if (!hasRequesterScoped) {
        const runtime = await install.getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          generation,
          safeServerNamesByServer,
          toolOverrides: params.toolOverrides,
        });
        assertCurrentSession(params.sessionId, generation, runtime);
        return runtime;
      }

      const hasStaticServers = Object.keys(staticServers).length > 0;
      // Keep one bare runtime even when all declarations are requester-scoped.
      const staticRuntime = await install.getOrCreateRuntimeEntry({
        runtimeKey: params.sessionId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        cfg: params.cfg,
        manifestRegistry: params.manifestRegistry,
        idleTtlMs,
        generation,
        ...(hasStaticServers
          ? { excludeServerNames: scopedNameSet }
          : { includeServerNames: new Set<string>() }),
        safeServerNamesByServer,
        toolOverrides: params.toolOverrides,
      });
      const parts: SessionMcpRuntime[] = hasStaticServers ? [staticRuntime] : [];

      assertCurrentSession(params.sessionId, generation, staticRuntime);

      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      const agentId = normalizeOptionalString(params.agentId);
      if (requesterSenderId || agentId) {
        const requesterScope: SessionMcpRequesterScope = {
          ...(requesterSenderId ? { requesterSenderId } : {}),
          ...(agentId ? { agentId } : {}),
          ...(normalizeOptionalString(params.agentAccountId)
            ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
            : {}),
          ...(normalizeOptionalString(params.messageChannel)
            ? { messageChannel: normalizeOptionalString(params.messageChannel) }
            : {}),
        };
        const runtimeKey = buildMcpRequesterRuntimeCacheKey({
          sessionId: params.sessionId,
          messageChannel: params.messageChannel,
          agentAccountId: params.agentAccountId,
          requesterSenderId,
          agentId,
        });
        const { fingerprint: fullScopedFingerprint } = loadSessionMcpConfig({
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          logDiagnostics: false,
          manifestRegistry: params.manifestRegistry,
          includeServerNames: scopedNameSet,
          redactConnectionServerNames: scopedNameSet,
          safeServerNamesByServer,
          toolOverrides: params.toolOverrides,
        });
        const scopedRuntime = await lifecycle.runExclusiveOnRuntimeKey(runtimeKey, () =>
          install.resolveAndInstallRequesterRuntime({
            runtimeKey,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            requesterScopedServerNames,
            scopedNameSet,
            safeServerNamesByServer,
            fullScopedFingerprint,
            generation,
            requesterSenderId,
            agentId,
            agentAccountId: params.agentAccountId,
            messageChannel: params.messageChannel,
            requesterScope,
            toolOverrides: params.toolOverrides,
          }),
        );
        if (
          scopedRuntime &&
          store.configGenerationBySessionId.get(params.sessionId) === generation
        ) {
          parts.push(scopedRuntime);
        }
        await lifecycle.enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
        if (scopedRuntime && store.runtimesBySessionId.get(runtimeKey) !== scopedRuntime) {
          throw new SessionMcpRuntimeSupersededError("Session MCP runtime creation superseded");
        }
      }

      assertCurrentSession(params.sessionId, generation, staticRuntime);
      if (parts.length === 0) {
        return staticRuntime;
      }

      return createCombinedSessionMcpRuntime({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        parts,
      });
    },
    async getOrCreateRequesterScoped(params) {
      // Scoped-only path for shared-thread harnesses: never open static transports
      // (those stay harness-native) so we do not double-connect.
      const { requesterScopedServerNames, scopedNameSet, safeServerNamesByServer, generation } =
        prepareConfig(params);
      await generation.retirement;
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs();
      await lifecycle.sweepIdleRuntimes();
      if (store.configGenerationBySessionId.get(params.sessionId) !== generation) {
        return undefined;
      }
      if (idleTtlMs > 0) {
        lifecycle.ensureIdleSweepTimer();
      }
      if (params.sessionKey) {
        store.sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      const agentId = normalizeOptionalString(params.agentId);
      if (!requesterSenderId && !agentId) {
        return undefined;
      }
      if (requesterScopedServerNames.length === 0) {
        return undefined;
      }
      const requesterScope: SessionMcpRequesterScope = {
        ...(requesterSenderId ? { requesterSenderId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(normalizeOptionalString(params.agentAccountId)
          ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
          : {}),
        ...(normalizeOptionalString(params.messageChannel)
          ? { messageChannel: normalizeOptionalString(params.messageChannel) }
          : {}),
      };
      const runtimeKey = buildMcpRequesterRuntimeCacheKey({
        sessionId: params.sessionId,
        messageChannel: params.messageChannel,
        agentAccountId: params.agentAccountId,
        requesterSenderId,
        agentId,
      });
      const { fingerprint: fullScopedFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: scopedNameSet,
        redactConnectionServerNames: scopedNameSet,
        safeServerNamesByServer,
        toolOverrides: params.toolOverrides,
      });
      const scopedRuntime = await lifecycle.runExclusiveOnRuntimeKey(runtimeKey, () =>
        install.resolveAndInstallRequesterRuntime({
          runtimeKey,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          requesterScopedServerNames,
          scopedNameSet,
          safeServerNamesByServer,
          fullScopedFingerprint,
          generation,
          requesterSenderId,
          agentId,
          agentAccountId: params.agentAccountId,
          messageChannel: params.messageChannel,
          requesterScope,
          toolOverrides: params.toolOverrides,
        }),
      );
      if (scopedRuntime) {
        const isCurrent = () =>
          store.configGenerationBySessionId.get(params.sessionId) === generation &&
          store.runtimesBySessionId.get(runtimeKey) === scopedRuntime;
        if (!isCurrent()) {
          return undefined;
        }
        let catalog;
        try {
          catalog = await scopedRuntime.getCatalog();
        } catch (error) {
          if (!isCurrent()) {
            return undefined;
          }
          throw error;
        }
        if (!isCurrent()) {
          return undefined;
        }
        lifecycle.rememberAdvertisedScopedCatalog(params.sessionId, catalog, generation);
        await lifecycle.enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
        if (!isCurrent()) {
          return undefined;
        }
      }
      return scopedRuntime;
    },
    getAdvertisedScopedCatalog: lifecycle.getAdvertisedScopedCatalog,
    bindSessionKey(sessionKey, sessionId) {
      store.sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return store.sessionIdBySessionKey.get(sessionKey);
    },
    peekSession(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? store.sessionIdBySessionKey.get(params.sessionKey) : undefined);
      return sessionId ? store.runtimesBySessionId.get(sessionId) : undefined;
    },
    async disposeSession(sessionId) {
      await lifecycle.disposeManagedSession(sessionId);
    },
    async disposeAgentScoped(agentId, options) {
      const candidateKeys = new Set([
        ...store.runtimesBySessionId.keys(),
        ...store.createInFlight.keys(),
        ...store.requesterWorkChains.keys(),
      ]);
      const matchingKeys = [...candidateKeys].filter((runtimeKey) => {
        const runtime = store.runtimesBySessionId.get(runtimeKey);
        if (runtime?.requesterScope?.agentId === agentId) {
          return true;
        }
        if (!runtimeKey.startsWith("{")) {
          return false;
        }
        try {
          return (JSON.parse(runtimeKey) as { agentId?: unknown }).agentId === agentId;
        } catch {
          return false;
        }
      });
      if (options?.retireSessionCatalog) {
        // Explicit policy changes retire schemas and fence pending work, even
        // after idle cleanup removed every connection carrying the agent identity.
        const sessionIds = [...store.configGenerationBySessionId]
          .filter(([, generation]) => generation.agentIds.has(agentId))
          .map(([sessionId]) => sessionId);
        await Promise.all(
          sessionIds.map((sessionId) => lifecycle.disposeManagedSession(sessionId)),
        );
      } else {
        await Promise.all(
          matchingKeys.map((runtimeKey) => lifecycle.disposeRuntimeKey(runtimeKey)),
        );
      }
      return matchingKeys.length;
    },
    deferRetirement(sessionId, retirementOpts) {
      if (retirementOpts?.retainAcrossReuse === true) {
        for (const runtimeKey of lifecycle.runtimeKeysForSessionId(sessionId)) {
          const runtime = store.runtimesBySessionId.get(runtimeKey);
          if (runtime) {
            revokeMcpAppModelContext(runtime);
          }
        }
      }
      if (retirementOpts?.retainAcrossReuse === true) {
        store.requiredRetirementSessionIds.add(sessionId);
      } else {
        store.requiredRetirementSessionIds.delete(sessionId);
      }
      if (
        lifecycle.runtimeKeysForSessionId(sessionId).length === 0 &&
        retirementOpts?.retainAcrossReuse !== true
      ) {
        return false;
      }
      store.deferredRetirementSessionIds.add(sessionId);
      return true;
    },
    async completeDeferredRetirement(sessionId, runtime) {
      if (
        !store.deferredRetirementSessionIds.has(sessionId) ||
        (runtime !== undefined && runtime.sessionId !== sessionId)
      ) {
        return false;
      }
      if (
        lifecycle.totalActiveLeasesForSessionId(sessionId) > 0 ||
        (runtime?.activeLeases ?? 0) > 0
      ) {
        return false;
      }
      const managed = lifecycle
        .runtimeKeysForSessionId(sessionId)
        .map((runtimeKey) => store.runtimesBySessionId.get(runtimeKey))
        .filter((entry): entry is SessionMcpRuntime => Boolean(entry));
      if (managed.length === 0) {
        return false;
      }
      const managedSet = new Set(managed);
      if (runtime !== undefined) {
        if (isCombinedSessionMcpRuntime(runtime)) {
          if (!runtime.managedParts.every((part) => managedSet.has(part))) {
            return false;
          }
        } else if (!managedSet.has(runtime)) {
          return false;
        }
      }
      await lifecycle.disposeManagedSession(sessionId, {
        preserveRequiredRetirement: store.requiredRetirementSessionIds.has(sessionId),
      });
      return true;
    },
    disposeAll: lifecycle.disposeAllManagedSessions,
    sweepIdleRuntimes: lifecycle.sweepIdleRuntimes,
    listSessionIds() {
      return [
        ...new Set(Array.from(store.runtimesBySessionId.values(), (runtime) => runtime.sessionId)),
      ].toSorted((a, b) => a.localeCompare(b));
    },
    listRuntimeKeys() {
      return Array.from(store.runtimesBySessionId.keys()).toSorted((a, b) => a.localeCompare(b));
    },
    totalActiveLeasesForSession(sessionId) {
      return lifecycle.totalActiveLeasesForSessionId(sessionId);
    },
  };
  // Test-only bookkeeping snapshot for drain assertions.
  Object.assign(manager, {
    bookkeepingSizesForTest: () => ({
      runtimes: store.runtimesBySessionId.size,
      connectionMeta: store.connectionMetaByRuntimeKey.size,
      createInFlight: store.createInFlight.size,
      requesterWorkChains: store.requesterWorkChains.size,
      sessionKeys: store.sessionIdBySessionKey.size,
      idleTtl: store.idleTtlMsBySessionId.size,
      deferredRetirement: store.deferredRetirementSessionIds.size,
      advertisedScopedCatalogs: store.advertisedScopedCatalogBySessionId.size,
      configGenerations: store.configGenerationBySessionId.size,
    }),
  });
  return manager;
}
