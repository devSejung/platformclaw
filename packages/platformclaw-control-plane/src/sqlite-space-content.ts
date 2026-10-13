import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  createSyncKysely,
  executeSync,
  runImmediateTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import {
  spaceContentFields,
  spaceContentLink,
  type SpaceContentMutation,
  type SpaceContentMutationResult,
  type SpaceContentRunContext,
  type SpaceQaList,
  type SpaceQaPost,
  type SpaceQaSearchHit,
} from "./space-content-contracts.js";
import { assertSpaceTextOffset } from "./space-recall-projection.js";
import { ensureSpaceSchema, type SpacePageRow } from "./sqlite-schema-spaces.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type QaPostRow = {
  id: string;
  space_id: string;
  page_id: string;
  revision: number;
  body: string;
  actor_user_id: string;
  author_name: string;
  agent_id: string;
  source_conversation_id: string | null;
  created_at: number;
};
type ReceiptRow = {
  id: string;
  actor_user_id: string;
  request_id: string;
  operation: SpaceContentMutation["operation"];
  space_id: string;
  page_id: string;
  source_conversation_id: string;
  agent_id: string;
  session_key: string;
  runtime_run_id: string;
  admission_run_id: string;
  payload_hash: string;
  previous_revision: number;
  revision: number;
  post_id: string | null;
  created_at: number;
};
type Database = Pick<ControlPlaneDatabase, "platform_users" | "control_audit_events"> & {
  collaboration_space_pages: SpacePageRow;
  collaboration_space_qa_heads: { page_id: string; revision: number };
  collaboration_space_qa_posts: QaPostRow;
  collaboration_space_mutation_receipts: ReceiptRow;
};
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function boundedText(value: string, bytes: number): string {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(truncateUtf16Safe(value, middle)) <= bytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return truncateUtf16Safe(value, low);
}

function validateMutation(mutation: SpaceContentMutation) {
  if (
    !Number.isSafeInteger(mutation.expectedRevision) ||
    mutation.expectedRevision < 1 ||
    typeof mutation.requestId !== "string" ||
    !mutation.requestId.trim() ||
    mutation.requestId.length > 128
  ) {
    throw new ControlPlaneStateError("Invalid content revision or request ID");
  }
  for (const target of [mutation.spaceId, mutation.pageId]) {
    if (target !== undefined && (typeof target !== "string" || !target || target.length > 128)) {
      throw new ControlPlaneStateError("Invalid content target");
    }
  }
  for (const [index, text] of spaceContentFields(mutation).entries()) {
    const allowEmpty = mutation.operation === "note.replace" && index === 1;
    if (
      typeof text !== "string" ||
      (!allowEmpty && !text.trim()) ||
      Buffer.byteLength(text, "utf8") > 8192 ||
      Buffer.from(text, "utf8").toString("utf8") !== text
    ) {
      throw new ControlPlaneStateError(
        "Content text must be valid Unicode, nonempty and at most 8192 UTF-8 bytes",
      );
    }
  }
}

function projectReceipt(row: ReceiptRow): SpaceContentMutationResult {
  return {
    operation: row.operation,
    spaceId: row.space_id,
    pageId: row.page_id,
    revision: row.revision,
    ...(row.post_id === null ? {} : { postId: row.post_id }),
    requestId: row.request_id,
    receiptId: row.id,
    link: spaceContentLink(row.space_id, row.page_id, row.post_id ?? undefined),
  };
}

function projectPost(row: QaPostRow, offset: number, bytes: number): SpaceQaPost {
  const body = boundedText(row.body.slice(offset), bytes);
  const nextBodyOffset = offset + body.length < row.body.length ? offset + body.length : null;
  return {
    id: row.id,
    spaceId: row.space_id,
    pageId: row.page_id,
    revision: row.revision,
    body,
    authorId: row.actor_user_id,
    authorName: row.author_name,
    agentId: row.agent_id,
    createdAt: row.created_at,
    bodyOffset: offset,
    nextBodyOffset,
    truncated: nextBodyOffset !== null,
  };
}

