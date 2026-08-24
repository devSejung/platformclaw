import { randomUUID } from "node:crypto";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import type {
  SkillHubGovernanceJob,
  SkillHubNotification,
  SkillHubStateStore,
} from "./skill-hub-state.js";
import { SqliteControlPlaneSkillHubNamespaceStore } from "./sqlite-store-skill-hub-namespace.js";
import type { SkillHubNotificationRow } from "./sqlite-store-types.js";

function notification(row: SkillHubNotificationRow): SkillHubNotification {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.namespace === null ? {} : { namespace: row.namespace }),
    ...(row.slug === null ? {} : { slug: row.slug }),
    message: row.message,
    createdAt: row.created_at,
    ...(row.read_at === null ? {} : { readAt: row.read_at }),
  };
}

export abstract class SqliteControlPlaneSkillHubOperationsStore extends SqliteControlPlaneSkillHubNamespaceStore {
  async createSkillHubNotification(
    params: Parameters<SkillHubStateStore["createSkillHubNotification"]>[0],
  ) {
    this.ensureSkillHubStateSchema();
    const row: SkillHubNotificationRow = {
      id: randomUUID(),
      user_id: params.userId,
      kind: params.kind,
      namespace: params.namespace ?? null,
      slug: params.slug ?? null,
      message: params.message,
      created_at: params.createdAt,
      read_at: null,
    };
    executeSync(this.db, this.query.insertInto("skill_hub_notifications").values(row));
    return notification(row);
  }

  async listSkillHubNotifications(userId: string, limit: number) {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_notifications")
        .selectAll()
        .where("user_id", "=", userId)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(limit),
    ).rows.map(notification);
  }

  async countUnreadSkillHubNotifications(userId: string): Promise<number> {
    this.ensureSkillHubStateSchema();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_notifications")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("user_id", "=", userId)
        .where("read_at", "is", null),
    );
    return row?.count ?? 0;
  }

  async markSkillHubNotificationsRead(
    params: Parameters<SkillHubStateStore["markSkillHubNotificationsRead"]>[0],
  ): Promise<number> {
    this.ensureSkillHubStateSchema();
    let query = this.query
      .updateTable("skill_hub_notifications")
      .set({ read_at: params.readAt })
      .where("user_id", "=", params.userId)
      .where("read_at", "is", null);
    if (params.ids) {
      if (params.ids.length === 0) {
        return 0;
      }
      query = query.where("id", "in", [...params.ids]);
    }
    return Number(executeSync(this.db, query).numAffectedRows);
  }

  async enqueueSkillHubGovernanceJob(
    params: Parameters<SkillHubStateStore["enqueueSkillHubGovernanceJob"]>[0],
  ): Promise<void> {
    this.ensureSkillHubStateSchema();
    executeSync(
      this.db,
      this.query
        .insertInto("skill_hub_governance_jobs")
        .values({
          namespace: params.namespace,
          slug: params.slug,
          version: params.version,
          owner_user_id: params.ownerUserId,
          state: "pending",
          attempts: 0,
          next_attempt_at: params.createdAt,
          last_error: null,
          updated_at: params.createdAt,
        })
        .onConflict((conflict) => conflict.columns(["namespace", "slug", "version"]).doNothing()),
    );
  }

  async listDueSkillHubGovernanceJobs(
    now: number,
    limit: number,
  ): Promise<SkillHubGovernanceJob[]> {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_governance_jobs")
        .selectAll()
        .where("state", "=", "pending")
        .where("next_attempt_at", "<=", now)
        .orderBy("next_attempt_at")
        .limit(limit),
    ).rows.map((row) =>
      Object.assign(
        {
          namespace: row.namespace,
          slug: row.slug,
          version: row.version,
          ownerUserId: row.owner_user_id,
          state: row.state,
          attempts: row.attempts,
          nextAttemptAt: row.next_attempt_at,
          updatedAt: row.updated_at,
        },
        row.last_error === null ? {} : { lastError: row.last_error },
      ),
    );
  }

  async updateSkillHubGovernanceJob(
    params: Parameters<SkillHubStateStore["updateSkillHubGovernanceJob"]>[0],
  ): Promise<void> {
    this.ensureSkillHubStateSchema();
    executeSync(
      this.db,
      this.query
        .updateTable("skill_hub_governance_jobs")
        .set({
          state: params.state,
          attempts: params.attempts,
          next_attempt_at: params.nextAttemptAt,
          last_error: params.lastError ?? null,
          updated_at: params.updatedAt,
        })
        .where("namespace", "=", params.namespace)
        .where("slug", "=", params.slug)
        .where("version", "=", params.version),
    );
  }
}
