import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceQmdSessionArtifactMappings } from "../qmd-session-artifacts.js";
import { createMemoryRuntime } from "../runtime-provider.js";
import { acquireMemoryReindexLock } from "./manager-reindex-lock.js";
import { MemoryIndexManager } from "./manager.js";
import { purgeSessionMemoryBeforeRun, type SessionMemoryPurgeParams } from "./session-purge.js";
import "./test-runtime-mocks.js";

const immediateLease: PluginStateLeaseRunner = async (_options, run) =>
  await run({ signal: new AbortController().signal, assertOwned() {} });
const runtime = createMemoryRuntime({ withLease: immediateLease });

describe("session memory purge", () => {
  let fixtureRoot: string;
  let stateDir: string;
  let dbPath: string;
  let params: SessionMemoryPurgeParams;

  beforeEach(async () => {
    fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memory-purge-")));
    stateDir = path.join(fixtureRoot, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    params = {
      cfg: { memory: { search: { enabled: false } } },
      agentId: "main",
      sessionKey: "agent:main:deleted",
      sessionIds: ["deleted", "old"],
      archiveDirectory: path.join(stateDir, "agents", "main", "sessions"),
    };
  });

  afterEach(async () => {
    await runtime.closeAllMemorySearchManagers?.();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function openFixture(): Promise<DatabaseSync> {
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
    return db;
  }

  function seedSource(
    db: DatabaseSync,
    id: string,
    sourcePath: string,
    hash = id,
    source = "sessions",
  ) {
    db.prepare(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES (?, ?, ?, 1, 1)`).run(sourcePath, source, hash);
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, ?, 1, 1, ?, 'fts-only', ?, '[]', 1)`).run(id, sourcePath, source, hash, id);
    db.prepare(`INSERT INTO memory_index_chunks_fts
      (text, id, path, source, model, start_line, end_line)
      VALUES (?, ?, ?, ?, 'fts-only', 1, 1)`).run(id, id, sourcePath, source);
    db.prepare(`INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'owner', 'interactive', 1)`).run(
      id,
    );
    db.prepare(`INSERT INTO memory_index_chunk_recall_metadata (chunk_id, importance, triggers)
      VALUES (?, 1, '[]')`).run(id);
    db.prepare(`INSERT OR IGNORE INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('none', 'fts-only', 'test', ?, '[]', 0, 1)`).run(hash);
  }

  it("does not create an index or initialize providers when no persisted state exists", async () => {
    const run = vi.fn(async () => "deleted");
    await expect(runtime.withSessionPurge!(params, run)).resolves.toBe("deleted");
    expect(run).toHaveBeenCalledOnce();
    await expect(fs.access(dbPath)).rejects.toThrow("ENOENT");
  });

  it("fences the first index writer before it can read a transcript being purged", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: fixtureRoot }, list: [{ id: "main", default: true }] },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          rememberAcrossConversations: false,
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
    };
    const nativeEntered = Promise.withResolvers<void>();
    const releaseNative = Promise.withResolvers<void>();
    let nativeDeleted = false;
    const purge = purgeSessionMemoryBeforeRun(params, async () => {
      nativeEntered.resolve();
      await releaseNative.promise;
      nativeDeleted = true;
    });
    await nativeEntered.promise;
    let manager: MemoryIndexManager | null = null;
    try {
      await expect(fs.access(dbPath)).rejects.toThrow("ENOENT");
      manager = await MemoryIndexManager.get({ cfg, agentId: "main", purpose: "cli" });
      expect(manager).not.toBeNull();
      const writer = vi
        .spyOn(
          manager! as unknown as {
            syncMemoryFiles(): Promise<{ indexItems: never[]; finalize(): void }>;
          },
          "syncMemoryFiles",
        )
        .mockImplementation(async () => {
          expect(nativeDeleted).toBe(true);
          return { indexItems: [], finalize() {} };
        });
      await expect(manager!.sync({ force: true })).rejects.toThrow("another reindex is active");
      expect(writer).not.toHaveBeenCalled();
      releaseNative.resolve();
      await purge;
      await expect(manager!.sync({ force: true })).resolves.toBeUndefined();
      expect(writer).toHaveBeenCalled();
    } finally {
      releaseNative.resolve();
      await purge;
      await manager?.close();
    }
  });

  it("removes exact live/archive generation sources and derived rows even with search disabled", async () => {
    const db = await openFixture();
    try {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      db.exec(
        "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
      );
      seedSource(db, "erased", "sessions/main/deleted.jsonl");
      seedSource(db, "shared-erased", "sessions/main/old.jsonl", "shared");
      seedSource(db, "archive-erased", "sessions/main/old.jsonl.reset.2026-10-06T00-00-00.000Z");
      seedSource(db, "retained", "sessions/main/retained.jsonl", "shared");
      seedSource(db, "other-agent", "sessions/other/deleted.jsonl");
      seedSource(db, "similar-id", "sessions/main/deleted-extra.jsonl");
      seedSource(
        db,
        "unowned-archive",
        "sessions/main/deleted.jsonl.notes.deleted.2026-10-06T00-00-00.000Z",
      );
      seedSource(db, "curated", "sessions/main/deleted.jsonl", "curated", "memory");
      db.exec(
        "INSERT INTO memory_index_chunks_vec VALUES ('erased', '[1,0]'), ('retained', '[0,1]')",
      );
      db.exec(
        "CREATE TABLE native_history (value TEXT); INSERT INTO native_history VALUES ('native')",
      );
      expect(
        db
          .prepare(
            "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'erased'",
          )
          .all(),
      ).not.toEqual([]);
      await runtime.withSessionPurge!(params, async () => {
        expect(
          db
            .prepare(
              "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'erased'",
            )
            .all(),
        ).toEqual([]);
        expect(db.prepare("SELECT * FROM native_history").all()).toEqual([{ value: "native" }]);
        expect(() => acquireMemoryReindexLock(dbPath)).toThrow("another reindex is active");
      });
      const retained = ["curated", "other-agent", "retained", "similar-id", "unowned-archive"];
      expect(db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all()).toEqual(
        retained.map((id) => ({ id })),
      );
      expect(db.prepare("SELECT id FROM memory_index_chunks_fts ORDER BY id").all()).toEqual(
        retained.map((id) => ({ id })),
      );
      for (const table of ["memory_index_chunk_provenance", "memory_index_chunk_recall_metadata"]) {
        expect(db.prepare(`SELECT chunk_id FROM ${table} ORDER BY chunk_id`).all()).toEqual(
          retained.map((chunk_id) => ({ chunk_id })),
        );
      }
      expect(db.prepare("SELECT id FROM memory_index_chunks_vec").all()).toEqual([
        { id: "retained" },
      ]);
      expect(db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
        ["curated", "other-agent", "shared", "similar-id", "unowned-archive"].map((hash) => ({
          hash,
        })),
      );
      expect(
        db.prepare("SELECT path, source FROM memory_index_sources ORDER BY path, source").all(),
      ).toEqual(
        db.prepare("SELECT path, source FROM memory_index_paths_fts ORDER BY path, source").all(),
      );
    } finally {
      db.close();
    }
  });

  it("rolls back a failed purge and never removes native mappings before a successful retry", async () => {
    const db = await openFixture();
    try {
      seedSource(db, "erased", "sessions/main/deleted.jsonl");
      db.exec(`CREATE TRIGGER prevent_purge BEFORE DELETE ON memory_index_chunks
        BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END`);
      const run = vi.fn(async () => "deleted");
      await expect(runtime.withSessionPurge!(params, run)).rejects.toThrow(
        "injected purge failure",
      );
      expect(run).not.toHaveBeenCalled();
      expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([{ id: "erased" }]);
      expect(db.prepare("SELECT id FROM memory_index_chunks_fts").all()).toEqual([
        { id: "erased" },
      ]);
      expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([
        { hash: "erased" },
      ]);
      db.exec("DROP TRIGGER prevent_purge");
      await expect(runtime.withSessionPurge!(params, run)).resolves.toBe("deleted");
      expect(run).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it.each(["target", "unrelated", "empty", "unmapped"] as const)(
    "checks QMD artifact ownership before purging (%s)",
    async (kind) => {
      const qmdDir = path.join(stateDir, "agents", "main", "qmd");
      const indexPath = path.join(qmdDir, "xdg-cache", "qmd", "index.sqlite");
      await fs.mkdir(qmdDir, { recursive: true });
      if (kind !== "empty") {
        replaceQmdSessionArtifactMappings({
          indexPath,
          collection: "sessions-main",
          mappings: [
            {
              collection: "sessions-main",
              artifactPath: "retained.md",
              searchPath: "qmd/sessions-main/retained.md",
              agentId: "main",
              sessionId: kind === "target" ? "deleted" : "retained",
              memoryKey: "session:main:retained",
              archived: false,
            },
          ],
        });
      }
      if (kind === "unmapped") {
        const qmdDb = new DatabaseSync(indexPath);
        try {
          qmdDb.exec(
            "CREATE TABLE documents (collection TEXT, path TEXT); INSERT INTO documents VALUES ('sessions-main', 'unmapped.md')",
          );
        } finally {
          qmdDb.close();
        }
      }
      const run = vi.fn(async () => "deleted");
      const result = runtime.withSessionPurge!(params, run);
      if (kind === "target" || kind === "unmapped") {
        await expect(result).rejects.toMatchObject({
          reason: "session-purge-unsupported",
          backend: "qmd",
        });
        expect(run).not.toHaveBeenCalled();
      } else {
        await expect(result).resolves.toBe("deleted");
        expect(run).toHaveBeenCalledOnce();
      }
    },
  );

  it("waits for a QMD writer before inspecting mappings and holds its lease through native deletion", async () => {
    const qmdDir = path.join(stateDir, "agents", "main", "qmd");
    const indexPath = path.join(qmdDir, "xdg-cache", "qmd", "index.sqlite");
    await fs.mkdir(qmdDir, { recursive: true });
    const writerRelease = Promise.withResolvers<void>();
    const leaseRequested = Promise.withResolvers<void>();
    let held = false;
    const withLease: PluginStateLeaseRunner = async (options, run) => {
      expect(options).toMatchObject({
        namespace: "qmd",
        key: "write",
        database: { scope: "agent", agentId: "main" },
      });
      leaseRequested.resolve();
      await writerRelease.promise;
      held = true;
      try {
        return await run({
          signal: new AbortController().signal,
          assertOwned() {
            expect(held).toBe(true);
          },
        });
      } finally {
        held = false;
      }
    };
    const leasedRuntime = createMemoryRuntime({ withLease });
    const run = vi.fn(async () => "deleted");
    const purge = leasedRuntime.withSessionPurge!(params, run);
    await leaseRequested.promise;
    expect(run).not.toHaveBeenCalled();
    replaceQmdSessionArtifactMappings({
      indexPath,
      collection: "sessions-main",
      mappings: [
        {
          collection: "sessions-main",
          artifactPath: "deleted.md",
          searchPath: "qmd/sessions-main/deleted.md",
          agentId: "main",
          sessionId: "deleted",
          memoryKey: "session:main:deleted",
          archived: false,
        },
      ],
    });
    writerRelease.resolve();
    await expect(purge).rejects.toMatchObject({
      reason: "session-purge-unsupported",
      backend: "qmd",
    });
    expect(run).not.toHaveBeenCalled();
    expect(held).toBe(false);
    replaceQmdSessionArtifactMappings({ indexPath, collection: "sessions-main", mappings: [] });
    await expect(
      leasedRuntime.withSessionPurge!(params, async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(held).toBe(true);
        return "deleted";
      }),
    ).resolves.toBe("deleted");
    expect(held).toBe(false);
    await expect(createMemoryRuntime().withSessionPurge!(params, run)).rejects.toMatchObject({
      reason: "session-purge-unsupported",
      backend: "qmd",
    });
  });

  it("serializes independent incremental writers with purge before reading their corpus", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: fixtureRoot }, list: [{ id: "main", default: true }] },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          rememberAcrossConversations: false,
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
    };
    await fs.writeFile(path.join(fixtureRoot, "MEMORY.md"), "retained memory");
    const manager = await MemoryIndexManager.get({ cfg, agentId: "main", purpose: "cli" });
    await manager!.sync({ force: true });
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const harness = manager! as unknown as {
      dirty: boolean;
      syncMemoryFiles(): Promise<{ indexItems: never[]; finalize(): void }>;
    };
    harness.dirty = true;
    const writer = vi.spyOn(harness, "syncMemoryFiles").mockImplementation(async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
      return { indexItems: [], finalize() {} };
    });
    const pendingSync = manager!.sync();
    await writerEntered.promise;
    const run = vi.fn(async () => "deleted");
    await expect(purgeSessionMemoryBeforeRun(params, run)).rejects.toThrow(
      "another reindex is active",
    );
    expect(run).not.toHaveBeenCalled();
    releaseWriter.resolve();
    await pendingSync;
    writer.mockRestore();
    const nativeEntered = Promise.withResolvers<void>();
    const releaseNative = Promise.withResolvers<void>();
    const purge = purgeSessionMemoryBeforeRun(params, async () => {
      nativeEntered.resolve();
      await releaseNative.promise;
    });
    await nativeEntered.promise;
    await expect(manager!.sync()).rejects.toThrow("another reindex is active");
    releaseNative.resolve();
    await purge;
    await expect(manager!.sync({ force: true })).resolves.toBeUndefined();
    await manager!.close();
  });

  it("drains an admitted transient writer and fences all manager purposes through native deletion", async () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: fixtureRoot }, list: [{ id: "main", default: true }] },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          rememberAcrossConversations: false,
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
    };
    const manager = await MemoryIndexManager.get({ cfg, agentId: "main", purpose: "cli" });
    expect(manager).not.toBeNull();
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const nativeEntered = Promise.withResolvers<void>();
    const releaseNative = Promise.withResolvers<void>();
    const db = Reflect.get(manager!, "db") as DatabaseSync;
    const writer = vi
      .spyOn(manager! as unknown as { runSync(): Promise<void> }, "runSync")
      .mockImplementation(async () => {
        writerEntered.resolve();
        await releaseWriter.promise;
        seedSource(db, "late-erased", "sessions/main/deleted.jsonl");
      });
    const pendingSync = manager!.sync();
    await writerEntered.promise;
    const run = vi.fn(async () => {
      nativeEntered.resolve();
      await releaseNative.promise;
      return "deleted";
    });
    const purge = runtime.withSessionPurge!({ ...params, cfg }, run);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(run).not.toHaveBeenCalled();
    releaseWriter.resolve();
    await pendingSync;
    await nativeEntered.promise;
    expect(writer).toHaveBeenCalledOnce();
    const reopened: MemoryIndexManager[] = [];
    const pendingManagers = ["default", "status", "cli"].map(async (purpose) => {
      const next = await MemoryIndexManager.get({
        cfg,
        agentId: "main",
        purpose: purpose as "default" | "status" | "cli",
      });
      reopened.push(next!);
      return next!;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(reopened).toEqual([]);
    releaseNative.resolve();
    await expect(purge).resolves.toBe("deleted");
    await Promise.all(pendingManagers);
    const observer = new DatabaseSync(dbPath);
    try {
      expect(
        observer
          .prepare("SELECT id FROM memory_index_chunks WHERE path = 'sessions/main/deleted.jsonl'")
          .all(),
      ).toEqual([]);
    } finally {
      observer.close();
    }
    for (const next of reopened) {
      await next.close();
    }
  });
});