/** Shared publications are independent of personal transcripts and their lifecycle. */
export class SqliteSpaceContentStore {
  private readonly query = createSyncKysely<Database>();
  private ready = false;
  constructor(
    private readonly db: DatabaseSync,
    private readonly spaces: Pick<
      SqliteSpaceStore,
      "access" | "page" | "userForAgent" | "conversationForSession"
    >,
  ) {}

  private ensure() {
    if (!this.ready) {
      ensureSpaceSchema(this.db);
      this.ready = true;
    }
  }

  private head(pageId: string): number {
    return (
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_qa_heads")
          .select("revision")
          .where("page_id", "=", pageId),
      )?.revision ?? 1
    );
  }

  qaRevision(userId: string, spaceId: string, pageId: string): number {
    this.ensure();
    this.spaces.page(userId, spaceId, pageId);
    return this.head(pageId);
  }

  mutate(
    context: SpaceContentRunContext,
    mutation: SpaceContentMutation,
  ): SpaceContentMutationResult {
    validateMutation(mutation);
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      // Authorization precedes receipt lookup, so a durable success is never an ACL bypass.
      const userId = this.spaces.userForAgent(context.agentId);
      const source = this.spaces.conversationForSession(userId, context.sessionKey, true);
      if (source.agentId !== context.agentId || source.sessionKey !== context.sessionKey) {
        throw new ControlPlaneAuthorizationError("Space conversation unavailable");
      }
      this.spaces.page(userId, source.spaceId, source.pageId, "editor");
      const spaceId = mutation.spaceId ?? source.spaceId;
      if (spaceId !== source.spaceId) {
        throw new ControlPlaneAuthorizationError("Content writes must stay in the current Space");
      }
      const pageId = mutation.pageId ?? source.pageId;
      const page = this.spaces.page(userId, spaceId, pageId, "editor");
      const payloadHash = createHash("sha256")
        .update(
          JSON.stringify([
            mutation.operation,
            spaceId,
            pageId,
            source.id,
            mutation.expectedRevision,
            spaceContentFields(mutation),
          ]),
          "utf8",
        )
        .digest("hex");
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_mutation_receipts")
          .selectAll()
          .where("actor_user_id", "=", userId)
          .where("request_id", "=", mutation.requestId),
      );
      if (prior) {
        if (prior.payload_hash !== payloadHash) {
          throw new ControlPlaneConflictError(
            "space_changed",
            "Request ID was used for different content; use a new request ID",
          );
        }
        return projectReceipt(prior);
      }
      const previousRevision =
        mutation.operation === "qa.append" ? this.head(pageId) : page.revision;
      if (previousRevision !== mutation.expectedRevision) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Content changed; read the current revision before a new request",
        );
      }
      const revision = previousRevision + 1;
      const createdAt = Date.now();
      let postId: string | null = null;
      if (mutation.operation === "qa.append") {
        postId = randomUUID();
        const author = takeFirstSync(
          this.db,
          this.query
            .selectFrom("platform_users")
            .select(["display_name", "account_id"])
            .where("id", "=", userId),
        )!;
        executeSync(
          this.db,
          this.query.insertInto("collaboration_space_qa_posts").values({
            id: postId,
            space_id: spaceId,
            page_id: pageId,
            revision,
            body: mutation.body,
            actor_user_id: userId,
            author_name: boundedText(author.display_name || author.account_id, 1000),
            agent_id: context.agentId,
            source_conversation_id: source.id,
            created_at: createdAt,
          }),
        );
        executeSync(
          this.db,
          this.query
            .insertInto("collaboration_space_qa_heads")
            .values({ page_id: pageId, revision })
            .onConflict((oc) => oc.column("page_id").doUpdateSet({ revision })),
        );
      } else {
        let body: string;
        if (mutation.operation === "note.append") {
          body = page.body + mutation.text;
        } else {
          const offset = page.body.indexOf(mutation.oldText);
          // Start the second match one character later to reject overlapping anchors too.
          if (offset < 0 || page.body.includes(mutation.oldText, offset + 1)) {
            throw new ControlPlaneConflictError(
              "space_changed",
              "Replacement text must match exactly once; read the current note before a new request",
            );
          }
          body =
            page.body.slice(0, offset) +
            mutation.newText +
            page.body.slice(offset + mutation.oldText.length);
        }
        if (body.length > 32000) {
          throw new ControlPlaneStateError(
            "Note body exceeds 32000 UTF-16 characters; use a smaller patch",
          );
        }
        executeSync(
          this.db,
          this.query
            .updateTable("collaboration_space_pages")
            .set({ body, revision, updated_at: createdAt })
            .where("id", "=", pageId),
        );
      }
      const receipt: ReceiptRow = {
        id: randomUUID(),
        actor_user_id: userId,
        request_id: mutation.requestId,
        operation: mutation.operation,
        space_id: spaceId,
        page_id: pageId,
        source_conversation_id: source.id,
        agent_id: context.agentId,
        session_key: context.sessionKey,
        runtime_run_id: context.runtimeRunId,
        admission_run_id: context.admissionRunId,
        payload_hash: payloadHash,
        previous_revision: previousRevision,
        revision,
        post_id: postId,
        created_at: createdAt,
      };
      executeSync(
        this.db,
        this.query.insertInto("collaboration_space_mutation_receipts").values(receipt),
      );
      executeSync(
        this.db,
        this.query.insertInto("control_audit_events").values({
          id: randomUUID(),
          actor_user_id: userId,
          event_type: "space.content.mutated",
          target_type: "space",
          target_id: spaceId,
          created_at: createdAt,
          details_json: JSON.stringify({
            userId,
            ...context,
            conversationId: source.id,
            spaceId,
            pageId,
            previousRevision,
            revision,
            operation: mutation.operation,
            requestId: mutation.requestId,
            receiptId: receipt.id,
            payloadHash,
          }),
        }),
      );
      return projectReceipt(receipt);
    });
  }

  listQa(
    userId: string,
    spaceId: string,
    pageId: string,
    cursor?: string,
    limit = 20,
    responseLimitBytes = 32000,
  ): SpaceQaList {
    const revision = this.qaRevision(userId, spaceId, pageId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
      throw new ControlPlaneStateError("Q&A list limit must be between 1 and 20");
    }
    let snapshot = revision;
    let before = revision + 1;
    if (cursor !== undefined) {
      let decoded: unknown;
      try {
        if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) {
          throw new Error("Invalid cursor");
        }
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        throw new ControlPlaneStateError("Invalid Q&A cursor; reload the first page");
      }
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 3 ||
        decoded[0] !== pageId ||
        !Number.isSafeInteger(decoded[1]) ||
        decoded[1] < 1 ||
        decoded[1] > revision ||
        !Number.isSafeInteger(decoded[2]) ||
        decoded[2] < 2 ||
        decoded[2] > decoded[1]
      ) {
        throw new ControlPlaneStateError("Invalid Q&A cursor; reload the first page");
      }
      snapshot = decoded[1] as number;
      before = decoded[2] as number;
    }
    const rows = executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_qa_posts")
        .selectAll()
        .where("space_id", "=", spaceId)
        .where("page_id", "=", pageId)
        .where("revision", "<=", snapshot)
        .where("revision", "<", before)
        .orderBy("revision", "desc")
        .limit(limit + 1),
    ).rows;
    const result: SpaceQaList = { posts: [], revision: snapshot, nextCursor: null, hasMore: false };
    for (const row of rows.slice(0, limit)) {
      const post = projectPost(row, 0, 1000);
      if (jsonBytes({ ...result, posts: [...result.posts, post] }) > responseLimitBytes - 1024) {
        break;
      }
      result.posts.push(post);
    }
    result.hasMore = rows.length > result.posts.length;
    if (result.hasMore) {
      const last = result.posts.at(-1)!;
      result.nextCursor = Buffer.from(
        JSON.stringify([pageId, snapshot, last.revision]),
        "utf8",
      ).toString("base64url");
    }
    return result;
  }

  getQa(
    userId: string,
    spaceId: string,
    pageId: string,
    postId: string,
    bodyOffset = 0,
    bodyLimitBytes = 4000,
  ): SpaceQaPost {
    this.qaRevision(userId, spaceId, pageId);
    const post = takeFirstSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_qa_posts")
        .selectAll()
        .where("id", "=", postId)
        .where("space_id", "=", spaceId)
        .where("page_id", "=", pageId),
    );
    if (!post) {
      throw new ControlPlaneAuthorizationError("Q&A post unavailable");
    }
    if (
      !Number.isSafeInteger(bodyOffset) ||
      bodyOffset < 0 ||
      bodyOffset > post.body.length ||
      !Number.isSafeInteger(bodyLimitBytes) ||
      bodyLimitBytes < 64 ||
      bodyLimitBytes > 8000
    ) {
      throw new ControlPlaneStateError(
        "Invalid Q&A text window; use the returned continuation offset",
      );
    }
    assertSpaceTextOffset(post.body, bodyOffset);
    return projectPost(post, bodyOffset, bodyLimitBytes);
  }

  searchQa(userId: string, spaceId: string, query: string, authorId?: string): SpaceQaSearchHit[] {
    this.ensure();
    const space = this.spaces.access(userId, spaceId);
    if (
      typeof query !== "string" ||
      (!query.trim() && authorId === undefined) ||
      query.length > 1000
    ) {
      throw new ControlPlaneStateError("Invalid Q&A search query");
    }
    const terms = query.trim() ? query.trim().split(/\s+/u) : [];
    let statement = this.query
      .selectFrom("collaboration_space_qa_posts as post")
      .innerJoin("collaboration_space_pages as page", "page.id", "post.page_id")
      .selectAll("post")
      .select("page.title")
      .where("post.space_id", "=", spaceId);
    for (const term of terms) {
      statement = statement.where((eb) =>
        eb.or([
          eb(
            eb.fn<number>("instr", [eb.fn("lower", ["post.body"]), eb.fn("lower", [eb.val(term)])]),
            ">",
            0,
          ),
          eb(
            eb.fn<number>("instr", [
              eb.fn("lower", ["page.title"]),
              eb.fn("lower", [eb.val(term)]),
            ]),
            ">",
            0,
          ),
        ]),
      );
    }
    if (authorId !== undefined) {
      statement = statement.where("post.actor_user_id", "=", authorId);
    }
    return executeSync(
      this.db,
      statement.orderBy("post.created_at", "desc").orderBy("post.id").limit(20),
    ).rows.map((row) => {
      // Match the original string: Unicode case folding can change UTF-16 offsets.
      const matches = terms.map(
        (term) =>
          new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu").exec(row.body)?.index ??
          -1,
      );
      const firstMatch = Math.min(...matches.filter((offset) => offset >= 0));
      const bodyOffset = Number.isFinite(firstMatch)
        ? truncateUtf16Safe(row.body, firstMatch).length
        : 0;
      return {
        kind: "qa-post",
        spaceId,
        spaceName: space.name,
        pageId: row.page_id,
        pageTitle: row.title,
        postId: row.id,
        authorId: row.actor_user_id,
        authorName: row.author_name,
        snippet: boundedText(row.body.slice(bodyOffset), 800),
        bodyOffset,
        link: spaceContentLink(spaceId, row.page_id, row.id),
      };
    });
  }

  qaAuthors(
    userId: string,
    spaceId: string,
    authorId?: string,
  ): Array<{ id: string; name: string }> {
    this.ensure();
    this.spaces.access(userId, spaceId);
    let statement = this.query
      .selectFrom("collaboration_space_qa_posts")
      // Match published aliases before the service deduplicates actor IDs.
      .select(["actor_user_id as id", "author_name as name"])
      .where("space_id", "=", spaceId);
    if (authorId !== undefined) {
      statement = statement.where("actor_user_id", "=", authorId);
    }
    return executeSync(
      this.db,
      statement
        .groupBy(["actor_user_id", "author_name"])
        .orderBy("actor_user_id")
        .orderBy("author_name")
        .limit(201),
    ).rows.map((row) => ({ id: row.id, name: row.name }));
  }
}
