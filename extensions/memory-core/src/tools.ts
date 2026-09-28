// Memory Core plugin module implements tools behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemorySearchStaleness,
  stripMemoryAnnotationCarriers,
  type MemoryReadResult,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  asToolParamsRecord,
  jsonResult,
  listMemoryCorpusSupplements,
  readFiniteNumberParam,
  readPositiveIntegerParam,
  readStringParam,
  resolveMemoryDreamingPluginConfig,
  resolveMemorySearchConfig,
  type MemoryCorpusSearchResult,
  type MemoryCorpusSupplementFailure,
  formatMemoryCorpusSupplementFailure,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type {
  MemorySearchResult,
  MemorySearchRuntimeDebug,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { asRecord } from "./dreaming-shared.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  resolveMemorySearchAbortError,
  runMemorySearchWithDeadline,
  type MemorySearchDeadlineAction,
  type MemorySearchDeadlineControlOptions,
} from "./memory/search-deadline.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
import { MEMORY_SEARCH_DESCRIPTION, MEMORY_GET_DESCRIPTION } from "./tool-contract.js";
import {
  clampResultsByInjectedChars,
  decorateCitations,
  resolveMemoryCitationsMode,
  shouldIncludeCitations,
} from "./tools.citations.js";
import {
  buildMemorySearchUnavailableResult,
  createMemoryTool,
  getMemoryCorpusSupplementResult,
  getMemoryManagerContextWithPurpose,
  loadMemoryToolRuntime,
  MemoryGetSchema,
  MemorySearchSchema,
  searchMemoryCorpusSupplements,
} from "./tools.shared.js";

type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;
type MemoryManagerContext = Awaited<ReturnType<typeof getMemoryManagerContextWithPurpose>>;
type ActiveMemoryManagerContext = Extract<MemoryManagerContext, { manager: unknown }>;
type ResolvedMemoryBackendConfig = ReturnType<
  (typeof import("./tools.runtime.js"))["resolveMemoryBackendConfig"]
>;
type MemoryManagerSearchOptions = NonNullable<
  Parameters<ActiveMemoryManagerContext["manager"]["search"]>[1]
> &
  MemorySearchDeadlineControlOptions;
type QmdRuntimeDebug = NonNullable<MemorySearchRuntimeDebug["qmd"]>;

const MEMORY_SEARCH_TOOL_COOLDOWN_MS = 60_000;

const memorySearchToolCooldowns = new Map<string, { until: number; error: string }>();

/**
 * Validate the model-authored corpus argument against the tool's closed enum.
 * Provider tool schemas do not guarantee enum enforcement; an unknown corpus
 * must fail closed instead of falling through to an unrestricted search that
 * could surface recall-only indexed transcripts.
 */
function readCorpusParam<T extends string>(
  rawParams: Record<string, unknown>,
  allowed: readonly T[],
): T | undefined {
  const raw = readStringParam(rawParams, "corpus");
  if (raw === undefined) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T;
  }
  throw new Error(`corpus must be one of: ${allowed.join(", ")}`);
}

