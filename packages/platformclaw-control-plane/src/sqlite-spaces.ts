import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
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
import type { Space, SpacePage, SpaceRole } from "./space-contracts.js";
import { ensureSpaceSchema, type SpaceRow, type SpacePageRow } from "./sqlite-schema-spaces.js";
import { SqliteSpaceConversationStore } from "./sqlite-space-conversations.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type Database = Pick<
  ControlPlaneDatabase,
  "platform_users" | "agent_bindings" | "control_audit_events"
> & {
  collaboration_space_runs: {
    run_id: string;
    space_id: string;
    page_id: string;
    user_id: string;
    content_hash: string;
    state: "active" | "revoked" | "finished" | "failed";
    created_at: number;
  };
  collaboration_spaces: SpaceRow;
  collaboration_space_members: { space_id: string; user_id: string; role: SpaceRole };
  collaboration_space_pages: SpacePageRow;
};
export function spaceText(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) {
    throw new ControlPlaneStateError(`Invalid ${label}`);
  }
  return value;
}
const rank = { viewer: 1, editor: 2, owner: 3 };
export class SqliteSpaceStore {
  private readonly query = createSyncKysely<Database>();
  private readonly conversationStore: SqliteSpaceConversationStore;
  private ready = false;
  constructor(private readonly db: DatabaseSync) {
    this.conversationStore = new SqliteSpaceConversationStore(db, this);
  }
  private ensure() {
    if (!this.ready) {
      ensureSpaceSchema(this.db);
      this.ready = true;
    }
  }
  private unavailable(): never {
    throw new ControlPlaneAuthorizationError("Space unavailable");
  }
  private activeUser(userId: string) {
    this.ensure();
    if (
      !takeFirstSync(
        this.db,
        this.query
          .selectFrom("platform_users")
          .select("id")
          .where("id", "=", userId)
          .where("status", "=", "active"),
      )
    ) {
      this.unavailable();
    }
  }
  access(userId: string, spaceId: string, minimum: SpaceRole = "viewer"): Space {
    this.activeUser(userId);
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("collaboration_spaces as space")
        .innerJoin("collaboration_space_members as member", "member.space_id", "space.id")
        .select(["space.id", "space.name", "space.agent_id", "space.revision", "member.role"])
        .where("space.id", "=", spaceId)
        .where("member.user_id", "=", userId),
    );
    if (!row || rank[row.role] < rank[minimum]) {
      this.unavailable();
    }
    return {
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      revision: row.revision,
      role: row.role,
    };
  }
  list(userId: string): Space[] {
    this.activeUser(userId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_members")
        .select("space_id")
        .where("user_id", "=", userId)
        .orderBy("space_id")
        .limit(100),
    ).rows.map((row) => this.access(userId, row.space_id));
  }
  create(userId: string, name: string, requestId: string): Space {
    this.activeUser(userId);
    spaceText(name, "Space name", 160);
    spaceText(requestId, "request id", 128);
    return runImmediateTransaction(this.db, () => {
      this.activeUser(userId);
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_spaces")
          .selectAll()
          .where("creator_id", "=", userId)
          .where("request_id", "=", requestId),
      );
      if (prior) {
        if (prior.name !== name) {
          this.conflict();
        }
        return this.access(userId, prior.id);
      }
      const count = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_spaces")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("creator_id", "=", userId),
      )!.count;
      if (count >= 100) {
        throw new ControlPlaneStateError("Space limit reached");
      }
      const id = randomUUID();
      executeSync(
        this.db,
        this.query.insertInto("collaboration_spaces").values({
          id,
          name,
          agent_id: `space-${id}`,
          creator_id: userId,
          request_id: requestId,
          revision: 1,
          created_at: Date.now(),
        }),
      );
      executeSync(
        this.db,
        this.query
          .insertInto("collaboration_space_members")
          .values({ space_id: id, user_id: userId, role: "owner" }),
      );
      this.audit(userId, id, "space.created", {});
      return this.access(userId, id);
    });
  }
  private conflict(): never {
    throw new ControlPlaneConflictError("space_changed", "Space changed; reload before retrying");
  }
  private audit(userId: string, spaceId: string, event: string, details: Record<string, unknown>) {
    executeSync(
      this.db,
      this.query.insertInto("control_audit_events").values({
        id: randomUUID(),
        actor_user_id: userId,
        event_type: event,
        target_type: "space",
        target_id: spaceId,
        created_at: Date.now(),
        details_json: JSON.stringify(details),
      }),
    );
  }
  members(userId: string, spaceId: string) {
    this.access(userId, spaceId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_members as member")
        .innerJoin("platform_users as employee", "employee.id", "member.user_id")
        .select([
          "employee.id as userId",
          "employee.account_id as accountId",
          "employee.display_name as displayName",
          "member.role",
        ])
        .where("member.space_id", "=", spaceId)
        .where("employee.status", "=", "active")
        .orderBy("employee.account_id")
        .limit(200),
    ).rows.map((row) => Object.assign({}, row, { displayName: row.displayName || row.accountId }));
  }
  people(userId: string, spaceId: string, query: string) {
    this.access(userId, spaceId, "owner");
    spaceText(query, "employee search", 160);
    // Literal substring matching prevents wildcard-only queries from enumerating the directory.
    const search = query.trim();
    return executeSync(
      this.db,
      this.query
        .selectFrom("platform_users as employee")
        .select([
          "employee.id as userId",
          "employee.account_id as accountId",
          "employee.display_name as displayName",
        ])
        .where("employee.status", "=", "active")
        .where((eb) =>
          eb.or([
            eb(
              eb.fn<number>("instr", [
                eb.fn("lower", ["employee.account_id"]),
                eb.fn("lower", [eb.val(search)]),
              ]),
              ">",
              0,
            ),
            eb(
              eb.fn<number>("instr", [
                eb.fn("lower", ["employee.display_name"]),
                eb.fn("lower", [eb.val(search)]),
              ]),
              ">",
              0,
            ),
          ]),
        )
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("collaboration_space_members")
                .select("user_id")
                .whereRef("user_id", "=", "employee.id")
                .where("space_id", "=", spaceId),
            ),
          ),
        )
        .orderBy("employee.account_id")
        .orderBy("employee.id")
        .limit(20),
    ).rows.map((row) => Object.assign({}, row, { displayName: row.displayName || row.accountId }));
  }

  setMember(
    userId: string,
    spaceId: string,
    memberId: string,
    role: SpaceRole | null,
    revision: number,
  ) {
    this.access(userId, spaceId, "owner");
    if (role !== null && !Object.hasOwn(rank, role)) {
      throw new ControlPlaneStateError("Invalid Space role");
    }
    return runImmediateTransaction(this.db, () => {
      const space = this.access(userId, spaceId, "owner");
      if (space.revision !== revision) {
        this.conflict();
      }
      this.activeUser(memberId);
      const members = this.members(userId, spaceId);
      if (
        role !== "owner" &&
        members.find((m) => m.userId === memberId)?.role === "owner" &&
        members.filter((m) => m.role === "owner").length === 1
      ) {
        throw new ControlPlaneStateError("Keep at least one active Space owner");
      }
      if (role) {
        if (!members.some((m) => m.userId === memberId) && members.length >= 200) {
          throw new ControlPlaneStateError("Space member limit reached");
        }
        executeSync(
          this.db,
          this.query
            .insertInto("collaboration_space_members")
            .values({ space_id: spaceId, user_id: memberId, role })
            .onConflict((oc) => oc.columns(["space_id", "user_id"]).doUpdateSet({ role })),
        );
      } else {
        executeSync(
          this.db,
          this.query
            .deleteFrom("collaboration_space_members")
            .where("space_id", "=", spaceId)
            .where("user_id", "=", memberId),
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_spaces")
          .set({ revision: space.revision + 1 })
          .where("id", "=", spaceId),
      );
      if (role === null || role === "viewer") {
        executeSync(
          this.db,
          this.query
            .updateTable("collaboration_space_runs")
            .set({ state: "revoked" })
            .where("space_id", "=", spaceId)
            .where("user_id", "=", memberId)
            .where("state", "=", "active"),
        );
      }
      this.audit(userId, spaceId, "space.member.changed", { userId: memberId, role });
      return { updated: true };
    });
  }
  private projectPage(row: SpacePageRow): SpacePage {
    return {
      id: row.id,
      spaceId: row.space_id,
      parentId: row.parent_id,
      title: row.title,
      body: row.body,
      revision: row.revision,
      createdBy: row.creator_id,
      updatedAt: row.updated_at,
    };
  }
  pages(userId: string, spaceId: string) {
    this.access(userId, spaceId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_pages")
        .selectAll()
        .where("space_id", "=", spaceId)
        .orderBy("updated_at", "desc")
        .limit(200),
    ).rows.map((row) => this.projectPage(row));
  }
  page(userId: string, spaceId: string, pageId: string, role: SpaceRole = "viewer"): SpacePage {
    this.access(userId, spaceId, role);
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_pages")
        .selectAll()
        .where("id", "=", pageId)
        .where("space_id", "=", spaceId),
    );
    if (!row) {
      this.unavailable();
    }
    return this.projectPage(row);
  }
  createPage(
    userId: string,
    spaceId: string,
    params: { parentId?: string; title: string; body: string; requestId: string },
  ) {
    this.access(userId, spaceId, "editor");
    spaceText(params.title, "page title", 240);
    spaceText(params.body, "page body", 32000, true);
    spaceText(params.requestId, "request id", 128);
    return runImmediateTransaction(this.db, () => {
      this.access(userId, spaceId, "editor");
      if (params.parentId) {
        let parent: SpacePage | undefined = this.page(userId, spaceId, params.parentId);
        let depth = 0;
        while (parent) {
          if (++depth >= 20) {
            throw new ControlPlaneStateError("Page nesting limit reached; create a sibling issue");
          }
          parent = parent.parentId ? this.page(userId, spaceId, parent.parentId) : undefined;
        }
      }
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_pages")
          .selectAll()
          .where("creator_id", "=", userId)
          .where("request_id", "=", params.requestId),
      );
      if (prior) {
        if (
          prior.space_id !== spaceId ||
          prior.title !== params.title ||
          prior.body !== params.body ||
          prior.parent_id !== (params.parentId ?? null)
        ) {
          this.conflict();
        }
        return this.projectPage(prior);
      }
      if (this.pages(userId, spaceId).length >= 200) {
        throw new ControlPlaneStateError("Space page limit reached");
      }
      const row: SpacePageRow = {
        id: randomUUID(),
        space_id: spaceId,
        parent_id: params.parentId ?? null,
        title: params.title,
        body: params.body,
        creator_id: userId,
        request_id: params.requestId,
        revision: 1,
        updated_at: Date.now(),
      };
      executeSync(this.db, this.query.insertInto("collaboration_space_pages").values(row));
      this.audit(userId, spaceId, "space.page.created", { pageId: row.id });
      return this.projectPage(row);
    });
  }
  savePage(
    userId: string,
    spaceId: string,
    pageId: string,
    title: string,
    body: string,
    revision: number,
  ) {
    this.page(userId, spaceId, pageId, "editor");
    spaceText(title, "page title", 240);
    spaceText(body, "page body", 32000, true);
    return runImmediateTransaction(this.db, () => {
      const page = this.page(userId, spaceId, pageId, "editor");
      if (page.revision !== revision) {
        this.conflict();
      }
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_space_pages")
          .set({ title, body, revision: revision + 1, updated_at: Date.now() })
          .where("id", "=", pageId),
      );
      this.audit(userId, spaceId, "space.page.saved", { pageId, revision: revision + 1 });
      return this.page(userId, spaceId, pageId);
    });
  }
  userForAgent(agentId: string): string {
    this.ensure();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("agent_bindings")
        .select("user_id")
        .where("agent_id", "=", agentId)
        .where("kind", "=", "personal")
        .where("state", "=", "active"),
    );
    if (!row?.user_id) {
      this.unavailable();
    }
    this.activeUser(row.user_id);
    return row.user_id;
  }
  personalAgentOwner(agentId: string): string | undefined {
    this.ensure();
    return (
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .select("user_id")
          .where("agent_id", "=", agentId)
          .where("kind", "=", "personal"),
      )?.user_id ?? undefined
    );
  }
  spaceForAgent(agentId: string): string | undefined {
    this.ensure();
    return takeFirstSync(
      this.db,
      this.query.selectFrom("collaboration_spaces").select("id").where("agent_id", "=", agentId),
    )?.id;
  }
  createConversation(
    userId: string,
    spaceId: string,
    params: { pageId: string; title: string; requestId: string },
  ) {
    spaceText(params.pageId, "page id", 128);
    spaceText(params.title, "conversation title", 240);
    spaceText(params.requestId, "request id", 128);
    return this.conversationStore.create(userId, spaceId, params);
  }
  conversations(userId: string, spaceId: string, pageId?: string) {
    return this.conversationStore.list(userId, spaceId, pageId);
  }
  sharedConversations(userId: string, spaceId: string, pageId?: string) {
    return this.conversationStore.list(userId, spaceId, pageId, "shared");
  }
  conversation(userId: string, spaceId: string, conversationId: string, write = false) {
    return this.conversationStore.get(userId, spaceId, conversationId, write);
  }
  sharedConversation(userId: string, spaceId: string, conversationId: string) {
    return this.conversationStore.get(userId, spaceId, conversationId, false, "shared");
  }
  conversationForSession(userId: string, sessionKey: string, write = false) {
    this.ensure();
    return this.conversationStore.bySession(userId, sessionKey, write);
  }
  registeredConversation(sessionKey: string) {
    this.ensure();
    return this.conversationStore.registered(sessionKey);
  }
  ownedConversations(spaceId: string, userId: string) {
    this.ensure();
    return this.conversationStore.owned(spaceId, userId);
  }
  hasInaccessibleConversations(userId: string | undefined, agentId?: string) {
    this.ensure();
    return this.conversationStore.hasInaccessible(userId, agentId);
  }
  agentScope(agentId: string) {
    this.ensure();
    const space = takeFirstSync(
      this.db,
      this.query.selectFrom("collaboration_spaces").selectAll().where("agent_id", "=", agentId),
    );
    if (!space) {
      this.unavailable();
    }
    const pages = executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_pages")
        .selectAll()
        .where("space_id", "=", space.id)
        .orderBy("updated_at", "desc")
        .limit(200),
    ).rows.map((row) => this.projectPage(row));
    return { space: { id: space.id, name: space.name, agentId: space.agent_id }, pages };
  }

  beginRun(userId: string, spaceId: string, pageId: string, runId: string, message: string) {
    this.page(userId, spaceId, pageId, "editor");
    const digest = createHash("sha256").update(message).digest("hex");
    return runImmediateTransaction(this.db, () => {
      this.page(userId, spaceId, pageId, "editor");
      const prior = takeFirstSync(
        this.db,
        this.query.selectFrom("collaboration_space_runs").selectAll().where("run_id", "=", runId),
      );
      if (prior) {
        if (
          prior.user_id !== userId ||
          prior.page_id !== pageId ||
          prior.content_hash !== digest ||
          prior.state === "revoked"
        ) {
          this.conflict();
        }
        if (prior.state !== "failed") {
          return prior.state === "finished";
        }
      }
      const count = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_runs")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("space_id", "=", spaceId)
          .where("state", "=", "active"),
      )!.count;
      if (count >= 200) {
        throw new ControlPlaneStateError("Space has too many pending messages; wait and retry");
      }
      if (prior) {
        executeSync(
          this.db,
          this.query
            .updateTable("collaboration_space_runs")
            .set({ state: "active" })
            .where("run_id", "=", runId),
        );
        return false;
      }
      executeSync(
        this.db,
        this.query.insertInto("collaboration_space_runs").values({
          run_id: runId,
          space_id: spaceId,
          page_id: pageId,
          user_id: userId,
          content_hash: digest,
          state: "active",
          created_at: Date.now(),
        }),
      );
      return false;
    });
  }
  assertRun(agentId: string, runId: string | undefined, pageId?: string) {
    this.ensure();
    const spaceId = this.spaceForAgent(agentId);
    const row = runId
      ? takeFirstSync(
          this.db,
          this.query.selectFrom("collaboration_space_runs").selectAll().where("run_id", "=", runId),
        )
      : undefined;
    if (
      !row ||
      row.space_id !== spaceId ||
      row.state !== "active" ||
      (pageId && row.page_id !== pageId)
    ) {
      this.unavailable();
    }
    this.page(row.user_id, row.space_id, row.page_id, "editor");
  }
  revokedRuns(spaceId: string, userId: string, afterRunId?: string) {
    this.ensure();
    let query = this.query
      .selectFrom("collaboration_space_runs")
      .select(["run_id", "page_id"])
      .where("space_id", "=", spaceId)
      .where("user_id", "=", userId)
      .where("state", "=", "revoked");
    if (afterRunId !== undefined) {
      query = query.where("run_id", ">", afterRunId);
    }
    return executeSync(this.db, query.orderBy("run_id").limit(200)).rows;
  }
  finishRun(runId: string, pageId?: string) {
    this.ensure();
    let update = this.query
      .updateTable("collaboration_space_runs")
      .set({ state: "finished" })
      .where("run_id", "=", runId)
      .where("state", "in", ["active", "revoked"]);
    if (pageId) {
      update = update.where("page_id", "=", pageId);
    }
    executeSync(this.db, update);
  }
  hasConversation(pageId: string): boolean {
    this.ensure();
    return Boolean(
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_runs")
          .select("run_id")
          .where("page_id", "=", pageId)
          .limit(1),
      ),
    );
  }
  failRun(runId: string) {
    this.ensure();
    executeSync(
      this.db,
      this.query
        .updateTable("collaboration_space_runs")
        .set({ state: "failed" })
        .where("run_id", "=", runId)
        .where("state", "=", "active"),
    );
  }
}
