import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { escapeRegExp } from "../../shared/regexp.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { sliceUtf16Safe, truncateUtf16Safe } from "../../utils.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;

type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "assistant" | "user";
  timestamp: number;
  snippet: string;
  score: number;
};

type SessionTranscriptSearchResult = {
  hits: SessionTranscriptSearchHit[];
  indexing: boolean;
  truncated: boolean;
};

export type SessionTranscriptSubstringParams = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  offset?: number;
  query: string;
  sessionId?: string;
  sessionKeys?: string[];
  storePath?: string;
};

export type SessionTranscriptSubstringResult = SessionTranscriptSearchResult & {
  totalCount: number;
  hasMore: boolean;
};

/** Worker-only literal query. The Gateway owns scheduling any reported reconcile. */
export function querySessionTranscriptSubstrings(
  params: SessionTranscriptSubstringParams,
  db: DatabaseSync,
): SessionTranscriptSubstringResult {
  const kysely = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(db);
  const query = params.query.trim();
  if (!query || query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error("query must contain between 1 and 4096 characters");
  }
  const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
  const offset = Math.max(0, params.offset ?? 0);
  const matcher = new RegExp(escapeRegExp(query), "iu");
  // SQLite lower() only folds ASCII. Reuse the UI's literal Unicode matcher for
  // predicates, counts and snippet offsets without changing persisted text.
  db.function("session_transcript_literal_offset", { deterministic: true }, (text) =>
    typeof text === "string" ? (matcher.exec(text)?.index ?? -1) + 1 : 0,
  );
  // Reuse the active-branch projection, excluding dirty rows exactly as FTS does.
  let matched = kysely
    .selectFrom("session_transcript_fts as fts")
    .innerJoin("session_windows as windows", "windows.session_id", "fts.session_id")
    .where((eb) => eb(eb.fn<number>("session_transcript_literal_offset", ["fts.text"]), ">", 0))
    .where(
      "fts.session_id",
      "not in",
      kysely
        .selectFrom("session_transcript_index_state")
        .select("session_id")
        .where("needs_rebuild", "!=", 0),
    );
  if (params.sessionKeys) {
    matched = matched.where("windows.session_key", "in", params.sessionKeys);
  }
  if (params.sessionId) {
    matched = matched.where("fts.session_id", "=", params.sessionId);
  }
  const count = executeSqliteQueryTakeFirstSync(
    db,
    matched.select((eb) => eb.fn.countAll<number>().as("count")),
  );
  const totalCount = count?.count ?? 0;
  const rows = executeSqliteQuerySync(
    db,
    matched
      .select([
        "windows.session_key",
        "fts.session_id",
        "fts.message_id",
        "fts.role",
        "fts.timestamp",
        "fts.text",
      ])
      .select((eb) =>
        eb.fn<number>("session_transcript_literal_offset", ["fts.text"]).as("match_offset"),
      )
      .orderBy("fts.timestamp", "desc")
      .orderBy("windows.session_key")
      .orderBy("fts.session_id")
      .orderBy("fts.message_id")
      .limit(limit)
      .offset(offset),
  ).rows;
  const hits = rows.flatMap((row): SessionTranscriptSearchHit[] => {
    if (
      (row.role !== "user" && row.role !== "assistant") ||
      typeof row.text !== "string" ||
      typeof row.session_id !== "string" ||
      typeof row.message_id !== "string"
    ) {
      return [];
    }
    const text = row.text;
    const matchAt = row.match_offset - 1;
    const start = Math.max(0, matchAt - 120);
    const end = Math.min(text.length, start + SEARCH_SNIPPET_MAX_CHARS);
    const excerpt = sliceUtf16Safe(text, start, end);
    return [
      {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        timestamp: Number(row.timestamp) || 0,
        snippet: `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`,
        score: 0,
      },
    ];
  });
  const indexing = listSessionsNeedingTranscriptIndexReconcile(db).length > 0;
  const hasMore = offset + hits.length < totalCount;
  return { hits, totalCount, hasMore, indexing, truncated: hasMore };
}

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

/** Search the per-agent FTS index; kicks off one background reconcile when the index lags. */
export function searchSessionTranscripts(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  sessionKeys?: string[];
  storePath?: string;
}): SessionTranscriptSearchResult {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  const databasePath = params.storePath
    ? resolveSqliteTargetFromSessionStorePath(params.storePath, {
        agentId: params.agentId,
      }).path
    : undefined;
  const databaseOptions = {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
    ...(databasePath ? { path: databasePath } : {}),
  };
  const database = openOpenClawAgentDatabase(databaseOptions);
  const dirtySessions = listSessionsNeedingTranscriptIndexReconcile(database.db);
  if (dirtySessions.length > 0) {
    startSessionTranscriptIndexReconcile(databaseOptions);
  }
  const indexing =
    dirtySessions.length > 0 || isSessionTranscriptIndexReconcileRunning(databaseOptions);
  const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
  const sessionKeys = params.sessionKeys ?? [];
  const whereSession =
    sessionKeys.length > 0
      ? ` AND session_windows.session_key IN (${sessionKeys.map(() => "?").join(", ")})`
      : "";
  // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
  // representation. session_key lives on the window row so key renames
  // never leave stale keys inside the index. Sessions flagged needs_rebuild
  // are excluded: their rows may still hold rewound-away branch text that
  // sessions_history no longer exposes, so they stay hidden until reconcile
  // rebuilds them (indexing=true tells the caller to retry).
  const statement = database.db.prepare(/* sqlite-allow-raw: FTS5 MATCH/snippet/bm25 */ `
    SELECT session_windows.session_key AS session_key, session_transcript_fts.session_id AS session_id,
      message_id, role, timestamp,
      snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
      bm25(session_transcript_fts) AS rank
    FROM session_transcript_fts
    JOIN session_windows ON session_windows.session_id = session_transcript_fts.session_id
    WHERE session_transcript_fts MATCH ?${whereSession}
      AND session_transcript_fts.session_id NOT IN (
        SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
      )
    ORDER BY rank ASC, timestamp DESC, message_id ASC
    LIMIT ?
  `);
  const values = [toFtsQuery(query), ...sessionKeys, limit + 1];
  const rows = statement.all(...values) as Array<{
    message_id: unknown;
    rank: unknown;
    role: unknown;
    session_id: unknown;
    session_key: unknown;
    snippet: unknown;
    timestamp: unknown;
  }>;
  const hits = rows.flatMap((row): SessionTranscriptSearchHit[] => {
    if (
      typeof row.session_key !== "string" ||
      typeof row.session_id !== "string" ||
      typeof row.message_id !== "string" ||
      (row.role !== "user" && row.role !== "assistant") ||
      typeof row.snippet !== "string"
    ) {
      return [];
    }
    const timestamp = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
    const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
    return [
      {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        snippet:
          row.snippet.length > SEARCH_SNIPPET_MAX_CHARS
            ? `${truncateUtf16Safe(row.snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
            : row.snippet,
        score: Number.isFinite(rank) ? -rank : 0,
      },
    ];
  });
  return { hits: hits.slice(0, limit), indexing, truncated: hits.length > limit };
}
