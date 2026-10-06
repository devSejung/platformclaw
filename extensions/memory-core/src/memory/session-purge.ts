import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  resolveStateDir,
  resolveAgentWorkspaceDir,
  resolveUserPath,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  isSessionArchiveArtifactName,
  sessionPathForFile,
  sessionPathForSessionIdentity,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  loadSqliteVecExtension,
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_CHUNKS_TABLE,
  MEMORY_INDEX_FTS_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  resolveOpenClawAgentSqlitePath,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { assertNoQmdSessionArtifactsForPurge } from "../qmd-session-artifacts.js";
import { acquireMemoryReindexLock } from "./manager-reindex-lock.js";
import { resolveQmdStoreWriteLeaseOptions } from "./qmd-manager-helpers.js";

export type SessionMemoryPurgeParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionIds: readonly string[];
  archiveDirectory: string;
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function ownsSessionMemoryPath(params: SessionMemoryPurgeParams, memoryPath: string): boolean {
  return params.sessionIds.some((sessionId) => {
    if (memoryPath === sessionPathForSessionIdentity(params.agentId, sessionId)) {
      return true;
    }
    const archiveBase = sessionPathForFile(
      path.join(params.archiveDirectory, `${sessionId}.jsonl`),
    );
    return (
      path.posix.dirname(memoryPath) === path.posix.dirname(archiveBase) &&
      memoryPath.startsWith(`${archiveBase}.`) &&
      isSessionArchiveArtifactName(path.posix.basename(memoryPath), sessionId)
    );
  });
}

/** Called only while the owning managers are drained and acquisition remains fenced. */
export async function purgeSessionMemoryBeforeRun<T>(
  params: SessionMemoryPurgeParams,
  run: () => Promise<T>,
  withLease?: PluginStateLeaseRunner,
): Promise<T> {
  if (params.sessionIds.length === 0) {
    return await run();
  }
  const qmdDir = path.join(resolveStateDir(), "agents", params.agentId, "qmd");
  const qmdIndexPath = path.join(qmdDir, "xdg-cache", "qmd", "index.sqlite");
  const exportDirs = new Set([path.join(qmdDir, "sessions")]);
  const configuredExportDir = params.cfg.memory?.qmd?.sessions?.exportDir?.trim();
  if (configuredExportDir) {
    exportDirs.add(
      configuredExportDir.startsWith("~") || path.isAbsolute(configuredExportDir)
        ? resolveUserPath(configuredExportDir)
        : path.resolve(resolveAgentWorkspaceDir(params.cfg, params.agentId), configuredExportDir),
    );
  }
  const inspectAndPurge = async (assertOwned: () => void) => {
    assertOwned();
    if (await exists(qmdIndexPath)) {
      assertNoQmdSessionArtifactsForPurge({ ...params, indexPath: qmdIndexPath });
    }
    for (const exportDir of exportDirs) {
      if (!(await exists(exportDir))) {
        continue;
      }
      const names = await fs.readdir(exportDir);
      if (
        names.some((name) =>
          params.sessionIds.some(
            (id) =>
              name === `${id}.md` ||
              (name.startsWith(`${id}.jsonl.`) &&
                name.endsWith(".md") &&
                isSessionArchiveArtifactName(name.slice(0, -3), id)),
          ),
        )
      ) {
        throw Object.assign(
          new Error("Session purge requires QMD-owned export cleanup before retrying."),
          { reason: "session-purge-unsupported", backend: "qmd" },
        );
      }
    }
    assertOwned();
    return await purgeBuiltinSessionMemoryBeforeRun(params, async () => {
      assertOwned();
      return await run();
    });
  };
  if (!withLease) {
    const hasQmdState =
      (await exists(qmdDir)) || (await Promise.all([...exportDirs].map(exists))).some(Boolean);
    if (!hasQmdState && params.cfg.memory?.backend !== "qmd") {
      return await inspectAndPurge(() => {});
    }
    throw Object.assign(
      new Error(
        "Session purge cannot fence QMD writers because the memory host does not provide lease coordination. Native session data was retained.",
      ),
      { reason: "session-purge-unsupported", backend: "qmd" },
    );
  }
  // Always lease when supported: another process may be creating its first QMD
  // index. Purge uses the existing minimum, with no external command timeout.
  return await withLease(
    {
      namespace: "qmd",
      key: "write",
      database: { scope: "agent", agentId: params.agentId },
      ...resolveQmdStoreWriteLeaseOptions(),
    },
    async (lease) =>
      await inspectAndPurge(() => {
        lease.signal.throwIfAborted();
        lease.assertOwned();
      }),
  );
}

async function purgeBuiltinSessionMemoryBeforeRun<T>(
  params: SessionMemoryPurgeParams,
  run: () => Promise<T>,
): Promise<T> {
  const dbPath = resolveOpenClawAgentSqlitePath({ agentId: params.agentId });
  // Every sync uses this lock before reading its corpus and cannot republish
  // a pre-purge snapshot, including a writer creating the first index.
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const reindexLock = acquireMemoryReindexLock(dbPath);
  try {
    if (await exists(dbPath)) {
      const db = openNodeSqliteDatabase(dbPath, { allowExtension: true });
      try {
        await purgeSessionMemoryRows(db, params);
      } finally {
        db.close();
      }
    }
    return await run();
  } finally {
    reindexLock.release();
  }
}

