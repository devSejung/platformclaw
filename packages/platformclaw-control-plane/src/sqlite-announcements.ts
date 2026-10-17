import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AnnouncementAdministrationSnapshot,
  AnnouncementSnapshot,
  WebAnnouncement,
} from "./announcement-contracts.js";
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
import { ensureWebAnnouncementSchema } from "./sqlite-schema.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type AnnouncementRow = {
  slot: number;
  id: string;
  revision: number;
  title: string;
  body: string;
  kind: "general" | "maintenance";
  maintenance_at: number | null;
  expires_at: number;
  cancelled: number;
};
type Database = Pick<ControlPlaneDatabase, "platform_users" | "control_audit_events"> & {
  web_announcement: AnnouncementRow;
  web_announcement_seen: { user_id: string; revision: number };
};

function announcement(row: AnnouncementRow): WebAnnouncement {
  return {
    id: row.id,
    revision: row.revision,
    title: row.title,
    body: row.body,
    kind: row.kind,
    maintenanceAt: row.maintenance_at,
    expiresAt: row.expires_at,
  };
}

function textField(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ControlPlaneStateError(`Invalid ${label} (maximum ${max} characters)`);
  }
  return value.trim();
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 8.64e15) {
    throw new ControlPlaneStateError("Invalid announcement time");
  }
  return value;
}

/** One current notice; revisions also survive cancellation and expiry. */
export class SqliteAnnouncementStore {
  private readonly query = createSyncKysely<Database>();
  private ready = false;
  constructor(private readonly db: DatabaseSync) {}

  private current() {
    if (!this.ready) {
      ensureWebAnnouncementSchema(this.db);
      this.ready = true;
    }
    return takeFirstSync(
      this.db,
      this.query.selectFrom("web_announcement").selectAll().where("slot", "=", 1),
    );
  }

  snapshot(now: number): AnnouncementSnapshot {
    const row = this.current();
    return {
      revision: row?.revision ?? 0,
      serverNow: now,
      announcement: row && !row.cancelled && row.expires_at > now ? announcement(row) : null,
    };
  }

  administration(actorUserId: string, now: number): AnnouncementAdministrationSnapshot {
    this.requireAdmin(actorUserId);
    const row = this.current();
    return {
      revision: row?.revision ?? 0,
      serverNow: now,
      announcement: row && !row.cancelled && row.expires_at > now ? announcement(row) : null,
      current: row ? { ...announcement(row), cancelled: Boolean(row.cancelled) } : null,
    };
  }

  claimPresentation(userId: string, id: unknown, revision: unknown, now: number): boolean {
    this.current();
    return runImmediateTransaction(this.db, () => {
      const user = takeFirstSync(
        this.db,
        this.query.selectFrom("platform_users").select("status").where("id", "=", userId),
      );
      if (user?.status !== "active") {
        throw new ControlPlaneAuthorizationError("active user required");
      }
      const row = this.current();
      if (
        !row ||
        row.cancelled ||
        row.expires_at <= now ||
        row.kind !== "maintenance" ||
        row.id !== id ||
        row.revision !== revision
      ) {
        return false;
      }
      // Claim once per account/revision, including tabs, devices and BFF restarts.
      const result = executeSync(
        this.db,
        this.query
          .insertInto("web_announcement_seen")
          .values({ user_id: userId, revision: row.revision })
          .onConflict((conflict) =>
            conflict
              .column("user_id")
              .doUpdateSet({ revision: row.revision })
              .where("web_announcement_seen.revision", "<", row.revision),
          ),
      );
      return result.numAffectedRows === 1n;
    });
  }

  private requireAdmin(userId: string) {
    const user = takeFirstSync(
      this.db,
      this.query
        .selectFrom("platform_users")
        .select(["global_role", "status"])
        .where("id", "=", userId),
    );
    if (user?.global_role !== "admin" || user.status !== "active") {
      throw new ControlPlaneAuthorizationError("active administrator required");
    }
  }

  mutate(
    actorUserId: string,
    input: Record<string, unknown>,
    now: number,
  ): AnnouncementAdministrationSnapshot {
    // Ensure DDL before opening the synchronous commit section.
    this.current();
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(actorUserId);
      const previous = this.current();
      if (input.expectedRevision !== (previous?.revision ?? 0)) {
        throw new ControlPlaneConflictError(
          "announcement_revision_conflict",
          "Announcement changed. Reload before editing.",
        );
      }
      const action = input.action;
      if (action !== "publish" && action !== "update" && action !== "cancel") {
        throw new ControlPlaneStateError("Invalid announcement action");
      }
      if (action !== "publish" && (!previous || previous.cancelled)) {
        throw new ControlPlaneStateError("No published announcement to change");
      }
      let row: AnnouncementRow;
      if (action === "cancel" && previous) {
        row = { ...previous, revision: previous.revision + 1, cancelled: 1 };
      } else {
        if (input.kind !== "general" && input.kind !== "maintenance") {
          throw new ControlPlaneStateError("Invalid announcement kind");
        }
        const expiresAt = timestamp(input.expiresAt);
        const maintenanceAt = input.kind === "maintenance" ? timestamp(input.maintenanceAt) : null;
        if (expiresAt <= now || (maintenanceAt !== null && expiresAt <= maintenanceAt)) {
          throw new ControlPlaneStateError("Exposure must end after now and the maintenance time");
        }
        row = {
          slot: 1,
          id: action === "update" && previous ? previous.id : randomUUID(),
          revision: (previous?.revision ?? 0) + 1,
          title: textField(input.title, "title", 160),
          body: textField(input.body, "body", 8_000),
          kind: input.kind,
          maintenance_at: maintenanceAt,
          expires_at: expiresAt,
          cancelled: 0,
        };
      }
      executeSync(
        this.db,
        this.query
          .insertInto("web_announcement")
          .values(row)
          .onConflict((conflict) => conflict.column("slot").doUpdateSet(row)),
      );
      executeSync(
        this.db,
        this.query.insertInto("control_audit_events").values({
          id: randomUUID(),
          actor_user_id: actorUserId,
          event_type: `announcement.${action}`,
          target_type: "web-announcement",
          target_id: row.id,
          created_at: now,
          details_json: JSON.stringify({ revision: row.revision, kind: row.kind }),
        }),
      );
      return this.administration(actorUserId, now);
    });
  }
}