function mergeQmdRuntimeDebug(
  entries: readonly MemorySearchRuntimeDebug[],
): MemorySearchRuntimeDebug["qmd"] | undefined {
  const merged: QmdRuntimeDebug = {};
  for (const entry of entries) {
    const qmd = entry.qmd;
    if (!qmd) {
      continue;
    }
    if (!merged.collectionValidation && qmd.collectionValidation) {
      merged.collectionValidation = qmd.collectionValidation;
    }
    if (qmd.multiCollectionProbe) {
      merged.multiCollectionProbe = qmd.multiCollectionProbe;
    }
    if (qmd.searchPlan) {
      merged.searchPlan = qmd.searchPlan;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeEmbeddingBootstrapRuntimeDebug(
  entries: readonly MemorySearchRuntimeDebug[],
): MemorySearchRuntimeDebug["embeddingBootstrap"] | undefined {
  let merged: MemorySearchRuntimeDebug["embeddingBootstrap"];
  for (const entry of entries) {
    if (entry.embeddingBootstrap) {
      merged = entry.embeddingBootstrap;
    }
  }
  return merged;
}

function resolveMemorySearchToolCooldownKey(options: {
  agentId?: string;
  agentSessionKey?: string;
}): string {
  return options.agentId ?? options.agentSessionKey ?? "default";
}

function readMemorySearchToolCooldown(key: string): { error: string } | undefined {
  const entry = memorySearchToolCooldowns.get(key);
  if (!entry) {
    return undefined;
  }
  if (entry.until <= Date.now()) {
    memorySearchToolCooldowns.delete(key);
    return undefined;
  }
  return { error: entry.error };
}

function recordMemorySearchToolCooldown(key: string, error: string): void {
  memorySearchToolCooldowns.set(key, {
    until: Date.now() + MEMORY_SEARCH_TOOL_COOLDOWN_MS,
    error,
  });
}

export const testing = {
  resetMemorySearchToolCooldowns() {
    memorySearchToolCooldowns.clear();
  },
} as const;

function isActiveMemoryManagerContext(
  context: MemoryManagerContext | null,
): context is ActiveMemoryManagerContext {
  return context !== null && "manager" in context;
}

async function closeMemoryManagers(
  managers: Iterable<ActiveMemoryManagerContext["manager"]>,
  parentSignal?: AbortSignal,
): Promise<void> {
  const pending = Array.from(managers, async (manager) => await manager.close?.());
  if (pending.length === 0) {
    return;
  }
  try {
    await runMemorySearchWithDeadline({
      timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
      parentSignal,
      run: async () => {
        await Promise.allSettled(pending);
      },
    });
  } catch {
    // Search results should not be hidden by best-effort transient cleanup.
  }
}

const PAUSED_MEMORY_INDEX_WARNING =
  "Tell the user: memory search is paused because the memory index was built with a different embedding provider/model/settings.";
const PAUSED_MEMORY_INDEX_ACTION =
  "Tell the user to run: openclaw memory status --index or openclaw memory index --force.";

function resolvePausedMemoryIndexIdentityReason(status: { custom?: unknown }): string | undefined {
  const indexIdentity = asRecord(asRecord(status.custom)?.indexIdentity);
  if (indexIdentity?.status !== "mismatched" && indexIdentity?.status !== "missing") {
    return undefined;
  }
  return typeof indexIdentity.reason === "string" && indexIdentity.reason.trim()
    ? indexIdentity.reason.trim()
    : "memory index identity is missing or mismatched";
}

function buildPausedMemoryIndexUnavailableResult(reason: string) {
  return buildMemorySearchUnavailableResult(reason, {
    warning: PAUSED_MEMORY_INDEX_WARNING,
    action: PAUSED_MEMORY_INDEX_ACTION,
  });
}

function mergeRankedMemorySearchToolStreams(
  memoryResults: MemorySearchToolResult[],
  supplementResults: MemorySearchToolResult[],
): MemorySearchToolResult[] {
  const merged: MemorySearchToolResult[] = [];
  let memoryIndex = 0;
  let supplementIndex = 0;
  // Each backend owns its ranking. Memory scores intentionally omit some
  // precedence facts, so compare only stream heads and never reorder a stream.
  while (memoryIndex < memoryResults.length && supplementIndex < supplementResults.length) {
    const memory = memoryResults[memoryIndex];
    const supplement = supplementResults[supplementIndex];
    if ((memory?.score ?? 0) >= (supplement?.score ?? 0)) {
      if (memory) {
        merged.push(memory);
      }
      memoryIndex += 1;
    } else {
      if (supplement) {
        merged.push(supplement);
      }
      supplementIndex += 1;
    }
  }
  merged.push(...memoryResults.slice(memoryIndex), ...supplementResults.slice(supplementIndex));
  return merged;
}

function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = params.memoryResults;
  const supplementResults = params.supplementResults;
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return mergeRankedMemorySearchToolStreams(memoryResults, supplementResults).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  let memoryTake = Math.min(perCorpusCap, memoryResults.length);
  let supplementTake = Math.min(perCorpusCap, supplementResults.length);
  while (memoryTake + supplementTake < params.maxResults) {
    const memory = memoryResults[memoryTake];
    const supplement = supplementResults[supplementTake];
    if (!memory && !supplement) {
      break;
    }
    if (!supplement || (memory && memory.score >= supplement.score)) {
      memoryTake += 1;
    } else {
      supplementTake += 1;
    }
  }

  return mergeRankedMemorySearchToolStreams(
    memoryResults.slice(0, memoryTake),
    supplementResults.slice(0, supplementTake),
  ).slice(0, params.maxResults);
}

function isClosedMemoryStoreError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("database is not open") ||
    message.includes("database connection is not open") ||
    message.includes("database handle is closed") ||
    message.includes("memory search manager is closed")
  );
}

