import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Insertable, Selectable } from "kysely";
import {
  type AcpSessionRuntimeOptions,
  type SessionAcpIdentity,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;
export type AcpSessionRow = Selectable<AcpSessionsTable>;
export type AcpSessionEntryBinding = Pick<SessionEntry, "lifecycleRevision"> &
  Partial<Pick<SessionEntry, "sessionId" | "sessionStartedAt">>;

export function getAcpSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

export function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  const identity = asOptionalRecord(safeParseJson(row.identity_json ?? "")) as
    | SessionAcpIdentity
    | undefined;
  const runtimeOptions = asOptionalRecord(safeParseJson(row.runtime_options_json ?? "")) as
    | AcpSessionRuntimeOptions
    | undefined;
  return {
    backend: row.backend,
    agent: row.agent,
    ...(row.execution_owner_agent_id != null
      ? { executionOwnerAgentId: row.execution_owner_agent_id }
      : {}),
    runtimeSessionName: row.runtime_session_name,
    ...(identity ? { identity } : {}),
    mode: row.mode === "oneshot" ? "oneshot" : "persistent",
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(row.cwd != null ? { cwd: row.cwd } : {}),
    state: row.state === "running" || row.state === "error" ? row.state : "idle",
    lastActivityAt: row.last_activity_at,
    ...(row.last_error != null ? { lastError: row.last_error } : {}),
  };
}

export function bindAcpSessionMeta(params: {
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  meta: SessionAcpMeta;
  updatedAt: number;
}): Insertable<AcpSessionsTable> {
  return {
    session_key: params.sessionKey,
    // Kept in the existing column for schema neutrality. New rows prefer the
    // lifecycle revision; pre-revision entries retain the session-id fence.
    session_id: params.lifecycleRevision ?? params.sessionId ?? null,
    backend: params.meta.backend,
    agent: params.meta.agent,
    execution_owner_agent_id: params.meta.executionOwnerAgentId ?? null,
    runtime_session_name: params.meta.runtimeSessionName,
    identity_json: params.meta.identity ? JSON.stringify(params.meta.identity) : null,
    mode: params.meta.mode,
    runtime_options_json: params.meta.runtimeOptions
      ? JSON.stringify(params.meta.runtimeOptions)
      : null,
    cwd: params.meta.cwd ?? null,
    state: params.meta.state,
    last_activity_at: params.meta.lastActivityAt,
    last_error: params.meta.lastError ?? null,
    updated_at: params.updatedAt,
  };
}

export function selectAcpSessionRow(
  db: DatabaseSync,
  sessionKey: string,
): AcpSessionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .selectAll()
      .where("session_key", "=", sessionKey),
  );
}

export function acpSessionRowMatchesEntry(
  row: AcpSessionRow,
  entry: AcpSessionEntryBinding | undefined,
): boolean {
  return (
    row.session_id == null ||
    row.session_id === entry?.lifecycleRevision ||
    // Pre-boundary rows stored sessionId here; the next read rebinds them to the revision.
    (row.session_id === entry?.sessionId &&
      (entry?.sessionStartedAt === undefined || row.updated_at >= entry.sessionStartedAt))
  );
}

export function resolveReadableAcpSessionRow(params: {
  row: AcpSessionRow | undefined;
  entry: AcpSessionEntryBinding | undefined;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AcpSessionRow | undefined {
  const { row, entry } = params;
  if (!row || !acpSessionRowMatchesEntry(row, entry)) {
    return undefined;
  }
  const legacySessionId = entry?.sessionId;
  const lifecycleRevision = entry?.lifecycleRevision;
  if (
    !legacySessionId ||
    !lifecycleRevision ||
    row.session_id !== legacySessionId ||
    row.session_id === lifecycleRevision
  ) {
    return row;
  }
  return runOpenClawStateWriteTransaction(
    (database) => {
      const current = selectAcpSessionRow(database.db, row.session_key);
      if (!current || current.session_id === lifecycleRevision || current.session_id == null) {
        return current;
      }
      if (current.session_id !== legacySessionId) {
        return undefined;
      }
      executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .updateTable("acp_sessions")
          .set({ session_id: lifecycleRevision })
          .where("session_key", "=", row.session_key)
          .where("session_id", "=", legacySessionId),
      );
      return { ...current, session_id: lifecycleRevision };
    },
    { env: params.env, path: params.databasePath },
  );
}

export function selectAcpSessionRows(options: OpenClawStateDatabaseOptions = {}): AcpSessionRow[] {
  const database = openOpenClawStateDatabase(options);
  return executeSqliteQuerySync(
    database.db,
    getAcpSessionKysely(database.db)
      .selectFrom("acp_sessions")
      .selectAll()
      .orderBy("last_activity_at", "desc")
      .orderBy("session_key", "asc"),
  ).rows;
}

export function upsertAcpSessionMetaRow(db: DatabaseSync, row: Insertable<AcpSessionsTable>): void {
  executeSqliteQuerySync(
    db,
    getAcpSessionKysely(db)
      .insertInto("acp_sessions")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("session_key").doUpdateSet({
          session_id: (eb) => eb.ref("excluded.session_id"),
          backend: (eb) => eb.ref("excluded.backend"),
          agent: (eb) => eb.ref("excluded.agent"),
          execution_owner_agent_id: (eb) => eb.ref("excluded.execution_owner_agent_id"),
          runtime_session_name: (eb) => eb.ref("excluded.runtime_session_name"),
          identity_json: (eb) => eb.ref("excluded.identity_json"),
          mode: (eb) => eb.ref("excluded.mode"),
          runtime_options_json: (eb) => eb.ref("excluded.runtime_options_json"),
          cwd: (eb) => eb.ref("excluded.cwd"),
          state: (eb) => eb.ref("excluded.state"),
          last_activity_at: (eb) => eb.ref("excluded.last_activity_at"),
          last_error: (eb) => eb.ref("excluded.last_error"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
        }),
      ),
  );
}
