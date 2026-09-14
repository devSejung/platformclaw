/** SQLite-backed ACP session metadata storage keyed through session-store entries. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../../config/config.js";
import { patchSessionEntryWithKey } from "../../config/sessions/session-accessor.js";
import {
  mergeSessionEntry,
  type SessionAcpMeta,
  type SessionEntry,
} from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  acpSessionRowMatchesEntry,
  bindAcpSessionMeta,
  getAcpSessionKysely,
  resolveReadableAcpSessionRow,
  rowToAcpSessionMeta,
  selectAcpSessionRow,
  selectAcpSessionRows,
  upsertAcpSessionMetaRow,
  type AcpSessionEntryBinding,
  type AcpSessionRow,
} from "./session-meta-db.js";
import {
  readSessionEntryFromStore,
  resolveSessionStorePathForAcp,
  resolveStoreEntryForSessionKey,
} from "./session-meta-store.js";

/** ACP metadata joined with its legacy session-store row and config context. */
export { resolveSessionStorePathForAcp } from "./session-meta-store.js";

export type AcpSessionStoreEntry = {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath: string;
  sessionKey: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  acp?: SessionAcpMeta;
  storeReadFailed?: boolean;
};

/** Delete ACP metadata only when it still belongs to the exact session lifecycle. */
export function deleteAcpSessionMetaExactLifecycle(params: {
  sessionKey: string;
  lifecycleRevision: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): boolean {
  const sessionKey = params.sessionKey.trim();
  const lifecycleRevision = params.lifecycleRevision.trim();
  if (!sessionKey || !lifecycleRevision) {
    return false;
  }
  let deleted = false;
  runOpenClawStateWriteTransaction(
    (database) => {
      const current = selectAcpSessionRow(database.db, sessionKey);
      if (current?.session_id !== lifecycleRevision) {
        return;
      }
      const result = executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .deleteFrom("acp_sessions")
          .where("session_key", "=", sessionKey)
          .where("session_id", "=", lifecycleRevision),
      );
      deleted = Number(result.numAffectedRows ?? 0) > 0;
    },
    { env: params.env, path: params.databasePath },
  );
  return deleted;
}

