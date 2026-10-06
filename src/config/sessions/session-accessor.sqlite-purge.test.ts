import { strictEqual } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  encodeSessionArchiveContent,
  materializeSessionArchiveForRead,
} from "./archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("owned session transcript purge", () => {
  let root: string;
  let storePath: string;
  const sessionKey = "agent:main:purge";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-purge-"));
    storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function seed(sessionId: string, key = sessionKey) {
    await replaceSessionEntry({ sessionKey: key, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey: key, sessionId, storePath }, [
      { type: "session", id: sessionId },
      {
        type: "message",
        id: `${sessionId}-message`,
        parentId: null,
        message: { role: "user", content: `private ${sessionId}` },
      },
    ]);
  }
  function archive(sessionId: string) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const encoded = encodeSessionArchiveContent(`{"type":"message","text":"${sessionId}"}\n`);
    const file = path.join(
      path.dirname(storePath),
      `${sessionId}.jsonl.deleted.2026-07-11T00-00-00.000Z${encoded.suffix}`,
    );
    fs.writeFileSync(file, encoded.bytes);
    return file;
  }
  const target = { canonicalKey: sessionKey, storeKeys: [sessionKey] };
  function purge() {
    return deleteSessionEntryLifecycle({
      storePath,
      target,
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      purgeTranscript: true,
    });
  }

  it("removes current and retained history, FTS, owned archives and plaintext caches only", async () => {
    await seed("past");
    await seed("current");
    await seed("foreign", "agent:main:other");
    const past = archive("past");
    const current = archive("current");
    const foreign = archive("foreign");
    const neighbor = path.join(
      path.dirname(storePath),
      "current.jsonl.notes.deleted.2026-07-11T00-00-00.000Z",
    );
    fs.writeFileSync(neighbor, "not a native archive");
    const cached = materializeSessionArchiveForRead(current);
    const result = await purge();
    expect(result).toMatchObject({ deleted: true, archivedTranscripts: [] });
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    for (const sessionId of ["past", "current"]) {
      expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual([]);
    }
    for (const file of [past, current, cached]) {
      expect(fs.existsSync(file)).toBe(false);
    }
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.readFileSync(neighbor, "utf8")).toBe("not a native archive");
    expect(
      await loadTranscriptEvents({
        sessionKey: "agent:main:other",
        sessionId: "foreign",
        storePath,
      }),
    ).toHaveLength(2);
    const resolved = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    strictEqual(resolved.agentId, "main");
    const database = openOpenClawAgentDatabase({ agentId: resolved.agentId, path: resolved.path });
    const db = getNodeSqliteKysely<DB>(database.db);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_fts")
          .select("session_id")
          .where("session_id", "in", ["past", "current"]),
      ).rows,
    ).toEqual([]);
  });

  it("keeps the owner mapping after file cleanup failure so retry finishes the same purge", async () => {
    await seed("retry");
    const file = archive("retry");
    const remove = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
      if (String(args[0]) === file) {
        throw new Error("synthetic permission failure");
      }
      return remove(...args);
    });
    await expect(purge()).rejects.toThrow("synthetic permission failure");
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("retry");
    expect(fs.existsSync(file)).toBe(true);
    spy.mockRestore();
    expect((await purge()).deleted).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("retains all native source identities when derived-data purge fails", async () => {
    await seed("history");
    await seed("live");
    const cleanup = vi.fn(async () => {
      throw new Error("memory purge unavailable");
    });
    await expect(
      deleteSessionEntryLifecycle({
        storePath,
        target,
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
        purgeTranscript: true,
        withTranscriptPurge: cleanup,
      }),
    ).rejects.toThrow("memory purge unavailable");
    expect(cleanup).toHaveBeenCalledWith(
      {
        sessionIds: expect.arrayContaining(["history", "live"]),
        archiveDirectory: path.dirname(storePath),
      },
      expect.any(Function),
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("live");
    expect(
      await loadTranscriptEvents({ sessionKey, sessionId: "history", storePath }),
    ).toHaveLength(2);
  });

  it("preserves transcript and archive copies referenced by another logical owner", async () => {
    await seed("shared");
    const otherKey = "agent:main:alias";
    await replaceSessionEntry(
      { sessionKey: otherKey, storePath },
      { sessionId: "shared", updatedAt: Date.now() },
    );
    const file = archive("shared");
    expect((await purge()).deleted).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(
      await loadTranscriptEvents({ sessionKey: otherKey, sessionId: "shared", storePath }),
    ).toHaveLength(2);
  });

  it("does not acknowledge a purge when a prior metadata-only deletion retained owned history", async () => {
    await seed("retained");
    await deleteSessionEntryLifecycle({ storePath, target, archiveTranscript: false });
    await expect(purge()).rejects.toThrow("Retained session history has no active owner");
    expect(
      await loadTranscriptEvents({ sessionKey, sessionId: "retained", storePath }),
    ).toHaveLength(2);
  });

  it.each([
    { expectedSessionId: "wrong" },
    { expectedLifecycleRevision: "wrong" },
    { expectedUpdatedAt: -1 },
    { expectedEntry: { sessionId: "wrong", updatedAt: 0 } },
  ])("reports a compare-and-delete mismatch without purging data %#", async (guard) => {
    await seed("guarded");
    const file = archive("guarded");
    const derivedPurge = vi.fn();
    const result = await deleteSessionEntryLifecycle({
      storePath,
      target,
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      purgeTranscript: true,
      withTranscriptPurge: derivedPurge,
      ...guard,
    });
    expect(result).toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect(derivedPurge).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("guarded");
    expect(
      await loadTranscriptEvents({ sessionKey, sessionId: "guarded", storePath }),
    ).toHaveLength(2);
  });
});
