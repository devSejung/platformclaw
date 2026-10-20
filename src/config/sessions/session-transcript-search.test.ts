/** SQLite-native transcript search: in-transaction indexing, reconcile, and query bounds. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { TranscriptEvent } from "./session-accessor.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptMessage,
  replaceSqliteTranscriptEvents,
} from "./session-accessor.sqlite.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import { searchSessionTranscriptSubstrings } from "./session-transcript-search-worker.js";
import {
  searchSessionTranscripts,
  querySessionTranscriptSubstrings,
} from "./session-transcript-search.js";

vi.mock("../config.js", async () => ({
  ...(await vi.importActual<typeof import("../config.js")>("../config.js")),
  getRuntimeConfig: vi.fn().mockReturnValue({}),
}));

type TestPaths = { stateDir: string; tempDir: string };

let paths: TestPaths;

beforeEach(() => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-search-"));
  paths = {
    stateDir: path.join(tempDir, "state"),
    tempDir,
  };
});

function env(): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
}

function transcriptScope(sessionId: string, sessionKey: string) {
  return {
    agentId: "main",
    env: env(),
    sessionId,
    sessionKey,
  };
}

async function appendUserMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

async function appendAssistantMessage(sessionId: string, sessionKey: string, text: string) {
  await appendSqliteTranscriptMessage(transcriptScope(sessionId, sessionKey), {
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function search(query: string, options: { limit?: number; sessionKeys?: string[] } = {}) {
  return searchSessionTranscripts({
    agentId: "main",
    env: env(),
    query,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.sessionKeys ? { sessionKeys: options.sessionKeys } : {}),
  });
}

async function waitForSearchReconcile(query: string): Promise<void> {
  await vi.waitFor(() => expect(search(query).indexing).toBe(false), {
    interval: 10,
    // Compact CI shards can delay the asynchronous index worker beyond five seconds.
    timeout: 15_000,
  });
}

afterEach(async () => {
  await waitForSearchReconcile("cleanup-probe");
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(paths.tempDir, { recursive: true, force: true });
});

function agentKysely() {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: env() });
  return {
    db: database.db,
    kysely: getNodeSqliteKysely<
      Pick<
        OpenClawAgentKyselyDatabase,
        "session_transcript_fts" | "session_transcript_index_state" | "transcript_events"
      >
    >(database.db),
  };
}

describe("searchSessionTranscripts", () => {
  it("finds literal CJK fragments and punctuation through the worker with bounded pages", async () => {
    await appendUserMessage(
      "session-1",
      "agent:main:main",
      "로그인오류 배포실패 100%_done foo.bar",
    );
    await appendAssistantMessage("session-1", "agent:main:main", "배포 설정 FOo.Bar");
    await appendUserMessage("session-2", "agent:main:other", "배포다른대화");
    const params = { agentId: "main", env: env(), sessionKeys: ["agent:main:main"], limit: 1 };
    const page = await searchSessionTranscriptSubstrings({ ...params, query: "배포" });
    expect(page).toMatchObject({ totalCount: 2, hasMore: true, truncated: true, indexing: false });
    expect(page.hits).toHaveLength(1);
    const next = await searchSessionTranscriptSubstrings({ ...params, query: "배포", offset: 1 });
    expect(next).toMatchObject({ totalCount: 2, hasMore: false });
    expect(next.hits[0]?.messageId).not.toBe(page.hits[0]?.messageId);
    expect(
      (await searchSessionTranscriptSubstrings({ ...params, query: "로그인" })).totalCount,
    ).toBe(1);
    expect((await searchSessionTranscriptSubstrings({ ...params, query: "%_" })).totalCount).toBe(
      1,
    );
    expect(
      (await searchSessionTranscriptSubstrings({ ...params, query: "foo.bar" })).totalCount,
    ).toBe(2);
    expect(
      (
        await searchSessionTranscriptSubstrings({
          ...params,
          query: "배포",
          sessionId: "session-2",
        })
      ).totalCount,
    ).toBe(0);
    expect(
      (await searchSessionTranscriptSubstrings({ ...params, query: "배포", offset: 20 }))
        .totalCount,
    ).toBe(2);
    expect(search("로그인").hits).toHaveLength(0);
  });

  it("excludes abandoned branches from literal pages and their counts", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceSqliteTranscriptEvents(scope, [
      { type: "message", id: "m1", parentId: null, message: { role: "user", content: "배포정상" } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", content: "배포폐기" },
      },
    ] as unknown as TranscriptEvent[]);
    await appendSqliteTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-1",
      parentId: "m2",
      targetId: "m1",
    } as unknown as TranscriptEvent);
    const result = querySessionTranscriptSubstrings(
      { agentId: "main", env: env(), query: "배포" },
      agentKysely().db,
    );
    expect(result).toMatchObject({ hits: [], totalCount: 0, indexing: true });
    await waitForSearchReconcile("배포정상");
    expect(
      querySessionTranscriptSubstrings(
        { agentId: "main", env: env(), query: "배포" },
        agentKysely().db,
      ),
    ).toMatchObject({ totalCount: 1 });
  });

  it("matches Unicode casing consistently in worker predicates, counts, pages, and snippets", async () => {
    const cases = [
      { query: "привет", text: "ПРИВЕТ" },
      { query: "ä", text: "Ä" },
      { query: "σ", text: "ς Σ" },
      { query: "k", text: "K K" },
      { query: "s", text: "ſ S" },
      { query: "ß", text: "ẞ" },
    ];
    for (const [index, { query, text }] of cases.entries()) {
      const sessionKey = `agent:main:unicode-${index}`;
      const sessionId = `unicode-${index}`;
      // Dotted-I lowercasing changes UTF-16 length; emoji straddles the excerpt
      // boundary. Neither may move the match or leave a dangling surrogate.
      const content = `${"İ".repeat(600)}${"😀".repeat(90)} ${text} ${"tail ".repeat(120)}`;
      await appendUserMessage(sessionId, sessionKey, content);
      await appendAssistantMessage(sessionId, sessionKey, content);
      const params = { agentId: "main", env: env(), sessionKeys: [sessionKey], query, limit: 1 };
      const first = await searchSessionTranscriptSubstrings(params);
      const next = await searchSessionTranscriptSubstrings({ ...params, offset: 1 });
      expect(first).toMatchObject({ totalCount: 2, hasMore: true });
      expect(next).toMatchObject({ totalCount: 2, hasMore: false });
      expect(first.hits[0]?.messageId).not.toBe(next.hits[0]?.messageId);
      for (const hit of [...first.hits, ...next.hits]) {
        expect(hit.snippet).toContain(text);
        expect(hit.snippet).not.toMatch(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
        );
      }
    }
    await appendUserMessage("simple-fold", "agent:main:simple-fold", "İ ß");
    for (const query of ["i", "ss"]) {
      expect(
        await searchSessionTranscriptSubstrings({
          agentId: "main",
          env: env(),
          sessionKeys: ["agent:main:simple-fold"],
          query,
        }),
      ).toMatchObject({ hits: [], totalCount: 0, hasMore: false });
    }
  });

  it("indexes appended messages synchronously and returns bounded hits", async () => {
    await appendUserMessage("session-1", "agent:main:main", "the deployment failed on friday");
    await appendAssistantMessage("session-1", "agent:main:main", "the deployment fix is rolling");

    const result = search("deployment");
    expect(result.indexing).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.hits).toHaveLength(2);
    const roles = result.hits.map((hit) => hit.role).toSorted();
    expect(roles).toEqual(["assistant", "user"]);
    for (const hit of result.hits) {
      expect(hit.sessionKey).toBe("agent:main:main");
      expect(hit.sessionId).toBe("session-1");
      expect(hit.snippet).toContain("deployment");
      expect(hit.messageId).toBeTruthy();
    }
  });

  it("ignores non-message events and misses non-matching queries", async () => {
    await appendUserMessage("session-1", "agent:main:main", "alpha topic");
    await appendSqliteTranscriptEvent(transcriptScope("session-1", "agent:main:main"), {
      type: "model_change",
      id: "model-change-1",
      model: "sonnet-4.6",
    } as unknown as TranscriptEvent);

    expect(search("sonnet").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("filters hits to the requested session keys", async () => {
    await appendUserMessage("session-1", "agent:main:main", "shared keyword payload");
    await appendUserMessage("session-2", "agent:main:other", "shared keyword payload");

    const all = search("keyword");
    expect(all.hits).toHaveLength(2);

    const filtered = search("keyword", { sessionKeys: ["agent:main:other"] });
    expect(filtered.hits).toHaveLength(1);
    expect(filtered.hits[0]?.sessionKey).toBe("agent:main:other");
    expect(filtered.hits[0]?.sessionId).toBe("session-2");
  });

  it("caps hits at the limit and reports truncation", async () => {
    for (let index = 0; index < 4; index += 1) {
      await appendUserMessage("session-1", "agent:main:main", `needle number ${index}`);
    }
    const result = search("needle", { limit: 3 });
    expect(result.hits).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects empty and oversized queries", () => {
    expect(() => search("   ")).toThrow(/query must not be empty/);
    expect(() => search("x".repeat(4097))).toThrow(/must not exceed/);
  });

  it("reindexes synchronously when a linear transcript is replaced", async () => {
    await appendUserMessage("session-1", "agent:main:main", "obsolete branch text");
    await replaceSqliteTranscriptEvents(transcriptScope("session-1", "agent:main:main"), [
      {
        type: "message",
        id: "m-new",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "replacement text" }] },
        timestamp: 1720000000000,
      } as unknown as TranscriptEvent,
    ]);

    expect(search("obsolete").hits).toHaveLength(0);
    const result = search("replacement");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.messageId).toBe("m-new");
  });

  it("only surfaces the active branch after a deferred leaf-control rebuild", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    await replaceSqliteTranscriptEvents(scope, [
      {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "alpha origin" }] },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", content: [{ type: "text", text: "beta abandoned" }] },
      },
    ] as unknown as TranscriptEvent[]);
    await appendSqliteTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-1",
      parentId: "m2",
      targetId: "m1",
    } as unknown as TranscriptEvent);

    const dirty = search("beta");
    expect(dirty.indexing).toBe(true);
    expect(dirty.hits).toHaveLength(0);
    await waitForSearchReconcile("beta");

    expect(search("beta").hits).toHaveLength(0);
    expect(search("alpha").hits).toHaveLength(1);
  });

  it("streams large searchable projections to the writer in bounded chunks", async () => {
    const scope = transcriptScope("session-1", "agent:main:main");
    const largeText = "x".repeat(140 * 1024);
    await replaceSqliteTranscriptEvents(
      scope,
      ["alpha-stream", "beta-stream", "gamma-stream"].map((marker, index) => ({
        type: "message",
        id: `m${index + 1}`,
        parentId: index === 0 ? null : `m${index}`,
        message: { role: "user", content: [{ type: "text", text: `${marker} ${largeText}` }] },
      })) as unknown as TranscriptEvent[],
    );
    await appendSqliteTranscriptEvent(scope, {
      type: "leaf",
      id: "leaf-large",
      parentId: "m3",
      targetId: "m3",
    } as unknown as TranscriptEvent);

    expect(search("gamma-stream").indexing).toBe(true);
    await waitForSearchReconcile("gamma-stream");

    expect(search("alpha-stream").hits).toHaveLength(1);
    expect(search("beta-stream").hits).toHaveLength(1);
    expect(search("gamma-stream").hits).toHaveLength(1);
  });

  it("backfills transcripts that predate the index via reconcile", async () => {
    await appendUserMessage("session-1", "agent:main:main", "historic knowledge");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_fts"));
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));
    expect(search("historic").indexing).toBe(true);

    await waitForSearchReconcile("historic");
    const result = search("historic");
    expect(result.indexing).toBe(false);
    expect(result.hits).toHaveLength(1);
  });

  it("detects missing, dirty, and lagging transcript index watermarks", async () => {
    await appendUserMessage("session-1", "agent:main:main", "indexed message");
    const { db, kysely } = agentKysely();
    const pending = () => listSessionsNeedingTranscriptIndexReconcile(db);

    expect(pending()).toEqual([]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ needs_rebuild: 1 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("session_transcript_index_state")
        .set({ indexed_seq: -1, needs_rebuild: 0 })
        .where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);

    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("session_transcript_index_state").where("session_id", "=", "session-1"),
    );
    expect(pending()).toEqual(["session-1"]);
  });

  it("sweeps orphaned index rows during reconcile", async () => {
    await appendUserMessage("session-1", "agent:main:main", "anchor row");
    const { db, kysely } = agentKysely();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("session_transcript_fts").values({
        text: "ghost payload",
        session_id: "session-ghost",
        message_id: "m-ghost",
        role: "user",
        timestamp: "1",
      }),
    );
    executeSqliteQuerySync(db, kysely.deleteFrom("session_transcript_index_state"));

    const ghostRows = () =>
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("session_transcript_fts")
          .select("message_id")
          .where("session_id", "=", "session-ghost"),
      ).rows.length;
    expect(ghostRows()).toBe(1);
    expect(search("anchor").indexing).toBe(true);
    await waitForSearchReconcile("anchor");
    expect(ghostRows()).toBe(0);
    expect(search("anchor").hits).toHaveLength(1);
  });
});