function buildRecallKey(
  result: Pick<MemorySearchResult, "source" | "path" | "startLine" | "endLine">,
): string {
  return `${result.source}:${result.path}:${result.startLine}:${result.endLine}`;
}

function resolveRecallTrackingResults(
  rawResults: MemorySearchResult[],
  surfacedResults: MemorySearchResult[],
): MemorySearchResult[] {
  if (surfacedResults.length === 0 || rawResults.length === 0) {
    return surfacedResults;
  }
  const rawByKey = new Map<string, MemorySearchResult>();
  for (const raw of rawResults) {
    const key = buildRecallKey(raw);
    if (!rawByKey.has(key)) {
      rawByKey.set(key, raw);
    }
  }
  return surfacedResults.map((surfaced) => rawByKey.get(buildRecallKey(surfaced)) ?? surfaced);
}

function queueShortTermRecallTracking(params: {
  workspaceDir?: string;
  query: string;
  rawResults: MemorySearchResult[];
  surfacedResults: MemorySearchResult[];
  timezone?: string;
}): void {
  const trackingResults = resolveRecallTrackingResults(params.rawResults, params.surfacedResults);
  void recordShortTermRecalls({
    workspaceDir: params.workspaceDir,
    query: params.query,
    results: trackingResults,
    timezone: params.timezone,
  }).catch(() => {
    // Gateway tool calls are latency-sensitive and live in a long-running
    // process, so background best-effort tracking is safe here unlike in the CLI.
  });
}

function normalizeActiveMemoryQmdSearchMode(
  value: unknown,
): "inherit" | "search" | "vsearch" | "query" {
  return value === "inherit" || value === "search" || value === "vsearch" || value === "query"
    ? value
    : "search";
}

function isActiveMemorySessionKey(sessionKey?: string): boolean {
  return typeof sessionKey === "string" && sessionKey.includes(":active-memory:");
}

function resolveActiveMemoryQmdSearchModeOverride(
  cfg: OpenClawConfig,
  sessionKey?: string,
): "search" | "vsearch" | "query" | undefined {
  if (!isActiveMemorySessionKey(sessionKey)) {
    return undefined;
  }
  const entry = cfg.plugins?.entries?.["active-memory"];
  const entryRecord =
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { config?: unknown })
      : undefined;
  const pluginConfig =
    entryRecord?.config &&
    typeof entryRecord.config === "object" &&
    !Array.isArray(entryRecord.config)
      ? (entryRecord.config as { qmd?: { searchMode?: unknown } })
      : undefined;
  const searchMode = normalizeActiveMemoryQmdSearchMode(pluginConfig?.qmd?.searchMode);
  return searchMode === "inherit" ? undefined : searchMode;
}

async function getSupplementMemoryReadResult(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all";
  onSupplementStatus?: Parameters<typeof getMemoryCorpusSupplementResult>[0]["onSupplementStatus"];
}) {
  const supplement = await getMemoryCorpusSupplementResult({
    lookup: params.relPath,
    fromLine: params.from,
    lineCount: params.lines,
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    corpus: params.corpus,
    failurePolicy: "continue",
    onSupplementStatus: params.onSupplementStatus,
  });
  if (!supplement) {
    return null;
  }
  const { content, ...rest } = supplement;
  return {
    ...rest,
    text: content,
  };
}

