import { randomUUID } from "node:crypto";
import { executeSync, takeFirstSync } from "./kysely-sync.js";
import type { SkillHubNotification, SkillHubNotificationStore } from "./skill-hub-state.js";
import { ensureSkillHubNotificationSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneMcpStore } from "./sqlite-store-mcp.js";
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

export abstract class SqliteControlPlaneSkillHubNotificationStore extends SqliteControlPlaneMcpStore {
  private notificationsReady = false;

  private ensureSkillHubNotifications(): void {
    if (!this.notificationsReady) {
      ensureSkillHubNotificationSchema(this.db);
      this.notificationsReady = true;
    }
  }

  async createSkillHubNotification(
    params: Parameters<SkillHubNotificationStore["createSkillHubNotification"]>[0],
  ) {
    this.ensureSkillHubNotifications();
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
    this.ensureSkillHubNotifications();
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
    this.ensureSkillHubNotifications();
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
    params: Parameters<SkillHubNotificationStore["markSkillHubNotificationsRead"]>[0],
  ): Promise<number> {
    this.ensureSkillHubNotifications();
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
}
