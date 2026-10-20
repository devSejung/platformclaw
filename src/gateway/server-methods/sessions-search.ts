// Session transcript search owns permission-scoped discovery and paged reads.
import {
  ErrorCodes,
  errorShape,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  isConfiguredSessionStoreAgentId,
  isPerAgentSessionStoreConfig,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveStorePath,
} from "../../config/sessions.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.js";
import { searchSessionTranscriptSubstrings } from "../../config/sessions/session-transcript-search-worker.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  canAccessIncognitoSession,
  createSessionListEntryFilter,
  isGatewayAdmin,
} from "../session-sharing.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionSearchHandlers: GatewayRequestHandlers = {
  "sessions.search": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
      return;
    }
    const cfg = context.getRuntimeConfig();
    if (params.scope === "agent" && params.mode !== "substring") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agent scope requires substring search"),
      );
      return;
    }
    const restrictIncognito =
      Boolean(gatewayClientSessionCreator(client)) && !isGatewayAdmin(client);
    const canSearchSessionKey = (sessionKey: string) =>
      !isIncognitoSessionKey(sessionKey) ||
      canAccessIncognitoSession({ cfg, client: client ?? null, sessionKey });
    const requestedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
    const sessionKeys = params.sessionKeys?.map((sessionKey) =>
      requestedAgentId
        ? resolveStoredSessionKeyForAgentStore({ cfg, agentId: requestedAgentId, sessionKey })
        : resolveSessionStoreKey({ cfg, sessionKey }),
    );
    const agentIds = new Set(
      sessionKeys?.map((sessionKey) =>
        requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
          ? requestedAgentId
          : resolveSessionStoreAgentId(cfg, sessionKey),
      ),
    );
    if (
      agentIds.size > 1 ||
      (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessions.search supports one agent per call"),
      );
      return;
    }
    const agentId =
      requestedAgentId ?? agentIds.values().next().value ?? resolveDefaultAgentId(cfg);
    const configured = isConfiguredSessionStoreAgentId(cfg, agentId);
    if (requestedAgentId && !params.sessionKeys && configured && params.scope !== "agent") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
      );
      return;
    }
    const scopedSessionKeysRaw = configured
      ? sessionKeys
      : sessionKeys?.filter((sessionKey) => {
          const sessionAgentId =
            requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
              ? requestedAgentId
              : resolveSessionStoreAgentId(cfg, sessionKey);
          return sessionAgentId === agentId;
        });
    const scopedSessionKeys = scopedSessionKeysRaw?.filter(canSearchSessionKey);
    if (!configured && scopedSessionKeys?.length === 0) {
      respond(true, { results: [] }, undefined);
      return;
    }
    const existingTargets = configured
      ? []
      : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId);
    if (!configured && existingTargets.length === 0) {
      respond(true, { results: [] }, undefined);
      return;
    }
    if (params.mode === "substring") {
      try {
        // Literal UI pages need one authoritative store for stable offsets/counts.
        // Retired multi-store FTS discovery keeps its existing deduplication path below.
        if (existingTargets.length > 1) {
          throw new Error("Search this retired agent's individual sessions instead.");
        }
        const target = existingTargets[0];
        const storePath = target?.storePath ?? resolveStorePath(cfg.session?.store, { agentId });
        const visibleEntry = createSessionListEntryFilter({ client: client ?? null });
        const excludedPrefixes = params.excludeSessionKeyPrefixes ?? [];
        const readVisibleEntries = () =>
          listSessionEntriesReadOnly({ agentId, storePath }).filter(({ sessionKey, entry }) => {
            const parsed = parseAgentSessionKey(sessionKey);
            return (
              (!parsed || normalizeAgentId(parsed.agentId) === agentId) &&
              (params.scope !== "agent" ||
                (sessionKey !== "global" &&
                  sessionKey !== "unknown" &&
                  !isCronSessionKey(sessionKey) &&
                  !isSubagentSessionKey(sessionKey) &&
                  !entry.spawnedBy)) &&
              (!scopedSessionKeys || scopedSessionKeys.includes(sessionKey)) &&
              canSearchSessionKey(sessionKey) &&
              (!visibleEntry || visibleEntry(sessionKey, entry)) &&
              !excludedPrefixes.some((prefix) =>
                sessionKey.toLowerCase().startsWith(prefix.toLowerCase()),
              )
            );
          });
        const entries = readVisibleEntries();
        if (entries.length === 0) {
          respond(true, { results: [], totalCount: 0, hasMore: false });
          return;
        }
        const result = await searchSessionTranscriptSubstrings({
          agentId,
          query,
          limit: params.limit,
          offset: params.offset,
          sessionId: params.sessionId,
          sessionKeys: entries.map((entry) => entry.sessionKey),
          storePath,
        });
        // The worker yields to sharing mutations. Revalidate the entire candidate
        // scope before returning counts, not only the rows on this page.
        const currentKeys = new Set(readVisibleEntries().map(({ sessionKey }) => sessionKey));
        if (
          currentKeys.size !== entries.length ||
          entries.some(({ sessionKey }) => !currentKeys.has(sessionKey))
        ) {
          throw new Error("Conversation visibility changed. Search again.");
        }
        const titles = new Map(
          entries.map(({ sessionKey, entry }) => [sessionKey, entry.label ?? entry.displayName]),
        );
        respond(true, {
          results: result.hits.map((hit) => ({
            ...hit,
            ...(titles.get(hit.sessionKey) ? { title: titles.get(hit.sessionKey) } : {}),
          })),
          totalCount: result.totalCount,
          hasMore: result.hasMore,
          ...(result.indexing ? { indexing: true } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      }
      return;
    }
    try {
      const configuredVisibleSessionKeys =
        restrictIncognito && configured && scopedSessionKeys === undefined
          ? listSessionEntriesReadOnly({
              agentId,
              storePath: resolveStorePath(cfg.session?.store, { agentId }),
            })
              .map((entry) => entry.sessionKey)
              .filter(canSearchSessionKey)
          : undefined;
      const searchTargets = configured ? [undefined] : existingTargets;
      const targetResults = searchTargets.flatMap((target) => {
        const targetSessionKeys =
          scopedSessionKeys ??
          configuredVisibleSessionKeys ??
          (target && (restrictIncognito || !isPerAgentSessionStoreConfig(cfg.session?.store))
            ? listSessionEntriesReadOnly({ agentId: target.agentId, storePath: target.storePath })
                .map((entry) => entry.sessionKey)
                .filter((sessionKey) => {
                  if (!canSearchSessionKey(sessionKey)) {
                    return false;
                  }
                  const parsed = parseAgentSessionKey(sessionKey);
                  return !parsed || normalizeAgentId(parsed.agentId) === agentId;
                })
            : undefined);
        if (targetSessionKeys?.length === 0) {
          return [];
        }
        return [
          searchSessionTranscripts({
            agentId: target?.agentId ?? agentId,
            query,
            // Over-fetch retired multi-store searches so deduplication can still fill the caller's
            // requested page when the same transcript was copied during a store migration.
            limit: configured ? params.limit : 25,
            ...(targetSessionKeys ? { sessionKeys: targetSessionKeys } : {}),
            ...(target ? { storePath: target.storePath } : {}),
          }),
        ];
      });
      const limit = params.limit ?? 10;
      const sortedHits = targetResults
        .flatMap((result) => result.hits)
        .toSorted(
          (left, right) =>
            right.score - left.score ||
            right.timestamp - left.timestamp ||
            left.messageId.localeCompare(right.messageId),
        );
      const seenHits = new Set<string>();
      const hits = sortedHits.filter((hit) => {
        const identity = `${hit.sessionKey}\u0000${hit.sessionId}\u0000${hit.messageId}`;
        if (seenHits.has(identity)) {
          return false;
        }
        seenHits.add(identity);
        return true;
      });
      respond(true, {
        results: hits.slice(0, limit),
        ...(targetResults.some((result) => result.indexing) ? { indexing: true } : {}),
        ...(targetResults.some((result) => result.truncated) || hits.length > limit
          ? { truncated: true }
          : {}),
      });
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
};
