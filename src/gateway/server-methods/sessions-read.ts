// Read-only session queries.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsListParams,
  validateSessionsCleanupParams,
  validateSessionsDescribeParams,
  validateSessionsListParams,
  validateSessionsPreviewParams,
  validateSessionsResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  listSessionMembershipKeys,
  runSessionsCleanup,
  serializeSessionCleanupResult,
  type SessionEntry,
} from "../../config/sessions.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-run-registry.js";
import {
  measureDiagnosticsTimelineSpan,
  measureDiagnosticsTimelineSpanSync,
} from "../../infra/diagnostics-timeline.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import {
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionPreviewItemsFromTranscript,
} from "../session-transcript-readers.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "../session-utils-store-lookup.js";
import {
  buildGatewaySessionRow,
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { readPreparedServerMethodModelCatalog } from "./optional-model-catalog.js";
import {
  collectTrackedActiveSessionRuns,
  resolveVisibleActiveSessionRunState,
} from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { respondWithCachedSessionList } from "./sessions-list-cache.js";
import { sessionSearchHandlers } from "./sessions-search.js";
import {
  filterSessionStoreToConfiguredAgents,
  loadSessionEntriesForTarget,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionReadHandlers: GatewayRequestHandlers = {
  ...sessionSearchHandlers,
  "sessions.list": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params as SessionsListParams;
    const cfg = context.getRuntimeConfig();
    const configuredAgentsOnly = p.configuredAgentsOnly === true;
    const excludedPrefixes = p.excludeSessionKeyPrefixes?.map((prefix) => prefix.toLowerCase());
    const run = () =>
      measureDiagnosticsTimelineSpan(
        "gateway.sessions.list",
        async function listVisibleSessions(
          options: {
            allowFullReload?: boolean;
            excludedKeys?: ReadonlySet<string>;
            loaded?: {
              durableStorePath?: string;
              listStore: Record<string, SessionEntry>;
              modelCatalog: Awaited<ReturnType<typeof readPreparedServerMethodModelCatalog>>;
              storePath: string;
            };
            rowRepairAttempted?: boolean;
          } = {},
        ): Promise<Awaited<ReturnType<typeof listSessionsFromStoreAsync>>> {
          let loaded = options.loaded;
          if (!loaded) {
            const modelCatalog = await measureDiagnosticsTimelineSpan(
              "gateway.sessions.list.model_catalog",
              () =>
                readPreparedServerMethodModelCatalog(
                  context,
                  p.agentId ? { agentId: p.agentId } : undefined,
                ),
              {
                config: cfg,
                phase: "sessions.list",
              },
            );
            const { durableStorePath, storePath, store } = measureDiagnosticsTimelineSpanSync(
              "gateway.sessions.list.store_load",
              () =>
                loadCombinedSessionStoreForGateway(cfg, {
                  agentId: p.agentId,
                  projection: "list",
                }),
              {
                config: cfg,
                phase: "sessions.list",
                attributes: {
                  agentId: p.agentId ?? null,
                  configuredAgentsOnly,
                },
              },
            );
            loaded = {
              durableStorePath,
              listStore: configuredAgentsOnly
                ? filterSessionStoreToConfiguredAgents(cfg, store)
                : store,
              modelCatalog,
              storePath,
            };
          }
          if (!loaded) {
            throw new Error("sessions.list store input was not loaded");
          }
          const { durableStorePath, listStore, modelCatalog, storePath } = loaded;
          const visibilityFilter = createSessionListEntryFilter({ client });
          const entryFilter =
            visibilityFilter || options.excludedKeys?.size || excludedPrefixes?.length
              ? (key: string, entry: SessionEntry) =>
                  !options.excludedKeys?.has(key) &&
                  !excludedPrefixes?.some((prefix) => key.toLowerCase().startsWith(prefix)) &&
                  (visibilityFilter?.(key, entry) ?? true)
              : undefined;
          const result = await measureDiagnosticsTimelineSpan(
            "gateway.sessions.list.rows",
            () =>
              listSessionsFromStoreAsync({
                cfg,
                durableStorePath,
                ...(entryFilter ? { entryFilter } : {}),
                storePath,
                store: listStore,
                modelCatalog,
                opts: p,
              }),
            {
              config: cfg,
              phase: "sessions.list",
            },
          );
          const identityId = gatewayClientSessionCreator(client)?.id;
          const { sharingTargets, membershipKeys } = await measureDiagnosticsTimelineSpan(
            "gateway.sessions.list.sharing",
            () => {
              // One cache for the whole listing: sharing resolution otherwise
              // materialized every entry of a candidate store once per row.
              const sharingStoreCache: GatewaySessionStoreCache = new Map();
              const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
              const resolvedSharingTargets = result.sessions.map((session) =>
                resolveSessionSharingTarget({
                  cfg,
                  projection: "list",
                  sessionKey: session.key,
                  storeCache: sharingStoreCache,
                  targetDiscoveryCache,
                  ...(session.key === "global" && p.agentId ? { agentId: p.agentId } : {}),
                }),
              );
              const resolvedMembershipKeys = new Set<string>();
              if (identityId && !isGatewayAdmin(client)) {
                const groups = new Map<
                  string,
                  {
                    agentId: string;
                    sessionKeys: string[];
                    storePath: string;
                  }
                >();
                for (const target of resolvedSharingTargets) {
                  if (!target) {
                    continue;
                  }
                  const groupKey = `${target.agentId}\0${target.storePath}`;
                  const group = groups.get(groupKey) ?? {
                    agentId: target.agentId,
                    sessionKeys: [],
                    storePath: target.storePath,
                  };
                  group.sessionKeys.push(target.storeKey);
                  groups.set(groupKey, group);
                }
                for (const group of groups.values()) {
                  const firstSessionKey = group.sessionKeys[0];
                  if (!firstSessionKey) {
                    continue;
                  }
                  for (const sessionKey of listSessionMembershipKeys(
                    {
                      agentId: group.agentId,
                      sessionKey: firstSessionKey,
                      storePath: group.storePath,
                    },
                    group.sessionKeys,
                    identityId,
                  )) {
                    resolvedMembershipKeys.add(
                      `${group.agentId}\0${group.storePath}\0${sessionKey}`,
                    );
                  }
                }
              }
              return {
                sharingTargets: resolvedSharingTargets,
                membershipKeys: resolvedMembershipKeys,
              };
            },
            {
              config: cfg,
              phase: "sessions.list",
              attributes: {
                sessions: result.sessions.length,
              },
            },
          );
          const placementsBySessionId = context.workerSessionPlacementService?.getMany(
            result.sessions.flatMap((session) => (session.sessionId ? [session.sessionId] : [])),
          );
          const trackedActiveRuns = collectTrackedActiveSessionRuns(context);
          const projectedAgentRunIndex = buildProjectedAgentRunIndex();
          const defaultAgentId = resolveDefaultAgentId(cfg);
          const sessions = measureDiagnosticsTimelineSpanSync(
            "gateway.sessions.list.active_run_flags",
            () => {
              return result.sessions.map((session, index) => {
                const sharingTarget = sharingTargets[index];
                const visibility = sharingTarget
                  ? resolveSessionVisibility(sharingTarget.entry)
                  : "shared";
                const placementRecord = session.sessionId
                  ? placementsBySessionId?.get(session.sessionId)
                  : undefined;
                const activeRunState = resolveVisibleActiveSessionRunState({
                  context,
                  requestedKey: session.key,
                  canonicalKey: session.key,
                  sessionId: session.sessionId,
                  ...(session.key === "global" && p.agentId ? { agentId: p.agentId } : {}),
                  defaultAgentId,
                  trackedActiveRuns,
                  projectedAgentRunIndex,
                });
                return Object.assign({}, session, {
                  visibility,
                  ...(sharingTarget
                    ? {
                        sharingRole: resolveSessionSharingRole({
                          client,
                          target: sharingTarget,
                          isMember: membershipKeys.has(
                            `${sharingTarget.agentId}\0${sharingTarget.storePath}\0${sharingTarget.storeKey}`,
                          ),
                        }),
                      }
                    : {}),
                  hasActiveRun: activeRunState.active,
                  ...(placementRecord
                    ? { placement: projectWorkerSessionPlacement(placementRecord) }
                    : {}),
                  ...(activeRunState.runIds.length > 0
                    ? { activeRunIds: activeRunState.runIds }
                    : {}),
                });
              });
            },
            {
              config: cfg,
              phase: "sessions.list",
              attributes: {
                sessions: result.sessions.length,
              },
            },
          );
          // The pre-await visibility predicate used a stale store snapshot; re-drop rows
          // whose freshly resolved sharing state is a draft this caller cannot see
          // (a session flipped to draft mid-list, or an older shared alias hiding
          // a now-draft canonical entry). Drafts are owner+admin only — members
          // lose access, matching createSessionListEntryFilter — so keep a draft
          // row only for the owner role. Admins and identity-less solo callers
          // keep everything.
          const canSeeDrafts = !identityId || isGatewayAdmin(client);
          const visibleSessions = canSeeDrafts
            ? sessions
            : sessions.filter(
                (session) =>
                  !session.incognito &&
                  (session.visibility !== "draft" || session.sharingRole === "owner"),
              );
          if (visibleSessions.length !== sessions.length) {
            const visibleKeys = new Set(visibleSessions.map((session) => session.key));
            const excludedKeys = new Set(options.excludedKeys);
            for (const session of sessions) {
              if (!visibleKeys.has(session.key)) {
                excludedKeys.add(session.key);
              }
            }
            if (!options.rowRepairAttempted) {
              // Excluding only freshly rejected rows refills this page from the already-loaded
              // store, preserving cursor continuity without multiplying catalog/store work.
              return await listVisibleSessions({
                ...options,
                excludedKeys,
                loaded,
                rowRepairAttempted: true,
              });
            }
            if (options.allowFullReload !== false) {
              // A second visibility drift means the loaded snapshot cannot restore a coherent
              // page. One full reload is the last resort; repeated drift below fails closed.
              return await listVisibleSessions({ allowFullReload: false });
            }
            return { ...result, count: visibleSessions.length, sessions: visibleSessions };
          }
          return {
            ...result,
            sessions: visibleSessions,
          };
        },
        {
          config: cfg,
          phase: "sessions.list",
          attributes: {
            agentId: p.agentId ?? null,
            configuredAgentsOnly,
          },
        },
      );
    await respondWithCachedSessionList({ client, config: cfg, context, request: p, respond, run });
  },
  "sessions.cleanup": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCleanupParams, "sessions.cleanup", respond)) {
      return;
    }
    try {
      const { mode, appliedSummaries } = await runSessionsCleanup({
        cfg: context.getRuntimeConfig(),
        opts: {
          agent: params.agent,
          allAgents: params.allAgents,
          enforce: params.enforce,
          activeKey: params.activeKey,
          fixMissing: params.fixMissing,
          fixDmScope: params.fixDmScope,
        },
      });
      const result = serializeSessionCleanupResult({
        mode,
        dryRun: false,
        summaries: appliedSummaries,
      });
      respond(true, result, undefined);
      for (const summary of appliedSummaries) {
        emitSessionsChanged(context, {
          reason: "cleanup",
          sessionKey: undefined,
        });
        if (summary.wouldMutate) {
          context.logGateway.debug(
            `sessions.cleanup applied ${summary.storePath}: ${summary.beforeCount} -> ${summary.afterCount}`,
          );
        }
      }
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)));
    }
  },
  "sessions.preview": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => normalizeOptionalString(key ?? ""))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = context.getRuntimeConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const cachedStoreTarget = resolveGatewaySessionStoreTargetWithStore({
          cfg,
          key,
        });
        // Fixed stores share a legacy path but resolve to owner-specific SQLite databases. Keep
        // synthetic misses from poisoning another agent's real store entry in this batch.
        const storeCacheKey = `${cachedStoreTarget.agentId}\u0000${cachedStoreTarget.storePath}`;
        const store = storeCache.get(storeCacheKey) ?? cachedStoreTarget.store;
        storeCache.set(storeCacheKey, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = resolveCanonicalSessionEntryFromStoreKeys(store, target.storeKeys);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          {
            agentId: target.agentId,
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey: target.canonicalKey,
            storePath: target.storePath,
          },
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.describe": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.describe", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const { target, storePath, store, entry } = loadSessionEntriesForTarget({ key, cfg });
    if (!entry) {
      respond(true, { session: null }, undefined);
      return;
    }
    const row = buildGatewaySessionRow({
      cfg,
      storePath,
      store,
      key: target.canonicalKey,
      entry,
      includeDerivedTitles: params.includeDerivedTitles,
      includeLastMessage: params.includeLastMessage,
      transcriptUsageMaxBytes: 64 * 1024,
    });
    const placement = row.sessionId
      ? context.workerSessionPlacementService?.getMany([row.sessionId]).get(row.sessionId)
      : undefined;
    respond(
      true,
      {
        session: placement ? { ...row, placement: projectWorkerSessionPlacement(placement) } : row,
      },
      undefined,
    );
  },
  "sessions.resolve": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    if ("missing" in resolved) {
      respond(true, { ok: false }, undefined);
      return;
    }
    respond(true, resolved, undefined);
  },
  "sessions.get": async ({ params, respond, context }) => {
    const p = params as {
      key?: unknown;
      sessionKey?: unknown;
      limit?: unknown;
      agentId?: unknown;
    };
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      normalizeOptionalString(p.agentId),
    );
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const { storePath, entry } = loadSessionEntriesForTarget({
      key,
      cfg,
      agentId: requestedAgent.agentId,
    });
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const { messages } = await readRecentSessionMessagesWithStatsAsync(
      {
        agentId: requestedAgent.agentId,
        sessionEntry: entry,
        sessionId: entry.sessionId,
        sessionKey: key,
        storePath,
      },
      {
        maxMessages: limit,
        maxLines: limit * 20 + 20,
        allowResetArchiveFallback: true,
      },
    );
    respond(true, { messages }, undefined);
  },
};
