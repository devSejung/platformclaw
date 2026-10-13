import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ControlPlaneAuthorizationError, ControlPlaneConflictError } from "./contracts.js";
import {
  spaceContentProofPayloadHash,
  type SpaceContentMutation,
  type SpaceContentRunContext,
} from "./space-content-contracts.js";
import { createSpaceTestFixture } from "./spaces.test-fixtures.js";
import { SqliteSpaceStore } from "./sqlite-spaces.js";

async function contentFixture() {
  const f = await createSpaceTestFixture();
  const conversation = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
    pageId: f.page.id,
    title: "Synthetic writing session",
    requestId: "content-session",
  });
  const context: SpaceContentRunContext = {
    agentId: conversation.agentId,
    sessionKey: conversation.sessionKey,
    runtimeRunId: "synthetic-runtime",
    admissionRunId: "synthetic-admission",
  };
  const append: SpaceContentMutation = {
    operation: "qa.append",
    body: "Synthetic shared answer",
    expectedRevision: 1,
    requestId: "post-one",
  };
  return { ...f, conversation, context, append, content: f.store.spaces.content };
}

function rowCount(db: DatabaseSync, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
}

describe("shared Space content storage", () => {
  it("publishes at the original Q&A location with human attribution and separate revisions", async () => {
    const f = await contentFixture();
    f.store.spaces.setMember(
      f.alice.user.id,
      f.space.id,
      f.bob.user.id,
      "viewer",
      f.space.revision,
    );
    const beforeAudits = await f.store.listAuditEvents(500);
    const result = f.content.mutate(f.context, f.append);
    expect(result).toMatchObject({
      operation: "qa.append",
      spaceId: f.space.id,
      pageId: f.page.id,
      revision: 2,
      requestId: "post-one",
      postId: expect.any(String),
      receiptId: expect.any(String),
    });
    expect(result.link).toContain(`&tab=qa&post=${result.postId}`);
    expect(result).not.toHaveProperty("body");
    expect(f.store.spaces.page(f.bob.user.id, f.space.id, f.page.id)).toEqual(f.page);
    const post = f.content.getQa(f.bob.user.id, f.space.id, f.page.id, result.postId!);
    expect(post).toMatchObject({
      body: f.append.body,
      authorId: f.alice.user.id,
      authorName: "alice",
      agentId: f.context.agentId,
      revision: 2,
      bodyOffset: 0,
      nextBodyOffset: null,
    });
    expect(post).not.toHaveProperty("sessionKey");
    expect(post).not.toHaveProperty("sourceConversationId");
    const audits = (await f.store.listAuditEvents(500)).filter(
      (event) => event.eventType === "space.content.mutated",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: f.alice.user.id,
      details: {
        ...f.context,
        userId: f.alice.user.id,
        conversationId: f.conversation.id,
        pageId: f.page.id,
        spaceId: f.space.id,
        previousRevision: 1,
        revision: 2,
        operation: "qa.append",
        requestId: "post-one",
        receiptId: result.receiptId,
      },
    });
    expect(JSON.stringify(audits)).not.toContain(f.append.body);
    expect((await f.store.listAuditEvents(500)).length).toBe(beforeAudits.length + 1);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.store.spaces.conversations(f.alice.user.id, f.space.id)).toHaveLength(1);
    expect(f.store.spaces.hasConversation(f.page.id)).toBe(true);
  });

  it("returns one durable receipt after response loss, another active run and a reopened connection", async () => {
    const f = await contentFixture();
    const result = f.content.mutate(f.context, f.append);
    const second = new DatabaseSync(f.databasePath);
    try {
      const reopened = new SqliteSpaceStore(second);
      expect(
        reopened.content.mutate(
          { ...f.context, runtimeRunId: "recovery-runtime", admissionRunId: "recovery-admission" },
          f.append,
        ),
      ).toEqual(result);
      expect(f.content.mutate(f.context, f.append)).toEqual(result);
      expect(rowCount(second, "collaboration_space_qa_posts")).toBe(1);
      expect(rowCount(second, "collaboration_space_mutation_receipts")).toBe(1);
      expect(f.content.qaRevision(f.alice.user.id, f.space.id, f.page.id)).toBe(2);
      expect(
        (await f.store.listAuditEvents(500)).filter(
          (event) => event.eventType === "space.content.mutated",
        ),
      ).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("serializes two connections planned at the same revision without losing either stored surface", async () => {
    const f = await contentFixture();
    const second = new DatabaseSync(f.databasePath);
    try {
      const other = new SqliteSpaceStore(second).content;
      f.content.mutate(f.context, f.append);
      expect(() =>
        other.mutate(f.context, {
          ...f.append,
          body: "Competing post",
          requestId: "competing-post",
        }),
      ).toThrow(ControlPlaneConflictError);
      const patch: SpaceContentMutation = {
        operation: "note.replace",
        oldText: "revision A",
        newText: "revision B",
        expectedRevision: 1,
        requestId: "patch-one",
      };
      other.mutate(f.context, patch);
      expect(() =>
        f.content.mutate(f.context, {
          ...patch,
          newText: "revision C",
          requestId: "competing-patch",
        }),
      ).toThrow(ControlPlaneConflictError);
      expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id)).toMatchObject({
        body: "Board revision B",
        revision: 2,
      });
      expect(f.content.qaRevision(f.alice.user.id, f.space.id, f.page.id)).toBe(2);
      expect(rowCount(second, "collaboration_space_mutation_receipts")).toBe(2);
    } finally {
      second.close();
    }
  });

  it("rejects changed payload, operation, revision, target and source session for the same request ID", async () => {
    const f = await contentFixture();
    f.content.mutate(f.context, f.append);
    const sibling = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
      title: "Sibling",
      body: "",
      requestId: "sibling",
    });
    const variants: SpaceContentMutation[] = [
      { ...f.append, body: "Changed answer" },
      { ...f.append, expectedRevision: 2 },
      { ...f.append, pageId: sibling.id },
      {
        operation: "note.append",
        text: "Changed operation",
        requestId: f.append.requestId,
        expectedRevision: 1,
      },
    ];
    for (const changed of variants) {
      expect(() => f.content.mutate(f.context, changed)).toThrow(/Request ID was used/u);
    }
    const other = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
      pageId: f.page.id,
      title: "Other session",
      requestId: "other-session",
    });
    expect(() =>
      f.content.mutate({ ...f.context, sessionKey: other.sessionKey }, f.append),
    ).toThrow(/Request ID was used/u);
    expect(f.content.listQa(f.alice.user.id, f.space.id, f.page.id).posts).toHaveLength(1);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id)).toEqual(f.page);
  });

  it("derives the actor from binding and checks current source and target authorization before replay", async () => {
    const f = await contentFixture();
    const foreign = f.store.spaces.create(f.alice.user.id, "Other synthetic Space", "other-space");
    const foreignPage = f.store.spaces.createPage(f.alice.user.id, foreign.id, {
      title: "Other issue",
      body: "",
      requestId: "other-page",
    });
    for (const context of [
      { ...f.context, agentId: f.space.agentId },
      { ...f.context, agentId: f.bob.binding.agentId },
      { ...f.context, sessionKey: `agent:${f.context.agentId}:main` },
      { ...f.context, sessionKey: `agent:${f.space.agentId}:space:${f.page.id}` },
    ]) {
      expect(() => f.content.mutate(context, f.append)).toThrow(ControlPlaneAuthorizationError);
    }
    expect(() =>
      f.content.mutate(f.context, { ...f.append, spaceId: foreign.id, pageId: foreignPage.id }),
    ).toThrow(ControlPlaneAuthorizationError);
    expect(() => f.content.mutate(f.context, { ...f.append, pageId: foreignPage.id })).toThrow(
      ControlPlaneAuthorizationError,
    );
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "editor", 1);
    const conversation = f.store.spaces.createConversation(f.bob.user.id, f.space.id, {
      pageId: f.page.id,
      title: "Bob session",
      requestId: "bob-session",
    });
    const bobContext = {
      ...f.context,
      agentId: conversation.agentId,
      sessionKey: conversation.sessionKey,
    };
    const result = f.content.mutate(bobContext, f.append);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 2);
    expect(() => f.content.mutate(bobContext, f.append)).toThrow(ControlPlaneAuthorizationError);
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, null, 3);
    expect(() => f.content.mutate(bobContext, f.append)).toThrow(ControlPlaneAuthorizationError);
    expect(() => f.content.getQa(f.bob.user.id, f.space.id, f.page.id, result.postId!)).toThrow(
      ControlPlaneAuthorizationError,
    );
    expect(f.content.getQa(f.alice.user.id, f.space.id, f.page.id, result.postId!)).toMatchObject({
      authorId: f.bob.user.id,
      authorName: "bob",
    });
    expect(f.content.qaAuthors(f.alice.user.id, f.space.id)).toContainEqual({
      id: f.bob.user.id,
      name: "bob",
    });
  });

  it("denies receipt recovery with an inactive binding or disabled owner", async () => {
    const f = await contentFixture();
    f.content.mutate(f.context, f.append);
    const db = new DatabaseSync(f.databasePath);
    try {
      db.prepare("UPDATE agent_bindings SET state = 'failed' WHERE id = ?").run(f.alice.binding.id);
      expect(() => f.content.mutate(f.context, f.append)).toThrow(ControlPlaneAuthorizationError);
      db.prepare("UPDATE agent_bindings SET state = 'active' WHERE id = ?").run(f.alice.binding.id);
      db.prepare("UPDATE platform_users SET status = 'disabled' WHERE id = ?").run(f.alice.user.id);
      expect(() => f.content.mutate(f.context, f.append)).toThrow(ControlPlaneAuthorizationError);
      expect(rowCount(db, "collaboration_space_qa_posts")).toBe(1);
    } finally {
      db.close();
    }
  });

  it("patches one exact anchor and preserves unseen prefix/suffix and the other member's shared view", async () => {
    const f = await contentFixture();
    f.store.spaces.setMember(f.alice.user.id, f.space.id, f.bob.user.id, "viewer", 1);
    const prefix = "P".repeat(9000);
    const suffix = "S".repeat(9000);
    f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      f.page.title,
      prefix + "unique anchor" + suffix,
      1,
    );
    const patch: SpaceContentMutation = {
      operation: "note.replace",
      oldText: "unique anchor",
      newText: "changed anchor",
      expectedRevision: 2,
      requestId: "exact-patch",
    };
    const result = f.content.mutate(f.context, patch);
    expect(result.link).toContain("&tab=notes");
    expect(f.store.spaces.page(f.bob.user.id, f.space.id, f.page.id)).toMatchObject({
      body: prefix + "changed anchor" + suffix,
      revision: 3,
    });
    expect(f.content.mutate({ ...f.context, runtimeRunId: "recovery" }, patch)).toEqual(result);
    expect(f.content.qaRevision(f.alice.user.id, f.space.id, f.page.id)).toBe(1);
    const deleted = f.content.mutate(f.context, {
      ...patch,
      oldText: "changed anchor",
      newText: "",
      expectedRevision: 3,
      requestId: "narrow-delete",
    });
    expect(deleted.revision).toBe(4);
    expect(f.store.spaces.page(f.bob.user.id, f.space.id, f.page.id).body).toBe(prefix + suffix);
  });

  it.each([
    ["missing", "unmatched text", "Board revision A"],
    ["multiple", "A", "A then A"],
    ["overlapping", "aa", "aaa"],
    ["whole truncated read", "Board", "Board revision A"],
  ])("keeps the entire note on a %s or stale replacement", async (kind, oldText, body) => {
    const f = await contentFixture();
    const page = f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      f.page.title,
      body,
      1,
    );
    const mutation: SpaceContentMutation = {
      operation: "note.replace",
      oldText,
      newText: "replacement",
      requestId: "invalid-patch",
      expectedRevision: kind === "whole truncated read" ? 1 : page.revision,
    };
    expect(() => f.content.mutate(f.context, mutation)).toThrow(ControlPlaneConflictError);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id)).toEqual(page);
    expect(
      (await f.store.listAuditEvents(500)).some(
        (event) => event.eventType === "space.content.mutated",
      ),
    ).toBe(false);
  });

  it("appends exact bytes to an empty note and rejects final body overflow", async () => {
    const f = await contentFixture();
    const empty = f.store.spaces.createPage(f.alice.user.id, f.space.id, {
      title: "Empty",
      body: "",
      requestId: "empty",
    });
    const text = '\n  synthetic "note" 🌱\n';
    f.content.mutate(f.context, {
      operation: "note.append",
      text,
      pageId: empty.id,
      expectedRevision: 1,
      requestId: "empty-append",
    });
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, empty.id).body).toBe(text);
    f.store.spaces.savePage(
      f.alice.user.id,
      f.space.id,
      f.page.id,
      f.page.title,
      "X".repeat(32000),
      1,
    );
    expect(() =>
      f.content.mutate(f.context, {
        operation: "note.append",
        text: "x",
        expectedRevision: 2,
        requestId: "overflow",
      }),
    ).toThrow(/32000/u);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id).body).toHaveLength(32000);
    expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id).revision).toBe(2);
  });

  it.each(["collaboration_space_mutation_receipts", "control_audit_events"])(
    "rolls back post, head, note and receipt when %s persistence fails",
    async (table) => {
      const f = await contentFixture();
      const db = new DatabaseSync(f.databasePath);
      try {
        db.exec(
          `CREATE TRIGGER reject_content_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic persistence fault'); END`,
        );
        expect(() => f.content.mutate(f.context, f.append)).toThrow(/synthetic persistence fault/u);
        expect(() =>
          f.content.mutate(f.context, {
            operation: "note.replace",
            oldText: "revision A",
            newText: "revision B",
            expectedRevision: 1,
            requestId: "fault-patch",
          }),
        ).toThrow(/synthetic persistence fault/u);
        expect(rowCount(db, "collaboration_space_qa_posts")).toBe(0);
        expect(rowCount(db, "collaboration_space_qa_heads")).toBe(0);
        expect(rowCount(db, "collaboration_space_mutation_receipts")).toBe(0);
        expect(f.store.spaces.page(f.alice.user.id, f.space.id, f.page.id)).toEqual(f.page);
        db.exec("DROP TRIGGER reject_content_write");
        expect(f.content.mutate(f.context, f.append).revision).toBe(2);
      } finally {
        db.close();
      }
    },
  );

  it("bounds decoded text and JSON escaped Unicode windows with lossless readback", async () => {
    const f = await contentFixture();
    for (const body of ["", "x".repeat(8193), "🌱".repeat(2049), "\ud83c"]) {
      expect(() => f.content.mutate(f.context, { ...f.append, body })).toThrow(/Content text/u);
    }
    expect(() =>
      f.content.mutate(f.context, {
        operation: "note.append",
        text: "",
        expectedRevision: 1,
        requestId: "empty",
      }),
    ).toThrow(/Content text/u);
    expect(() =>
      f.content.mutate(f.context, {
        operation: "note.replace",
        oldText: "",
        newText: "x",
        expectedRevision: 1,
        requestId: "empty-anchor",
      }),
    ).toThrow(/Content text/u);
    const body = '\u0001"\\🌱'.repeat(500);
    const result = f.content.mutate(f.context, { ...f.append, body });
    let offset: number | null = 0;
    let recovered = "";
    for (let index = 0; index < 100 && offset !== null; index++) {
      const window = f.content.getQa(
        f.alice.user.id,
        f.space.id,
        f.page.id,
        result.postId!,
        offset,
        800,
      );
      expect(Buffer.byteLength(JSON.stringify(window.body), "utf8")).toBeLessThanOrEqual(800);
      recovered += window.body;
      offset = window.nextBodyOffset;
    }
    expect(offset).toBeNull();
    expect(recovered).toBe(body);
    const unicode = f.content.mutate(f.context, {
      ...f.append,
      body: "🌱",
      expectedRevision: 2,
      requestId: "unicode",
    });
    expect(() =>
      f.content.getQa(f.alice.user.id, f.space.id, f.page.id, unicode.postId!, 1),
    ).toThrow(/Unicode/u);
    expect(() =>
      f.content.getQa(f.alice.user.id, f.space.id, f.page.id, unicode.postId!, 0, 8001),
    ).toThrow(/window/u);
    expect(() =>
      f.content.getQa(f.alice.user.id, f.space.id, "wrong-page", result.postId!),
    ).toThrow(ControlPlaneAuthorizationError);
  });

  it("keeps keyset pagination pinned to its first snapshot and searches actual shared post links", async () => {
    const f = await contentFixture();
    const posted = [];
    for (let number = 1; number <= 25; number++) {
      posted.push(
        f.content.mutate(f.context, {
          ...f.append,
          body: `Synthetic searchable answer ${number}`,
          expectedRevision: number,
          requestId: `page-post-${number}`,
        }),
      );
    }
    const first = f.content.listQa(f.alice.user.id, f.space.id, f.page.id);
    expect(first.posts).toHaveLength(20);
    expect(first.revision).toBe(26);
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(32000);
    f.content.mutate(f.context, {
      ...f.append,
      body: "Newer post after snapshot",
      expectedRevision: 26,
      requestId: "after-snapshot",
    });
    const second = f.content.listQa(f.alice.user.id, f.space.id, f.page.id, first.nextCursor!);
    expect(second.posts).toHaveLength(5);
    expect(second.revision).toBe(26);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.posts, ...second.posts].map((post) => post.id))).toEqual(
      new Set(posted.map((post) => post.postId)),
    );
    expect(() => f.content.listQa(f.alice.user.id, f.space.id, f.page.id, "invalid")).toThrow(
      /cursor/u,
    );
    expect(() => f.content.listQa(f.alice.user.id, f.space.id, f.page.id, undefined, 21)).toThrow(
      /limit/u,
    );
    const hits = f.content.searchQa(f.alice.user.id, f.space.id, "searchable", f.alice.user.id);
    expect(hits).toHaveLength(20);
    for (const hit of hits) {
      expect(hit).toMatchObject({
        kind: "qa-post",
        authorId: f.alice.user.id,
        authorName: "alice",
        pageId: f.page.id,
      });
      expect(hit.link).toContain(`&tab=qa&post=${hit.postId}`);
      expect(Buffer.byteLength(JSON.stringify(hit.snippet), "utf8")).toBeLessThanOrEqual(800);
    }
    expect(f.content.searchQa(f.alice.user.id, f.space.id, "searchable", f.bob.user.id)).toEqual(
      [],
    );
    expect(f.content.searchQa(f.alice.user.id, f.space.id, "", f.alice.user.id)).toHaveLength(20);
    expect(() => f.content.searchQa(f.alice.user.id, f.space.id, "")).toThrow(/query/u);
    expect(() => f.content.searchQa(f.carol.user.id, f.space.id, "searchable")).toThrow(
      ControlPlaneAuthorizationError,
    );
  });

  it("matches all keywords anywhere and returns Unicode-safe original-text snippet offsets", async () => {
    const f = await contentFixture();
    const body = "İ🌱 before FIRST middle last after";
    const result = f.content.mutate(f.context, { ...f.append, body });
    const [hit] = f.content.searchQa(f.alice.user.id, f.space.id, "last first");
    expect(hit).toMatchObject({ postId: result.postId, bodyOffset: body.indexOf("FIRST") });
    expect(hit!.snippet).toBe(body.slice(hit!.bodyOffset));
    expect(f.content.searchQa(f.alice.user.id, f.space.id, "last absent")).toEqual([]);
    expect(
      f.content.getQa(f.alice.user.id, f.space.id, f.page.id, result.postId!, hit!.bodyOffset).body,
    ).toBe(hit!.snippet);
    expect(f.content.searchQa(f.alice.user.id, f.space.id, "timeout last")).toHaveLength(1);
  });

  it("retains a publication after source deletion but cascades all shared content on Space deletion", async () => {
    const f = await contentFixture();
    const result = f.content.mutate(f.context, f.append);
    const db = new DatabaseSync(f.databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare("DELETE FROM collaboration_space_conversations WHERE id = ?").run(
        f.conversation.id,
      );
      expect(f.content.getQa(f.alice.user.id, f.space.id, f.page.id, result.postId!).body).toBe(
        f.append.body,
      );
      expect(rowCount(db, "collaboration_space_mutation_receipts")).toBe(1);
      const source = f.store.spaces.createConversation(f.alice.user.id, f.space.id, {
        pageId: f.page.id,
        title: "Deletion session",
        requestId: "deletion-session",
      });
      const context = { ...f.context, sessionKey: source.sessionKey };
      f.store.spaces.beginDelete(f.alice.user.id, f.space.id, 1, f.space.name);
      expect(() => f.content.mutate(context, f.append)).toThrow(ControlPlaneAuthorizationError);
      expect(() => f.content.listQa(f.alice.user.id, f.space.id, f.page.id)).toThrow(
        ControlPlaneAuthorizationError,
      );
      f.store.spaces.finishDelete(f.alice.user.id, f.space.id);
      for (const table of [
        "collaboration_space_qa_posts",
        "collaboration_space_qa_heads",
        "collaboration_space_mutation_receipts",
      ]) {
        expect(rowCount(db, table)).toBe(0);
      }
      expect(() => f.content.mutate(context, f.append)).toThrow(ControlPlaneAuthorizationError);
    } finally {
      db.close();
    }
  });

  it("binds proof hashes to exact public arguments and ignores object property ordering", () => {
    const request: SpaceContentMutation = {
      operation: "note.replace",
      oldText: "old",
      newText: "new",
      expectedRevision: 1,
      requestId: "synthetic",
    };
    expect(
      spaceContentProofPayloadHash({
        requestId: "synthetic",
        expectedRevision: 1,
        newText: "new",
        oldText: "old",
        operation: "note.replace",
      }),
    ).toBe(spaceContentProofPayloadHash(request));
    expect(spaceContentProofPayloadHash({ ...request, newText: "new " })).not.toBe(
      spaceContentProofPayloadHash(request),
    );
    expect(spaceContentProofPayloadHash({ ...request, pageId: "explicit-page" })).not.toBe(
      spaceContentProofPayloadHash(request),
    );
  });
});
