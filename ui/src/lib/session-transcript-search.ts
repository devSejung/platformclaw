import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { parseAgentSessionKey } from "./sessions/session-key.ts";

export type SessionTranscriptSearchHit = SessionsSearchResult["results"][number];

export type SessionTranscriptSearchOptions = {
  query: string;
  agentId?: string;
  agentIds?: string[];
  sessionKeys?: string[];
  sessionId?: string;
  offset?: number;
  limit?: number;
};

/** Transcript scope is resolved by Gateway; browsers never enumerate an allowlist. */
export function searchSessionTranscripts(
  client: GatewayBrowserClient,
  options: SessionTranscriptSearchOptions,
): Promise<SessionsSearchResult> {
  const { agentIds: _agentIds, ...request } = options;
  return client.request<SessionsSearchResult>("sessions.search", {
    ...request,
    mode: "substring",
    ...(options.sessionKeys ? {} : { scope: "agent" }),
    limit: options.limit ?? 25,
  });
}

export function sessionTranscriptSearchScope(
  context: Pick<
    ApplicationContext,
    "accessMode" | "gateway" | "agentSelection" | "agents" | "sessions"
  >,
): Pick<SessionTranscriptSearchOptions, "agentId" | "agentIds"> {
  const agentId =
    context.accessMode === "personal-agent"
      ? context.gateway.snapshot.assistantAgentId
      : context.agentSelection?.state.scopeId;
  if (agentId) {
    return { agentId };
  }
  if (context.accessMode === "personal-agent") {
    throw new Error("Personal agent is not available. Retry after reconnecting.");
  }
  const agents = context.agents?.state.agentsList;
  if (!agents) {
    throw new Error("Agent list is not available. Retry after reconnecting.");
  }
  return {
    agentIds: [
      ...new Set([
        ...agents.agents.filter((agent) => agent.kind !== "system").map((agent) => agent.id),
        ...(context.sessions.state.result?.sessions ?? []).flatMap((row) => {
          const owner = parseAgentSessionKey(row.key)?.agentId;
          return owner ? [owner] : [];
        }),
      ]),
    ],
  };
}

function compareHits(left: SessionTranscriptSearchHit, right: SessionTranscriptSearchHit): number {
  if (left.timestamp !== right.timestamp) {
    return right.timestamp - left.timestamp;
  }
  // Match SQLite's stable newest-first order; identities use canonical keys/ids.
  for (const field of ["sessionKey", "sessionId", "messageId"] as const) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  return 0;
}

/** Merge bounded per-agent buffers; a global page never skips each agent's prefix. */
export function createSessionTranscriptSearchPager(
  client: GatewayBrowserClient,
  options: Omit<SessionTranscriptSearchOptions, "offset">,
): { next: () => Promise<SessionsSearchResult> } {
  const ids = options.agentId ? [options.agentId] : (options.agentIds ?? [undefined]);
  const sources = [...new Set(ids)].map((agentId) => ({
    agentId,
    buffer: [] as SessionTranscriptSearchHit[],
    offset: 0,
    hasMore: true,
    totalCount: 0,
    indexing: false,
    truncated: false,
  }));
  let initialized = false;
  let emitted = 0;
  const fill = async (source: (typeof sources)[number]) => {
    if (!source.hasMore || source.buffer.length > 0) {
      return;
    }
    const result = await searchSessionTranscripts(client, {
      ...options,
      agentId: source.agentId,
      offset: source.offset,
      limit: 25,
    });
    source.buffer = [...result.results];
    source.offset += result.results.length;
    source.totalCount = result.totalCount ?? result.results.length;
    source.hasMore = result.hasMore === true;
    source.indexing = result.indexing === true;
    source.truncated = result.truncated === true;
    if (source.hasMore && result.results.length === 0) {
      throw new Error("Transcript search pagination did not advance. Retry the search.");
    }
  };
  return {
    async next() {
      if (!initialized || sources.some((source) => source.hasMore && source.buffer.length === 0)) {
        // At most four active Gateway searches, including large operator catalogs.
        for (let index = 0; index < sources.length; index += 4) {
          await Promise.all(sources.slice(index, index + 4).map(fill));
        }
        initialized = true;
      }
      const results: SessionTranscriptSearchHit[] = [];
      while (results.length < (options.limit ?? 25)) {
        const candidates = sources
          .filter((source) => source.buffer.length > 0)
          .toSorted((left, right) => compareHits(left.buffer[0]!, right.buffer[0]!));
        const source = candidates[0];
        if (!source) {
          break;
        }
        results.push(source.buffer.shift()!);
        if (results.length < (options.limit ?? 25)) {
          await fill(source);
        }
      }
      emitted += results.length;
      const totalCount = sources.reduce((sum, source) => sum + source.totalCount, 0);
      const hasMore = emitted < totalCount;
      return {
        results,
        totalCount,
        hasMore,
        indexing: sources.some((source) => source.indexing),
        truncated: hasMore || sources.some((source) => source.truncated),
      };
    },
  };
}