export function createMemorySearchTool(options: {
  runId?: string;
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  activeProjectKeys?: readonly string[];
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
}) {
  return createMemoryTool({
    options,
    label: "Memory Search",
    name: "memory_search",
    description: MEMORY_SEARCH_DESCRIPTION,
    parameters: MemorySearchSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params, callerSignal) => {
        const rawParams = asToolParamsRecord(params);
        if (callerSignal?.aborted) {
          throw resolveMemorySearchAbortError(callerSignal);
        }
        const query = readStringParam(rawParams, "query", { required: true });
        const vaultId = readStringParam(rawParams, "vaultId");
        const vaultName = readStringParam(rawParams, "vaultName");
        if (vaultId && vaultName) {
          return jsonResult({
            results: [],
            error: "Choose only vaultId or vaultName.",
            action: "Use the explicitly selected ID or exact Shared Wiki name, never both.",
          });
        }
        const maxResults = Math.min(50, readPositiveIntegerParam(rawParams, "maxResults") ?? 10);
        const minScore = readFiniteNumberParam(rawParams, "minScore");
        const modelRequestedCorpus = readCorpusParam(rawParams, [
          "memory",
          "wiki",
          "all",
          "sessions",
        ]);
        // The trusted runtime chooses the recall corpus; model-authored arguments cannot broaden it.
        const requestedCorpus =
          options.conversationRecall?.corpus === "sessions" ? "sessions" : modelRequestedCorpus;
        const cooldownKey = resolveMemorySearchToolCooldownKey({
          agentId,
          agentSessionKey: options.agentSessionKey,
        });
        const cooldown =
          requestedCorpus === "wiki" || vaultName || (vaultId && vaultId !== `personal:${agentId}`)
            ? undefined
            : readMemorySearchToolCooldown(cooldownKey);
        let activeUnavailablePhase: "memory" | "supplement" | undefined;
        let failedUnavailablePhase: "memory" | "supplement" | undefined;
        const runUnavailablePhase = async <T>(
          phase: "memory" | "supplement",
          task: () => Promise<T>,
        ): Promise<T> => {
          activeUnavailablePhase = phase;
          try {
            return await task();
          } catch (error) {
            failedUnavailablePhase = phase;
            throw error;
          } finally {
            if (activeUnavailablePhase === phase) {
              activeUnavailablePhase = undefined;
            }
          }
        };
        const runWithDefaultDeadline = async <T>(
          task: (
            signal: AbortSignal,
            controlDeadline: (action: MemorySearchDeadlineAction) => void,
          ) => Promise<T>,
        ): Promise<T> =>
          await runMemorySearchWithDeadline({
            timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
            parentSignal: callerSignal,
            run: task,
          });
        const runMemorySearchTool = async () => {
          const toolStartedAt = Date.now();
          const shouldQuerySupplements =
            requestedCorpus == null || requestedCorpus === "wiki" || requestedCorpus === "all";
          const canFallbackToSupplements =
            shouldQuerySupplements &&
            listMemoryCorpusSupplements().some(
              ({ supplement }) =>
                requestedCorpus !== undefined || supplement.includeByDefault === true,
            );
          const shouldQueryMemory =
            requestedCorpus !== "wiki" &&
            !cooldown &&
            !vaultName &&
            (!vaultId || vaultId === `personal:${agentId}`);
          const supplementWarnings: string[] = [];
          const supplementStatus: Array<{
            pluginId: string;
            status: "ok" | "empty" | "unavailable" | "failed";
            failure?: MemoryCorpusSupplementFailure;
          }> = [];
          const recordMemoryFailure = (status: "unavailable" | "failed") => {
            if (supplementStatus.some((entry) => entry.pluginId === "memory-core")) {
              return;
            }
            supplementStatus.push({ pluginId: "memory-core", status });
            supplementWarnings.push(
              `Personal memory corpus is ${
                status === "unavailable" ? "not configured" : "temporarily unavailable"
              }.`,
            );
          };
          const runMemoryPhase = async <T>(task: () => Promise<T>, fallback: T): Promise<T> => {
            try {
              return await runUnavailablePhase("memory", task);
            } catch (error) {
              if (!canFallbackToSupplements) {
                throw error;
              }
              const message = formatErrorMessage(error);
              recordMemorySearchToolCooldown(cooldownKey, message);
              recordMemoryFailure("failed");
              return fallback;
            }
          };
          if (cooldown && canFallbackToSupplements) {
            recordMemoryFailure("unavailable");
          }
          if (cooldown && !canFallbackToSupplements) {
            return jsonResult(buildMemorySearchUnavailableResult(cooldown.error));
          }
          const memoryManagerPurpose = options.oneShotCliRun ? "cli" : undefined;
          const memoryManagersToClose = new Set<ActiveMemoryManagerContext["manager"]>();
          let cleanupStarted = false;
          const trackMemoryManager = (context: MemoryManagerContext): MemoryManagerContext => {
            if (memoryManagerPurpose === "cli" && isActiveMemoryManagerContext(context)) {
              if (cleanupStarted) {
                // Setup can settle after its deadline. Close that late transient
                // manager instead of leaking it after the tool has returned.
                void closeMemoryManagers([context.manager]);
              } else {
                memoryManagersToClose.add(context.manager);
              }
            }
            return context;
          };
          try {
            type MemorySetup = {
              context: MemoryManagerContext;
              resolvedMemoryBackend: ResolvedMemoryBackendConfig;
            };
            const memorySetup = shouldQueryMemory
              ? await runMemoryPhase<MemorySetup | null>(
                  async () =>
                    await runWithDefaultDeadline(async () => {
                      const { resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
                      const resolvedMemoryBackend = resolveMemoryBackendConfig({ cfg, agentId });
                      const context = trackMemoryManager(
                        await getMemoryManagerContextWithPurpose({
                          cfg,
                          agentId,
                          purpose: memoryManagerPurpose,
                          acquireLocalService: options.acquireLocalService,
                          withLease: options.withLease,
                        }),
                      );
                      return { context, resolvedMemoryBackend };
                    }),
                  null,
                )
              : null;
            const memory = memorySetup?.context ?? null;
            if (shouldQueryMemory && memory && "error" in memory && !canFallbackToSupplements) {
              recordMemorySearchToolCooldown(
                cooldownKey,
                memory.error ?? "memory search unavailable",
              );
              return jsonResult(buildMemorySearchUnavailableResult(memory.error));
            }
            if (shouldQueryMemory && memory && "error" in memory) {
              recordMemorySearchToolCooldown(
                cooldownKey,
                memory.error ?? "memory search unavailable",
              );
              recordMemoryFailure("unavailable");
            }

            const citationsMode = resolveMemoryCitationsMode(cfg);
            const includeCitations = shouldIncludeCitations({
              mode: citationsMode,
              sessionKey: options.agentSessionKey,
            });
            const pluginConfig = resolveMemoryDreamingPluginConfig(cfg);
            const dreamingEnabled = resolveMemoryDreamingConfig({
              pluginConfig,
              cfg,
            }).enabled;
            const dreaming = resolveMemoryDeepDreamingConfig({
              pluginConfig,
              cfg,
            });
            const searchStartedAt = Date.now();
            let rawResults: MemorySearchResult[] = [];
            let surfacedMemoryResults: Array<MemorySearchResult & { corpus: MemorySource }> = [];
            let provider: string | undefined;
            let model: string | undefined;
            let fallback: unknown;
            let searchMode: string | undefined;
            let pausedIndexIdentityReason: string | undefined;
            let staleness:
              | Exclude<ReturnType<typeof resolveMemorySearchStaleness>, null>
              | undefined;
            let managerMs: number | undefined;
            let managerCacheState: string | undefined;
            let searchDebug:
              | {
                  backend: string;
                  configuredMode?: string;
                  effectiveMode?: string;
                  fallback?: string;
                  toolMs?: number;
                  managerMs?: number;
                  outsideSearchMs?: number;
                  searchMs: number;
                  managerCacheState?: string;
                  embeddingBootstrap?: MemorySearchRuntimeDebug["embeddingBootstrap"];
                  qmd?: MemorySearchRuntimeDebug["qmd"];
                  hits: number;
                }
              | undefined;
            if (shouldQueryMemory && memorySetup && memory && !("error" in memory)) {
              const memorySearchSucceeded = await runMemoryPhase(async () => {
                let activeMemory = memory;
                const runtimeDebug: MemorySearchRuntimeDebug[] = [];
                const qmdSearchModeOverride = resolveActiveMemoryQmdSearchModeOverride(
                  cfg,
                  options.agentSessionKey,
                );
                const memorySearchConfig = resolveMemorySearchConfig(cfg, agentId);
                const defaultSearchSources = memorySearchConfig?.searchSources;
                const trustedConfiguredRecall = options.conversationRecall?.corpus === "configured";
                const effectiveSearchSources = trustedConfiguredRecall
                  ? memorySearchConfig?.sources
                  : defaultSearchSources;
                const trustedTranscriptRecall = options.conversationRecall !== undefined;
                const configuredSessionSearch = defaultSearchSources?.includes("sessions") === true;
                // Product recall may index transcripts without adding them to ordinary model search.
                // Only trusted recall or explicit configuration may search those indexed transcripts.
                const searchSources: MemorySource[] | undefined =
                  requestedCorpus === "sessions"
                    ? trustedTranscriptRecall || configuredSessionSearch
                      ? (["sessions"] as MemorySource[])
                      : defaultSearchSources
                    : requestedCorpus === "memory"
                      ? (["memory"] as MemorySource[])
                      : requestedCorpus == null || requestedCorpus === "all"
                        ? effectiveSearchSources
                        : undefined;
                const createSearchOptions = (
                  signal: AbortSignal,
                  controlDeadline: (action: MemorySearchDeadlineAction) => void,
                ) =>
                  ({
                    maxResults,
                    minScore,
                    sessionKey: options.agentSessionKey,
                    qmdSearchModeOverride,
                    activeProjectKeys: options.activeProjectKeys
                      ? [...options.activeProjectKeys]
                      : undefined,
                    signal,
                    onDebug: (debug: MemorySearchRuntimeDebug) => {
                      runtimeDebug.push(debug);
                    },
                    [MEMORY_SEARCH_DEADLINE_CONTROL]: controlDeadline,
                    ...(searchSources ? { sources: searchSources } : {}),
                  }) satisfies MemoryManagerSearchOptions;
                const searchActiveMemory = async (): Promise<MemorySearchResult[]> =>
                  await runWithDefaultDeadline(
                    async (signal, controlDeadline) =>
                      await activeMemory.manager.search(
                        query,
                        createSearchOptions(signal, controlDeadline),
                      ),
                  );
                managerMs = memory.debug?.managerMs;
                managerCacheState = memory.debug?.managerCacheState;
                try {
                  rawResults = await searchActiveMemory();
                } catch (error) {
                  if (!isClosedMemoryStoreError(error)) {
                    throw error;
                  }
                  const refreshed = await runWithDefaultDeadline(async () =>
                    trackMemoryManager(
                      await getMemoryManagerContextWithPurpose({
                        cfg,
                        agentId,
                        purpose: memoryManagerPurpose,
                        acquireLocalService: options.acquireLocalService,
                        withLease: options.withLease,
                      }),
                    ),
                  );
                  if ("error" in refreshed) {
                    throw error;
                  }
                  managerMs = refreshed.debug?.managerMs;
                  managerCacheState = refreshed.debug?.managerCacheState;
                  activeMemory = refreshed;
                  rawResults = await searchActiveMemory();
                }
                const statusBeforeRetry = activeMemory.manager.status();
                pausedIndexIdentityReason =
                  resolvePausedMemoryIndexIdentityReason(statusBeforeRetry);
                if (pausedIndexIdentityReason) {
                  return false;
                }
                // One-shot CLI managers have no background lifecycle, so keep their bootstrap
                // retry. Long-lived QMD managers must not run update work in the tool hot path.
                if (
                  rawResults.length === 0 &&
                  !runtimeDebug.some((entry) => entry.embeddingBootstrap) &&
                  activeMemory.manager.sync &&
                  (statusBeforeRetry.backend !== "qmd" || options.oneShotCliRun === true)
                ) {
                  await runWithDefaultDeadline(async () => {
                    // Sync may join shared/background manager maintenance and has
                    // no request-cancellation contract. Bound only this tool's wait.
                    await activeMemory.manager.sync?.({ reason: "search", force: true });
                  });
                  rawResults = await searchActiveMemory();
                  pausedIndexIdentityReason = resolvePausedMemoryIndexIdentityReason(
                    activeMemory.manager.status(),
                  );
                  if (pausedIndexIdentityReason) {
                    return false;
                  }
                }
                rawResults = await runWithDefaultDeadline(
                  async () =>
                    await filterMemorySearchHitsBySessionVisibility({
                      cfg,
                      agentId,
                      requesterSessionKey: options.agentSessionKey,
                      sandboxed: options.sandboxed === true,
                      hits: rawResults,
                      conversationRecall: options.conversationRecall,
                    }),
                );
                if (searchSources) {
                  const allowedSources = new Set<MemorySource>(searchSources);
                  rawResults = rawResults.filter((hit) => allowedSources.has(hit.source));
                }
                if (requestedCorpus === "sessions") {
                  rawResults = rawResults.filter((hit) => hit.source === "sessions");
                } else if (requestedCorpus === "memory") {
                  rawResults = rawResults.filter((hit) => hit.source === "memory");
                }
                const status = activeMemory.manager.status();
                staleness = resolveMemorySearchStaleness(status, agentId) ?? undefined;
                const payloadResults = rawResults.map((result) => ({
                  ...result,
                  snippet: stripMemoryAnnotationCarriers(result.snippet),
                }));
                const decorated = decorateCitations(payloadResults, includeCitations);
                const memoryResults =
                  status.backend === "qmd"
                    ? clampResultsByInjectedChars(
                        decorated,
                        memorySetup.resolvedMemoryBackend.qmd?.limits.maxInjectedChars,
                      )
                    : decorated;
                surfacedMemoryResults = memoryResults.map((result) => ({
                  ...result,
                  corpus: result.source,
                  vaultId: `personal:${agentId}`,
                  vaultName: "Personal",
                  vaultType: "personal" as const,
                  documentId: `${result.source}:${result.path}`,
                  title: result.path.split("/").at(-1) ?? result.path,
                }));
                if (dreamingEnabled) {
                  queueShortTermRecallTracking({
                    workspaceDir: status.workspaceDir,
                    query,
                    rawResults,
                    surfacedResults: memoryResults,
                    timezone: dreaming.timezone,
                  });
                }
                provider = status.provider;
                model = status.model;
                fallback = status.fallback;
                const latestDebug = runtimeDebug.at(-1);
                const qmdDebug = mergeQmdRuntimeDebug(runtimeDebug);
                const embeddingBootstrap = mergeEmbeddingBootstrapRuntimeDebug(runtimeDebug);
                searchMode = latestDebug?.effectiveMode;
                const searchMs = Math.max(0, Date.now() - searchStartedAt);
                searchDebug = {
                  backend: status.backend,
                  configuredMode: latestDebug?.configuredMode,
                  effectiveMode:
                    status.backend === "qmd"
                      ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
                      : "n/a",
                  fallback: latestDebug?.fallback,
                  managerMs,
                  searchMs,
                  managerCacheState,
                  embeddingBootstrap,
                  qmd: qmdDebug,
                  hits: rawResults.length,
                };
                return true;
              }, false);
              if (!memorySearchSucceeded) {
                surfacedMemoryResults = [];
                searchDebug = undefined;
              }
              if (pausedIndexIdentityReason) {
                return jsonResult(
                  buildPausedMemoryIndexUnavailableResult(pausedIndexIdentityReason),
                );
              }
            }
            const supplementResults = shouldQuerySupplements
              ? await runUnavailablePhase(
                  "supplement",
                  async () =>
                    await runWithDefaultDeadline(
                      async () =>
                        await searchMemoryCorpusSupplements({
                          query,
                          runId: options.runId,
                          ...(vaultId ? { vaultId } : {}),
                          ...(vaultName ? { vaultName } : {}),
                          maxResults,
                          agentId,
                          agentSessionKey: options.agentSessionKey,
                          sandboxed: options.sandboxed,
                          corpus: requestedCorpus,
                          onSupplementStatus: (pluginId, status, failure) => {
                            supplementStatus.push({
                              pluginId,
                              status,
                              ...(failure ? { failure } : {}),
                            });
                            if (status === "unavailable" || status === "failed") {
                              supplementWarnings.push(
                                failure
                                  ? formatMemoryCorpusSupplementFailure(failure)
                                  : `Memory corpus from plugin "${pluginId}" is ${
                                      status === "unavailable"
                                        ? "not configured"
                                        : "temporarily unavailable"
                                    }.`,
                              );
                            }
                          },
                        }),
                    ),
                )
              : [];
            // Wiki and memory scores use incomparable scales, so corpus=all first
            // balances candidate selection and then backfills any unused slots.
            const effectiveMax = Math.max(1, maxResults ?? 10);
            const results = mergeMemorySearchCorpusResults({
              memoryResults: surfacedMemoryResults,
              supplementResults,
              maxResults: effectiveMax,
              balanceCorpora: requestedCorpus == null || requestedCorpus === "all",
            }).map((result) =>
              Object.assign(
                {},
                result,
                { snippet: truncateUtf16Safe(result.snippet, 1_200) },
                "indexError" in result && result.indexError
                  ? { indexError: truncateUtf16Safe(result.indexError, 500) }
                  : {},
              ),
            );
            for (const result of results) {
              if ("indexStatus" in result && result.indexStatus === "failed") {
                supplementWarnings.push(
                  `${result.vaultName ?? "Knowledge vault"} uses its last successful index: ${result.indexError ?? "compile failed"}. Automatic retry is scheduled; correct the source and use Rebuild in that vault's UI.`,
                );
              }
            }
            if (searchDebug) {
              const finalToolMs = Math.max(0, Date.now() - toolStartedAt);
              searchDebug = {
                ...searchDebug,
                toolMs: finalToolMs,
                outsideSearchMs: Math.max(0, finalToolMs - searchDebug.searchMs),
              };
            }
            return jsonResult({
              results,
              provider,
              model,
              fallback,
              citations: citationsMode,
              mode: searchMode,
              ...staleness,
              ...(supplementWarnings.length > 0 ? { warnings: supplementWarnings } : {}),
              ...(supplementStatus.length > 0 ? { corpusStatus: supplementStatus } : {}),
              debug: searchDebug,
            });
          } finally {
            cleanupStarted = true;
            await closeMemoryManagers(memoryManagersToClose, callerSignal);
          }
        };
        try {
          const result = await runMemorySearchTool();
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          return result;
        } catch (error) {
          if (callerSignal?.aborted) {
            throw resolveMemorySearchAbortError(callerSignal);
          }
          const unavailablePhase = failedUnavailablePhase ?? activeUnavailablePhase;
          const shouldRecordCooldown =
            requestedCorpus !== "wiki" &&
            (requestedCorpus !== "all" || unavailablePhase === "memory");
          const message = formatErrorMessage(error);
          if (shouldRecordCooldown) {
            recordMemorySearchToolCooldown(cooldownKey, message);
          }
          return jsonResult(buildMemorySearchUnavailableResult(message));
        }
      },
  });
}

