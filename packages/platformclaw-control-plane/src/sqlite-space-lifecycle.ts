import { randomUUID } from "node:crypto";
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
import type { Space, SpaceRole } from "./space-contracts.js";
import type { SpaceConversationRow, SpacePageRow, SpaceRow } from "./sqlite-schema-spaces.js";
import type { SqliteSpaceStore } from "./sqlite-spaces.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type Deletion = {
  space_id: string;
  user_id: string;
  name: string;
  agent_id: string;
  revision: number;
  creator_id: string;
  request_id: string;
  owner_ids_json: string;
  state: "deleting" | "deleted";
  created_at: number;
};
type Database = Pick<ControlPlaneDatabase, "platform_users" | "control_audit_events"> & {
  collaboration_spaces: SpaceRow;
  collaboration_space_members: { space_id: string; user_id: string; role: SpaceRole };
  collaboration_space_pages: SpacePageRow;
  collaboration_space_conversations: SpaceConversationRow;
  collaboration_space_deletions: Deletion;
  collaboration_space_departures: {
    space_id: string;
    user_id: string;
    revision: number;
    pending: number;
  };
  collaboration_space_runs: { space_id: string; user_id: string; state: string };
};

/** Durable deletion/departure receipts outlive access, so interrupted cleanup is retryable. */
export class SqliteSpaceLifecycleStore {
  private readonly query = createSyncKysely<Database>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly spaces: Pick<SqliteSpaceStore, "access" | "members">,
  ) {}

  deleting(spaceId: string): boolean {
    return Boolean(
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_deletions")
          .select("space_id")
          .where("space_id", "=", spaceId),
      ),
    );
  }

  deletedRequest(userId: string, requestId: string): boolean {
    return Boolean(
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_deletions")
          .select("space_id")
          .where("creator_id", "=", userId)
          .where("request_id", "=", requestId),
      ),
    );
  }

  pending(userId: string): Space[] {
    return executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_deletions as deletion")
        .innerJoin("collaboration_space_members as member", "member.space_id", "deletion.space_id")
        .selectAll("deletion")
        .where("member.user_id", "=", userId)
        .where("member.role", "=", "owner")
        .where("deletion.state", "=", "deleting")
        .orderBy("created_at")
        .limit(100),
    ).rows.map((row) => ({
      id: row.space_id,
      name: row.name,
      agentId: row.agent_id,
      revision: row.revision,
      role: "owner",
      deleting: true,
    }));
  }

  pendingDepartures(userId: string): Space[] {
    return executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_departures as departure")
        .innerJoin("collaboration_spaces as space", "space.id", "departure.space_id")
        .leftJoin("collaboration_space_members as member", (join) =>
          join.onRef("member.space_id", "=", "space.id").on("member.user_id", "=", userId),
        )
        .leftJoin("collaboration_space_deletions as deletion", "deletion.space_id", "space.id")
        .select(["space.id", "space.name", "space.agent_id", "departure.revision"])
        .where("departure.user_id", "=", userId)
        .where("departure.pending", "=", 1)
        .where("member.user_id", "is", null)
        .where("deletion.space_id", "is", null)
        .orderBy("space.id")
        .limit(100),
    ).rows.map((row) => ({
      id: row.id,
      name: row.name,
      agentId: row.agent_id,
      revision: row.revision,
      role: "viewer",
      leaving: true,
    }));
  }

  finishLeave(userId: string, spaceId: string, revision: number) {
    executeSync(
      this.db,
      this.query
        .updateTable("collaboration_space_departures")
        .set({ pending: 0 })
        .where("space_id", "=", spaceId)
        .where("user_id", "=", userId)
        .where("revision", "=", revision),
    );
  }

  private activeUser(userId: string) {
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
      throw new ControlPlaneAuthorizationError("Space unavailable");
    }
  }

  beginDelete(userId: string, spaceId: string, revision: number, confirmName: string): Deletion {
    return runImmediateTransaction(this.db, () => {
      this.activeUser(userId);
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_deletions")
          .selectAll()
          .where("space_id", "=", spaceId),
      );
      if (prior) {
        const owner =
          prior.state === "deleting" &&
          takeFirstSync(
            this.db,
            this.query
              .selectFrom("collaboration_space_members")
              .select("user_id")
              .where("space_id", "=", spaceId)
              .where("user_id", "=", userId)
              .where("role", "=", "owner"),
          );
        if (
          (!owner && !(JSON.parse(prior.owner_ids_json) as string[]).includes(userId)) ||
          prior.revision !== revision ||
          (prior.state !== "deleted" && prior.name !== confirmName)
        ) {
          throw new ControlPlaneAuthorizationError("Space deletion unavailable");
        }
        return prior;
      }
      const space = this.spaces.access(userId, spaceId, "owner");
      if (space.revision !== revision) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Space changed; reload before deleting",
        );
      }
      if (confirmName !== space.name) {
        throw new ControlPlaneStateError(
          "Enter the exact Space name to confirm permanent deletion",
        );
      }
      const original = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_spaces")
          .select(["creator_id", "request_id"])
          .where("id", "=", spaceId),
      )!;
      const row: Deletion = {
        ...original,
        owner_ids_json: JSON.stringify(
          this.spaces
            .members(userId, spaceId)
            .filter((member) => member.role === "owner")
            .map((member) => member.userId),
        ),
        space_id: spaceId,
        user_id: userId,
        name: space.name,
        agent_id: space.agentId,
        revision,
        state: "deleting",
        created_at: Date.now(),
      };
      executeSync(this.db, this.query.insertInto("collaboration_space_deletions").values(row));
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_spaces")
          .set({ revision: revision + 1 })
          .where("id", "=", spaceId),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_space_runs")
          .set({ state: "revoked" })
          .where("space_id", "=", spaceId)
          .where("state", "=", "active"),
      );
      this.audit(userId, spaceId, "space.deletion.started");
      return row;
    });
  }

  deletionSessions(spaceId: string, agentId: string) {
    const conversations = executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_conversations")
        .select(["agent_id as agentId", "session_key as sessionKey"])
        .where("space_id", "=", spaceId)
        .orderBy("id"),
    ).rows;
    const pages = executeSync(
      this.db,
      this.query
        .selectFrom("collaboration_space_pages")
        .select("id")
        .where("space_id", "=", spaceId)
        .orderBy("id"),
    ).rows;
    return [
      ...conversations,
      ...pages.map((page) => ({ agentId, sessionKey: `agent:${agentId}:space:${page.id}` })),
    ];
  }

  finishDelete(userId: string, spaceId: string) {
    runImmediateTransaction(this.db, () => {
      // All native cleanup must finish before registry removal; otherwise a retry loses its targets.
      executeSync(this.db, this.query.deleteFrom("collaboration_spaces").where("id", "=", spaceId));
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_space_deletions")
          .set({ state: "deleted", name: "", user_id: userId })
          .where("space_id", "=", spaceId),
      );
      this.audit(userId, spaceId, "space.deleted");
    });
  }

  setMember(
    userId: string,
    spaceId: string,
    memberId: string,
    role: SpaceRole | null,
    revision: number,
  ) {
    this.spaces.access(userId, spaceId, "owner");
    if (role !== null && !["viewer", "editor", "owner"].includes(role)) {
      throw new ControlPlaneStateError("Invalid Space role");
    }
    return runImmediateTransaction(this.db, () => {
      const space = this.spaces.access(userId, spaceId, "owner");
      if (space.revision !== revision) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Space changed; reload before retrying",
        );
      }
      // Disabled employees cannot receive grants, but their existing membership
      // must remain removable so reactivation cannot restore revoked access.
      if (role !== null) {
        this.activeUser(memberId);
      }
      // A leave owns cancellation until its durable receipt completes. Reauthorizing
      // this member earlier would let a delayed full-session abort hit their new turn.
      if (
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("collaboration_space_departures")
            .select("user_id")
            .where("space_id", "=", spaceId)
            .where("user_id", "=", memberId)
            .where("pending", "=", 1),
        )
      ) {
        throw new ControlPlaneStateError(
          "This member is still leaving; finish their cleanup before changing membership",
        );
      }
      const members = this.spaces.members(userId, spaceId);
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
  leave(
    userId: string,
    spaceId: string,
    revision: number,
  ): { state: "left" } | { state: "leaving"; space: Pick<Space, "id" | "agentId"> } {
    return runImmediateTransaction(this.db, () => {
      this.activeUser(userId);
      const member = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_members")
          .select("role")
          .where("space_id", "=", spaceId)
          .where("user_id", "=", userId),
      );
      const receipt = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_space_departures")
          .select(["revision", "pending"])
          .where("space_id", "=", spaceId)
          .where("user_id", "=", userId),
      );
      const row = takeFirstSync(
        this.db,
        this.query
          .selectFrom("collaboration_spaces")
          .select(["id", "agent_id"])
          .where("id", "=", spaceId),
      );
      if (!member && receipt?.revision === revision && row && !this.deleting(spaceId)) {
        return receipt.pending
          ? { state: "leaving", space: { id: row.id, agentId: row.agent_id } }
          : { state: "left" };
      }
      const space = this.spaces.access(userId, spaceId);
      if (space.revision !== revision) {
        throw new ControlPlaneConflictError(
          "space_changed",
          "Space changed; reload before leaving",
        );
      }
      if (
        space.role === "owner" &&
        this.spaces.members(userId, spaceId).filter((candidate) => candidate.role === "owner")
          .length === 1
      ) {
        throw new ControlPlaneStateError("Assign another active Space owner before leaving");
      }
      executeSync(
        this.db,
        this.query
          .deleteFrom("collaboration_space_members")
          .where("space_id", "=", spaceId)
          .where("user_id", "=", userId),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_spaces")
          .set({ revision: revision + 1 })
          .where("id", "=", spaceId),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("collaboration_space_runs")
          .set({ state: "revoked" })
          .where("space_id", "=", spaceId)
          .where("user_id", "=", userId)
          .where("state", "=", "active"),
      );
      executeSync(
        this.db,
        this.query
          .insertInto("collaboration_space_departures")
          .values({ space_id: spaceId, user_id: userId, revision, pending: 1 })
          .onConflict((oc) =>
            oc.columns(["space_id", "user_id"]).doUpdateSet({ revision, pending: 1 }),
          ),
      );
      this.audit(userId, spaceId, "space.member.left");
      return { state: "leaving", space };
    });
  }

  private audit(
    userId: string,
    spaceId: string,
    event: string,
    details: Record<string, unknown> = {},
  ) {
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
}