/** Read-only test seam for checking whether an exact lifecycle sidecar exists. */
export function hasAcpSessionMetaExactLifecycle(params: {
  sessionKey: string;
  lifecycleRevision: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): boolean {
  const sessionKey = params.sessionKey.trim();
  const lifecycleRevision = params.lifecycleRevision.trim();
  if (!sessionKey || !lifecycleRevision) {
    return false;
  }
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  return selectAcpSessionRow(database.db, sessionKey)?.session_id === lifecycleRevision;
}

export function readAcpSessionMeta(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const storeEntry = readSessionEntryFromStore({
    sessionKey,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRow(database.db, storeEntry.storeSessionKey),
    entry: storeEntry.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  if (!row) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}

export function readAcpSessionMetaForEntry(params: {
  sessionKey: string;
  entry: AcpSessionEntryBinding | undefined;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): SessionAcpMeta | undefined {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return undefined;
  }
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRow(database.db, sessionKey),
    entry: params.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  if (!row) {
    return undefined;
  }
  return rowToAcpSessionMeta(row);
}

export function readAcpSessionMetaBatch(params: {
  entries: ReadonlyArray<{
    sessionKey: string;
    entry: SessionEntry;
  }>;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): Map<SessionEntry, SessionAcpMeta | undefined> {
  const result = new Map<SessionEntry, SessionAcpMeta | undefined>();
  const entriesByKey = new Map<string, SessionEntry[]>();
  for (const item of params.entries) {
    const sessionKey = item.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    if (item.entry?.acp) {
      result.set(item.entry, item.entry.acp);
      continue;
    }
    const entries = entriesByKey.get(sessionKey) ?? [];
    entries.push(item.entry);
    entriesByKey.set(sessionKey, entries);
  }
  if (entriesByKey.size === 0) {
    return result;
  }

  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  // Chunked IN keeps each statement under SQLite's bind-variable cap, matching the
  // sharing-store membership precedent; one statement per 500 keys instead of per row.
  const db = getAcpSessionKysely(database.db);
  const requestedKeys = [...entriesByKey.keys()];
  const keyChunks: string[][] = [];
  for (let index = 0; index < requestedKeys.length; index += 500) {
    keyChunks.push(requestedKeys.slice(index, index + 500));
  }
  const rows = keyChunks.flatMap(
    (chunk) =>
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("acp_sessions").selectAll().where("session_key", "in", chunk),
      ).rows,
  );
  const rowsByKey = new Map(rows.map((row) => [row.session_key, row]));
  for (const [sessionKey, entries] of entriesByKey) {
    for (const entry of entries) {
      const row = resolveReadableAcpSessionRow({
        row: rowsByKey.get(sessionKey),
        entry,
        env: params.env,
        databasePath: params.databasePath,
      });
      result.set(entry, row ? rowToAcpSessionMeta(row) : undefined);
    }
  }
  return result;
}

export function writeAcpSessionMetaForMigration(params: {
  sessionKey: string;
  sessionId?: string;
  lifecycleRevision?: string;
  meta: SessionAcpMeta;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  const row = bindAcpSessionMeta({
    sessionKey,
    sessionId: params.sessionId,
    lifecycleRevision: params.lifecycleRevision,
    meta: params.meta,
    updatedAt: params.now?.() ?? Date.now(),
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      upsertAcpSessionMetaRow(database.db, row);
    },
    { env: params.env, path: params.databasePath },
  );
}

export function repairAcpSessionMetaKeyForMigration(params: {
  sessionKey: string;
  candidateSessionKeys?: Iterable<string | null | undefined>;
  entry?: AcpSessionEntryBinding;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
}): boolean {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }

  let repaired = false;
  runOpenClawStateWriteTransaction(
    (database) => {
      const currentRow = selectAcpSessionRow(database.db, sessionKey);
      if (currentRow && acpSessionRowMatchesEntry(currentRow, params.entry)) {
        return;
      }

      const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
      const candidateKeys = new Set<string>();
      candidateKeys.add(normalizedSessionKey);
      for (const candidate of params.candidateSessionKeys ?? []) {
        const trimmed = typeof candidate === "string" ? candidate.trim() : "";
        if (
          trimmed &&
          trimmed !== sessionKey &&
          normalizeLowercaseStringOrEmpty(trimmed) === normalizedSessionKey
        ) {
          candidateKeys.add(trimmed);
        }
      }

      let row: AcpSessionRow | undefined;
      for (const candidateKey of candidateKeys) {
        const candidateRow = selectAcpSessionRow(database.db, candidateKey);
        if (candidateRow && acpSessionRowMatchesEntry(candidateRow, params.entry)) {
          row = candidateRow;
          break;
        }
      }
      row ??= executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .selectFrom("acp_sessions")
          .selectAll()
          .where((eb) => eb.fn<string>("lower", ["session_key"]), "=", normalizedSessionKey)
          .orderBy("last_activity_at", "desc")
          .orderBy("session_key", "asc"),
      ).rows.find(
        (candidate) =>
          candidate.session_key !== sessionKey &&
          acpSessionRowMatchesEntry(candidate, params.entry),
      );
      if (!row) {
        return;
      }
      upsertAcpSessionMetaRow(database.db, {
        ...row,
        session_key: sessionKey,
        updated_at: params.now?.() ?? Date.now(),
      });
      executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .deleteFrom("acp_sessions")
          .where("session_key", "=", row.session_key),
      );
      repaired = true;
    },
    { env: params.env, path: params.databasePath },
  );
  return repaired;
}

export function readAcpSessionEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  clone?: boolean;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AcpSessionStoreEntry | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore(params);
  const database = openOpenClawStateDatabase({
    env: params.env,
    path: params.databasePath,
  });
  const row = resolveReadableAcpSessionRow({
    row: selectAcpSessionRow(database.db, storeEntry.storeSessionKey),
    entry: storeEntry.entry,
    env: params.env,
    databasePath: params.databasePath,
  });
  const acp = row ? rowToAcpSessionMeta(row) : undefined;
  return {
    cfg: storeEntry.cfg,
    agentId: storeEntry.agentId,
    storePath: storeEntry.storePath,
    sessionKey,
    storeSessionKey: storeEntry.storeSessionKey,
    entry: storeEntry.entry,
    acp,
    storeReadFailed: storeEntry.storeReadFailed,
  };
}

export async function listAcpSessionEntries(params: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
  databasePath?: string;
}): Promise<AcpSessionStoreEntry[]> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const rows = selectAcpSessionRows({
    env: params.env,
    path: params.databasePath,
  });
  const entries: AcpSessionStoreEntry[] = [];

  for (const row of rows) {
    const sessionKey = row.session_key;
    const { agentId, storePath } = resolveSessionStorePathForAcp({
      sessionKey,
      cfg,
      env: params.env,
    });
    let storeSessionKey: string;
    let entry: SessionEntry | undefined;
    try {
      ({ storeSessionKey, entry } = resolveStoreEntryForSessionKey({
        ...(agentId ? { agentId } : {}),
        storePath,
        sessionKey,
        ...(params.clone === false ? { clone: false } : {}),
      }));
    } catch {
      continue;
    }
    const readableRow = resolveReadableAcpSessionRow({
      row,
      entry,
      env: params.env,
      databasePath: params.databasePath,
    });
    if (!entry || !readableRow) {
      continue;
    }
    entries.push({
      cfg,
      agentId,
      storePath,
      sessionKey,
      storeSessionKey,
      entry,
      acp: rowToAcpSessionMeta(readableRow),
    });
  }

  return entries;
}

function mergeAcpForReturn(entry: SessionEntry | undefined, acp: SessionAcpMeta): SessionEntry {
  return mergeSessionEntry(entry, { acp });
}