export function createMemoryGetTool(options: {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
}) {
  return createMemoryTool({
    options,
    label: "Memory Get",
    name: "memory_get",
    description: MEMORY_GET_DESCRIPTION,
    parameters: MemoryGetSchema,
    execute:
      ({ cfg, agentId }) =>
      async (_toolCallId, params) => {
        const rawParams = asToolParamsRecord(params);
        const relPath = readStringParam(rawParams, "path", { required: true });
        const from = readPositiveIntegerParam(rawParams, "from");
        const lines = readPositiveIntegerParam(rawParams, "lines");
        const requestedCorpus = readCorpusParam(rawParams, ["memory", "wiki", "all"]);
        const { readAgentMemoryFile, resolveMemoryBackendConfig } = await loadMemoryToolRuntime();
        const failures: Array<{
          pluginId: string;
          status: string;
          failure?: MemoryCorpusSupplementFailure;
        }> = [];
        const respond = (value: object) =>
          jsonResult({
            ...value,
            ...(failures.length
              ? {
                  corpusStatus: failures,
                  warnings: failures.map(({ pluginId, failure }) =>
                    failure
                      ? formatMemoryCorpusSupplementFailure(failure)
                      : `Knowledge source ${pluginId} is unavailable. Retry or check its configuration.`,
                  ),
                }
              : {}),
          });
        const trySupplement = async () =>
          await getSupplementMemoryReadResult({
            relPath,
            from: from ?? undefined,
            lines: lines ?? undefined,
            agentId,
            agentSessionKey: options.agentSessionKey,
            sandboxed: options.sandboxed,
            corpus: requestedCorpus,
            onSupplementStatus: (pluginId, status, failure) => {
              if (status === "failed" || status === "unavailable") {
                failures.push({ pluginId, status, ...(failure ? { failure } : {}) });
              }
            },
          });
        // Default exact reads ask document owners first, independent of Personal backend health.
        // Explicit corpus=all retains its existing Personal-file precedence, including empty ranges.
        if (requestedCorpus == null || requestedCorpus === "wiki") {
          const supplement = await trySupplement();
          if (supplement) {
            return respond(supplement);
          }
          if (requestedCorpus === "wiki" || failures.some(({ failure }) => failure)) {
            return respond({
              path: relPath,
              text: "",
              disabled: true,
              error: failures.some(({ failure }) => failure)
                ? "The document owner could not provide this path. Follow the reported action."
                : "wiki corpus result not found",
            });
          }
        }
        const read = async (task: () => Promise<MemoryReadResult>) => {
          try {
            const result = await task();
            if (
              requestedCorpus === "all" &&
              result.path === relPath &&
              result.text === "" &&
              result.from === undefined
            ) {
              const supplement = await trySupplement();
              if (supplement) {
                return respond(supplement);
              }
            }
            return respond(result);
          } catch (error) {
            if (requestedCorpus === "all") {
              const supplement = await trySupplement();
              if (supplement) {
                return respond(supplement);
              }
            }
            return respond({
              path: relPath,
              text: "",
              disabled: true,
              error: formatErrorMessage(error),
            });
          }
        };
        const resolved = resolveMemoryBackendConfig({ cfg, agentId });
        if (resolved.backend === "builtin") {
          return await read(() =>
            readAgentMemoryFile({
              cfg,
              agentId,
              relPath,
              from: from ?? undefined,
              lines: lines ?? undefined,
            }),
          );
        }
        const memory = await getMemoryManagerContextWithPurpose({
          cfg,
          agentId,
          purpose: "status",
          acquireLocalService: options.acquireLocalService,
          withLease: options.withLease,
        });
        if ("error" in memory) {
          return respond({ path: relPath, text: "", disabled: true, error: memory.error });
        }
        return await read(() =>
          memory.manager.readFile({ relPath, from: from ?? undefined, lines: lines ?? undefined }),
        );
      },
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