type MemoryPathRow = { path: string; source: string };
type SessionPurgeDatabase = {
  sqlite_master: { name: string; type: string };
  memory_index_sources: MemoryPathRow;
  memory_index_chunks: MemoryPathRow & { id: string; hash: string; model: string };
  memory_index_chunks_fts: MemoryPathRow;
  memory_index_paths_fts: MemoryPathRow;
  memory_index_chunks_vec: { id: string };
  memory_index_chunk_provenance: { chunk_id: string };
  memory_index_chunk_recall_metadata: { chunk_id: string };
  memory_embedding_cache: { hash: string; model: string };
};

async function purgeSessionMemoryRows(
  db: DatabaseSync,
  params: SessionMemoryPurgeParams,
): Promise<void> {
  const query = getNodeSqliteKysely<SessionPurgeDatabase>(db);
  const tables = new Set(
    executeSqliteQuerySync(
      db,
      query.selectFrom("sqlite_master").select("name").where("type", "=", "table"),
    ).rows.map((row) => row.name),
  );
  const pathTables = (
    [
      MEMORY_INDEX_SOURCES_TABLE,
      MEMORY_INDEX_CHUNKS_TABLE,
      MEMORY_INDEX_FTS_TABLE,
      MEMORY_INDEX_PATHS_FTS_TABLE,
    ] as const
  ).filter((table) => tables.has(table));
  const readOwnedPaths = () => {
    const paths = new Set<string>();
    for (const table of pathTables) {
      const rows = executeSqliteQuerySync(
        db,
        query.selectFrom(table).select("path").distinct().where("source", "=", "sessions"),
      ).rows;
      for (const row of rows) {
        if (ownsSessionMemoryPath(params, row.path)) {
          paths.add(row.path);
        }
      }
    }
    return paths;
  };
  if (readOwnedPaths().size === 0) {
    return;
  }
  const hasChunks = tables.has(MEMORY_INDEX_CHUNKS_TABLE);
  if (tables.has(MEMORY_INDEX_VECTOR_TABLE)) {
    const extensionPath =
      resolveAgentConfig(params.cfg, params.agentId)?.memory?.search?.store?.vector
        ?.extensionPath ?? params.cfg.memory?.search?.store?.vector?.extensionPath;
    const loaded = await loadSqliteVecExtension({ db, extensionPath });
    if (!loaded.ok) {
      throw new Error(
        `Session purge cannot remove memory vectors: ${loaded.error ?? "sqlite-vec unavailable"}`,
      );
    }
  }
  runSqliteImmediateTransactionSync(
    db,
    () => {
      for (const memoryPath of readOwnedPaths()) {
        if (hasChunks) {
          const chunks = query
            .selectFrom(MEMORY_INDEX_CHUNKS_TABLE)
            .select("id")
            .where("path", "=", memoryPath)
            .where("source", "=", "sessions");
          if (tables.has(MEMORY_EMBEDDING_CACHE_TABLE)) {
            // Content-addressed cache entries can be shared by unrelated memory.
            // Remove only hashes/models whose last indexed owner is being deleted.
            executeSqliteQuerySync(
              db,
              query
                .deleteFrom(MEMORY_EMBEDDING_CACHE_TABLE)
                .where((eb) =>
                  eb.exists(
                    eb
                      .selectFrom("memory_index_chunks as c")
                      .select("c.id")
                      .where("c.path", "=", memoryPath)
                      .where("c.source", "=", "sessions")
                      .whereRef("c.hash", "=", "memory_embedding_cache.hash")
                      .whereRef("c.model", "=", "memory_embedding_cache.model"),
                  ),
                )
                .where((eb) =>
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom("memory_index_chunks as c")
                        .select("c.id")
                        .whereRef("c.hash", "=", "memory_embedding_cache.hash")
                        .whereRef("c.model", "=", "memory_embedding_cache.model")
                        .where((other) =>
                          other.or([
                            other("c.path", "!=", memoryPath),
                            other("c.source", "!=", "sessions"),
                          ]),
                        ),
                    ),
                  ),
                ),
            );
          }
          if (tables.has(MEMORY_INDEX_VECTOR_TABLE)) {
            executeSqliteQuerySync(
              db,
              query.deleteFrom(MEMORY_INDEX_VECTOR_TABLE).where("id", "in", chunks),
            );
          }
          for (const table of [
            MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
            MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
          ] as const) {
            if (tables.has(table)) {
              executeSqliteQuerySync(db, query.deleteFrom(table).where("chunk_id", "in", chunks));
            }
          }
        }
        for (const table of pathTables) {
          executeSqliteQuerySync(
            db,
            query.deleteFrom(table).where("path", "=", memoryPath).where("source", "=", "sessions"),
          );
        }
      }
    },
    { operationLabel: "memory.session-purge" },
  );
}