function sessionStoreUpdateOptions(params: {
  sessionKey: string;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
}) {
  return {
    activeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
    ...(params.skipMaintenance === true ? { skipMaintenance: true } : {}),
    ...(params.takeCacheOwnership === true ? { takeCacheOwnership: true } : {}),
  };
}

async function clearLegacyEmbeddedAcpMetadata(params: {
  storePath: string;
  sessionKeys: Iterable<string | null | undefined>;
}): Promise<void> {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => sessionKey?.trim()).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  if (sessionKeys.size === 0) {
    return;
  }
  for (const sessionKey of sessionKeys) {
    await patchSessionEntryWithKey(
      {
        storePath: params.storePath,
        sessionKey,
      },
      (entry) => {
        if (!entry.acp) {
          return null;
        }
        const next = { ...entry };
        delete next.acp;
        return next;
      },
      {
        replaceEntry: true,
        skipMaintenance: true,
      },
    );
  }
}

export async function upsertAcpSessionMeta(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  now?: () => number;
  skipMaintenance?: boolean;
  takeCacheOwnership?: boolean;
  mutate: (
    current: SessionAcpMeta | undefined,
    entry: SessionEntry | undefined,
  ) => SessionAcpMeta | null | undefined;
}): Promise<SessionEntry | null> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const storeEntry = readSessionEntryFromStore({
    sessionKey,
    cfg: params.cfg,
    env: params.env,
    clone: false,
  });
  const { entry } = storeEntry;
  const storageSessionKey = storeEntry.storeSessionKey;
  let current: SessionAcpMeta | undefined;
  let nextMeta: SessionAcpMeta | null | undefined;
  let preparedEntry: SessionEntry | undefined;
  const updatedAt = params.now?.() ?? Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const currentRow = selectAcpSessionRow(database.db, storageSessionKey);
      current =
        currentRow && acpSessionRowMatchesEntry(currentRow, entry)
          ? rowToAcpSessionMeta(currentRow)
          : undefined;
      preparedEntry = mergeSessionEntry(entry, { updatedAt });
      nextMeta = params.mutate(
        current,
        current ? mergeAcpForReturn(preparedEntry, current) : entry,
      );
    },
    { env: params.env, path: params.databasePath },
  );
  const metaToPersist = nextMeta;
  if (metaToPersist === undefined) {
    return current ? mergeAcpForReturn(entry, current) : (entry ?? null);
  }
  if (metaToPersist === null) {
    const patched = entry
      ? await patchSessionEntryWithKey(
          {
            ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
            storePath: storeEntry.storePath,
            sessionKey: storageSessionKey,
          },
          (currentEntry) => {
            const next = { ...currentEntry };
            delete next.acp;
            return next;
          },
          {
            ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
            replaceEntry: true,
          },
        )
      : null;
    runOpenClawStateWriteTransaction(
      (database) => {
        const sessionKeysToDelete = new Set([storageSessionKey]);
        if (patched?.sessionKey) {
          sessionKeysToDelete.add(patched.sessionKey);
        }
        for (const key of sessionKeysToDelete) {
          executeSqliteQuerySync(
            database.db,
            getAcpSessionKysely(database.db)
              .deleteFrom("acp_sessions")
              .where("session_key", "=", key),
          );
        }
      },
      { env: params.env, path: params.databasePath },
    );
    await clearLegacyEmbeddedAcpMetadata({
      storePath: storeEntry.storePath,
      sessionKeys: [storageSessionKey, patched?.sessionKey],
    });
    return patched?.entry ?? null;
  }
  const persisted = await patchSessionEntryWithKey(
    {
      ...(storeEntry.agentId ? { agentId: storeEntry.agentId } : {}),
      storePath: storeEntry.storePath,
      sessionKey: storageSessionKey,
    },
    (currentEntry) => {
      const next = mergeSessionEntry(currentEntry, {
        updatedAt,
      });
      delete next.acp;
      return next;
    },
    {
      ...sessionStoreUpdateOptions({ ...params, sessionKey: storageSessionKey }),
      fallbackEntry: preparedEntry,
      replaceEntry: true,
    },
  );
  if (!persisted) {
    return null;
  }
  await clearLegacyEmbeddedAcpMetadata({
    storePath: storeEntry.storePath,
    sessionKeys: [storageSessionKey, persisted.sessionKey],
  });
  runOpenClawStateWriteTransaction(
    (database) => {
      upsertAcpSessionMetaRow(
        database.db,
        bindAcpSessionMeta({
          sessionKey: persisted.sessionKey,
          sessionId: persisted.entry.sessionId,
          lifecycleRevision: persisted.entry.lifecycleRevision,
          meta: metaToPersist,
          updatedAt,
        }),
      );
      if (persisted.sessionKey !== storageSessionKey) {
        executeSqliteQuerySync(
          database.db,
          getAcpSessionKysely(database.db)
            .deleteFrom("acp_sessions")
            .where("session_key", "=", storageSessionKey),
        );
      }
    },
    { env: params.env, path: params.databasePath },
  );
  return mergeAcpForReturn(persisted.entry, metaToPersist);
}
