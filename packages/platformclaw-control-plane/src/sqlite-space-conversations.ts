import { randomUUID } from "node:crypto";
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
  spaceConversationSessionPrefix,
  type SpaceConversation,
  type SpaceRole,
} from "./space-contracts.js";
import type { SpaceConversationRow } from "./sqlite-schema-spaces.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type Database = Pick<
  ControlPlaneDatabase,
  "platform_users" | "agent_bindings" | "control_audit_events"
> & {
  collaboration_space_conversations: SpaceConversationRow;
  collaboration_space_conversation_titles: { conversation_id: string; requested_title: string };
  collaboration_space_members: { space_id: string; user_id: string; role: SpaceRole };
  collaboration_space_deletions: { space_id: string };
};
type RegisteredConversation = Omit<SpaceConversation, "canWrite">;

function projectConversation(row: SpaceConversationRow): RegisteredConversation {
  return {
    id: row.id,
    spaceId: row.space_id,
    pageId: row.page_id,
    title: row.title,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    createdAt: row.created_at,
  };
}

/** Only agent recall shares history; browser access and execution remain creator-owned. */
export class SqliteSpaceConversationStore {
  private readonly query = createSyncKysely<Database>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly spaces: Pick<SqliteSpaceStore, "access" | "page">,
  ) {}
  private personalBinding(userId: string) {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings as binding")
        .innerJoin("platform_users as owner", "owner.id", "binding.user_id")
        .select(["binding.agent_id", "owner.display_name", "owner.account_id"])
        .where("binding.user_id", "=", userId)
        .where("binding.kind", "=", "personal")
        .where("binding.state", "=", "active")
        .where("owner.status", "=", "active"),
    );
  }
  private projectAccess(
    userId: string,
    role: SpaceRole,
    conversation: RegisteredConversation,
    personalAgentId: string | undefined,
    write: boolean,
  ): SpaceConversation {
    const canWrite =
      userId === conversation.ownerId &&
      role !== "viewer" &&
      personalAgentId === conversation.agentId;
    if (write && !canWrite) {
      throw new ControlPlaneAuthorizationError("Space conversation is read-only");
    }
    return { ...conversation, canWrite };
  }
  private allocateTitle(
    userId: string,
    pageId: string,
    requestedTitle: string,
    conversationId?: string,
  ): string {
    let query = this.query
      .selectFrom("collaboration_space_conversations")
      .select("title")
      .where("owner_id", "=", userId)
      .where("page_id", "=", pageId);
    if (conversationId !== undefined) {
      query = query.where("id", "!=", conversationId);
    }
    const titles = new Set(executeSync(this.db, query).rows.map((row) => row.title));
    // Both creation and rename allocate under the writer lock, excluding only the renamed row.
    const baseTitle = requestedTitle.trim();
    let title = baseTitle;
    for (let number = 2; titles.has(title); number++) {
      const suffix = String(number);
      title = truncateUtf16Safe(baseTitle, 240 - suffix.length) + suffix;
    }
    return title;
  }
  create(
    userId: string,
    spaceId: string,
    params: { pageId: string; title: string; requestId: string },
  ): SpaceConversation {
    const requestedTitle = params.title;
    this.spaces.page(userId, spaceId, params.pageId, "editor");
    return runImmediateTransaction(this.db, () => {
      this.spaces.page(userId, spaceId, params.pageId, "editor");
      const binding = this.personalBinding(userId);
      if (!binding) {
        throw new ControlPlaneAuthorizationError("Active personal agent required");
      }
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_conversations as conversation")
          .leftJoin(
            "collaboration_space_conversation_titles as receipt",
            "receipt.conversation_id",
            "conversation.id",
          )
          .selectAll("conversation")
          .select(({ fn }) =>
            fn.coalesce("receipt.requested_title", "conversation.title").as("requested_title"),
          )
          .where("owner_id", "=", userId)
          .where("request_id", "=", params.requestId),
      );
      if (prior) {
        if (
          prior.space_id !== spaceId ||
          prior.page_id !== params.pageId ||
          prior.requested_title !== requestedTitle
        ) {
          throw new ControlPlaneConflictError(
            "space_changed",
            "Conversation request changed; start a new request",
          );
        }
        return this.get(userId, spaceId, prior.id, true);
      }
      const count = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_conversations")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("space_id", "=", spaceId),
      )!.count;
      if (count >= 200) {
        throw new ControlPlaneStateError("Space conversation limit reached");
      }
      const title = this.allocateTitle(userId, params.pageId, requestedTitle);
      const id = randomUUID();
      const createdAt = Date.now();
      const row: SpaceConversationRow = {
        id,
        space_id: spaceId,
        page_id: params.pageId,
        title,
        owner_id: userId,
        owner_name: binding.display_name || binding.account_id,
        agent_id: binding.agent_id,
        // Only this writer may register the reserved namespace. Existing private keys are never adopted.
        session_key: `${spaceConversationSessionPrefix(binding.agent_id)}${id}`,
        request_id: params.requestId,
        created_at: createdAt,
      };
      executeSync(this.db, this.query.insertInto("collaboration_space_conversations").values(row));
      // An unchanged title is its own receipt. Persist the original only when allocation
      // changes it, so a lost response can retry without claiming a different display title.
      if (title !== requestedTitle) {
        executeSync(
          this.db,
          this.query.insertInto("collaboration_space_conversation_titles").values({
            conversation_id: id,
            requested_title: requestedTitle,
          }),
        );
      }
      executeSync(
        this.db,
        this.query.insertInto("control_audit_events").values({
          id: randomUUID(),
          actor_user_id: userId,
          event_type: "space.conversation.created",
          target_type: "space",
          target_id: spaceId,
          details_json: JSON.stringify({ conversationId: id, pageId: params.pageId }),
          created_at: createdAt,
        }),
      );
      return { ...projectConversation(row), canWrite: true };
    });
  }
  rename(
    userId: string,
    spaceId: string,
    conversationId: string,
    requestedTitle: string,
    revision: number,
    expectedTitle: string,
  ): SpaceConversation {
    this.get(userId, spaceId, conversationId, true);
    return runImmediateTransaction(this.db, () => {
      const conversation = this.get(userId, spaceId, conversationId, true);
      const space = this.spaces.access(userId, spaceId, "editor");
      if (space.revision !== revision) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Space changed; reload before retrying",
        );
      }
      // Title CAS detects stale edits without changing the membership epoch used by chat admission.
      if (conversation.title !== expectedTitle) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Conversation changed; reload before renaming",
        );
      }
      const title = this.allocateTitle(userId, conversation.pageId, requestedTitle, conversationId);
      if (title === conversation.title) {
        return conversation;
      }
      // Older unchanged titles are their own create receipt. Save that fact before
      // the first rename, while retaining exact whitespace/suffix receipts already recorded.
      executeSync(
        this.db,
        this.query
          .insertInto("collaboration_space_conversation_titles")
          .values({ conversation_id: conversationId, requested_title: conversation.title })
          .onConflict((oc) => oc.column("conversation_id").doNothing()),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_space_conversations")
          .set({ title })
          .where("id", "=", conversationId),
      );
      executeSync(
        this.db,
        this.query.insertInto("control_audit_events").values({
          id: randomUUID(),
          actor_user_id: userId,
          event_type: "space.conversation.renamed",
          target_type: "space",
          target_id: spaceId,
          details_json: JSON.stringify({ conversationId, pageId: conversation.pageId }),
          created_at: Date.now(),
        }),
      );
      return { ...conversation, title };
    });
  }
  list(
    userId: string,
    spaceId: string,
    pageId?: string,
    scope: "personal" | "shared" = "personal",
  ): SpaceConversation[] {
    const space = this.spaces.access(userId, spaceId);
    if (pageId !== undefined) {
      this.spaces.page(userId, spaceId, pageId);
    }
    let query = this.query
      .selectFrom("collaboration_space_conversations")
      .selectAll()
      .where("space_id", "=", spaceId);
    if (scope === "personal") {
      query = query.where("owner_id", "=", userId);
    }
    if (pageId !== undefined) {
      query = query.where("page_id", "=", pageId);
    }
    const personalAgentId = this.personalBinding(userId)?.agent_id;
    return executeSync(
      this.db,
      query.orderBy("created_at", "desc").orderBy("id").limit(200),
    ).rows.map((row) =>
      this.projectAccess(userId, space.role, projectConversation(row), personalAgentId, false),
    );
  }
  get(
    userId: string,
    spaceId: string,
    conversationId: string,
    write = false,
    scope: "personal" | "shared" = "personal",
  ): SpaceConversation {
    const space = this.spaces.access(userId, spaceId);
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_conversations")
        .selectAll()
        .where("space_id", "=", spaceId)
        .where("id", "=", conversationId),
    );
    if (!row || (scope === "personal" && row.owner_id !== userId)) {
      throw new ControlPlaneAuthorizationError("Space conversation unavailable");
    }
    const personalAgentId = this.personalBinding(userId)?.agent_id;
    return this.projectAccess(userId, space.role, projectConversation(row), personalAgentId, write);
  }
  bySession(userId: string, sessionKey: string, write = false): SpaceConversation {
    const conversation = this.registered(sessionKey);
    if (!conversation || conversation.ownerId !== userId) {
      throw new ControlPlaneAuthorizationError("Space conversation unavailable");
    }
    const space = this.spaces.access(userId, conversation.spaceId);
    const personalAgentId = this.personalBinding(userId)?.agent_id;
    return this.projectAccess(userId, space.role, conversation, personalAgentId, write);
  }
  // These trusted lookups deliberately retain rows after creator removal/disable; callers gate access.
  registered(sessionKey: string): RegisteredConversation | undefined {
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_conversations")
        .selectAll()
        .where("session_key", "=", sessionKey),
    );
    return row ? projectConversation(row) : undefined;
  }
  byShortId(userId: string, agentId: string, shortId: string): SpaceConversation | null {
    const rows = executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_conversations")
        .select("session_key")
        .where("owner_id", "=", userId)
        .where("agent_id", "=", agentId)
        .where((eb) =>
          eb(eb.fn<string>("replace", ["id", eb.val("-"), eb.val("")]), "like", `${shortId}%`),
        )
        .limit(2),
    ).rows;
    if (rows.length > 1) {
      throw new ControlPlaneStateError("Conversation link is ambiguous; open it through Spaces");
    }
    return rows[0] ? this.bySession(userId, rows[0].session_key) : null;
  }
  owned(spaceId: string, userId: string): RegisteredConversation[] {
    return executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_conversations")
        .selectAll()
        .where("space_id", "=", spaceId)
        .where("owner_id", "=", userId)
        .orderBy("id")
        .limit(200),
    ).rows.map(projectConversation);
  }
  hasInaccessible(userId: string | undefined, agentId?: string): boolean {
    let query = this.query
      .selectFrom("collaboration_space_conversations as conversation")
      .select("conversation.id");
    if (agentId !== undefined) {
      query = query.where("conversation.agent_id", "=", agentId);
    }
    if (userId === undefined) {
      return Boolean(takeFirstSync(this.db, query.limit(1)));
    }
    return Boolean(
      takeFirstSync(
        this.db,
        query
          .leftJoin("collaboration_space_members as member", (join) =>
            join
              .onRef("member.space_id", "=", "conversation.space_id")
              .on("member.user_id", "=", userId),
          )
          .leftJoin(
            "collaboration_space_deletions as deletion",
            "deletion.space_id",
            "conversation.space_id",
          )
          .where((eb) =>
            eb.or([
              eb("conversation.owner_id", "!=", userId),
              eb("member.user_id", "is", null),
              eb("deletion.space_id", "is not", null),
            ]),
          )
          .limit(1),
      ),
    );
  }
}
