import { sql } from "kysely";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { executeSync, runImmediateTransaction } from "./kysely-sync.js";
import type { SkillHubCatalogStore, SkillHubCatalogHistory } from "./skill-hub-catalog-state.js";
import { ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteSkillHubCatalogArtifacts } from "./sqlite-skill-hub-catalog-artifacts.js";
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const HISTORY_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
export class SqliteSkillHubCatalogLifecycle extends SqliteSkillHubCatalogArtifacts {
  async trash(params: Parameters<SkillHubCatalogStore["trash"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () =>
      this.mutate(params, { deleted_at: params.now, pending_transfer_user_id: null }, "deleted"),
    );
  }

  async restore(params: Parameters<SkillHubCatalogStore["restore"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const row = this.row(params.skillId);
      if (row.current_version === null) {
        throw new ControlPlaneStateError("This upload never completed; start a new publication");
      }
      if (
        row.deleted_at === null ||
        row.purged_at !== null ||
        row.purge_pending ||
        row.deleted_at + TRASH_RETENTION_MS <= params.now
      ) {
        throw new ControlPlaneStateError("This skill is no longer available for restoration");
      }
      // Recipients remain recorded. Missing or archived organizations never become Public.
      return this.mutate(params, { deleted_at: null }, "restored", true);
    });
  }

  async listHistory(
    params: Parameters<SkillHubCatalogStore["listHistory"]>[0],
  ): Promise<SkillHubCatalogHistory[]> {
    this.ensure();
    const row = this.row(params.skillId);
    const actor = this.user(params.actorUserId);
    const management = actor.global_role === "admin" || row.owner_user_id === actor.id;
    if (!management && !this.access(row, actor.id)) {
      throw new ControlPlaneAuthorizationError("Skill Hub history unavailable");
    }
    let query = this.query
      .selectFrom("skill_hub_catalog_history")
      .selectAll()
      .where("skill_id", "=", row.id);
    if (!management) {
      query = query.where("management", "=", 0);
    }
    return executeSync(
      this.db,
      query
        .orderBy("created_at", "desc")
        .orderBy("id")
        .limit(Math.max(1, Math.min(params.limit ?? 100, 200))),
    ).rows.map((event) => ({
      id: event.id,
      skillId: event.skill_id,
      actorUserId: event.actor_user_id,
      actorName: event.actor_name,
      action: event.action,
      version: event.version,
      management: event.management === 1,
      details: JSON.parse(event.details_json) as Record<string, unknown>,
      createdAt: event.created_at,
    }));
  }

  async listPurgeDue(now: number, limit = 20) {
    this.ensure();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog")
        .selectAll()
        .where("deleted_at", "<=", now - TRASH_RETENTION_MS)
        .where("purged_at", "is", null)
        .orderBy("deleted_at")
        .limit(limit),
    ).rows.map((row) => this.entry(row));
  }

  async claimPurgeDue(now: number, limit = 20) {
    this.ensure();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ControlPlaneStateError("Invalid purge maintenance limit");
    }
    return runImmediateTransaction(this.db, () => {
      const cursor = this.maintenanceCursor("purge");
      const query = this.query
        .selectFrom("skill_hub_catalog")
        .selectAll()
        .where("deleted_at", "<=", now - TRASH_RETENTION_MS)
        .where("purged_at", "is", null)
        .orderBy("id");
      const rows = executeSync(
        this.db,
        (cursor === null ? query : query.where("id", ">", cursor)).limit(limit),
      ).rows;
      if (cursor !== null && rows.length < limit) {
        rows.push(
          ...executeSync(this.db, query.where("id", "<=", cursor).limit(limit - rows.length)).rows,
        );
      }
      this.advanceMaintenanceCursor("purge", rows.at(-1)?.id);
      return rows.map((row) => this.entry(row));
    });
  }

  async beginPurge(params: Parameters<SkillHubCatalogStore["beginPurge"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const row = this.row(params.skillId);
      this.revision(row, params.expectedRevision);
      if (
        row.deleted_at === null ||
        row.deleted_at > params.now - TRASH_RETENTION_MS ||
        row.purged_at !== null
      ) {
        throw new ControlPlaneStateError("This skill is not due for permanent deletion");
      }
      if (!row.purge_pending) {
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_catalog")
            .set({ purge_pending: 1, revision: row.revision + 1, updated_at: params.now })
            .where("id", "=", row.id),
        );
      }
      return this.entry(this.row(row.id));
    });
  }

  async finishPurge(params: Parameters<SkillHubCatalogStore["finishPurge"]>[0]) {
    this.ensure();
    ensureSkillHubStateSchema(this.db);
    runImmediateTransaction(this.db, () => {
      const row = this.row(params.skillId);
      if (row.purged_at !== null) {
        return;
      }
      if (!row.purge_pending || row.deleted_at === null) {
        throw new ControlPlaneStateError("Permanent deletion has not been reserved");
      }
      executeSync(
        this.db,
        this.query.deleteFrom("skill_hub_catalog_icons").where("skill_id", "=", row.id),
      );
      executeSync(
        this.db,
        this.query.deleteFrom("skill_hub_catalog_recipients").where("skill_id", "=", row.id),
      );
      const coordinates = executeSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog_coordinates")
          .select(["namespace", "slug"])
          .where("skill_id", "=", row.id),
      ).rows;
      for (const coordinateRow of coordinates) {
        // Retired tables are cutover inputs only. Erase their content copies with
        // the original artifact instead of retaining old metadata through another path.
        executeSync(
          this.db,
          this.query
            .deleteFrom("skill_hub_skill_ownership")
            .where("namespace", "=", coordinateRow.namespace)
            .where("slug", "=", coordinateRow.slug),
        );
        executeSync(
          this.db,
          this.query
            .deleteFrom("skill_hub_edit_intents")
            .where("slug", "=", coordinateRow.slug)
            .where((expression) =>
              expression.or([
                expression("namespace", "=", coordinateRow.namespace),
                expression("target_namespace", "=", coordinateRow.namespace),
              ]),
            ),
        );
        executeSync(
          this.db,
          this.query
            .deleteFrom("skill_hub_notifications")
            .where("namespace", "=", coordinateRow.namespace)
            .where("slug", "=", coordinateRow.slug),
        );
        const coordinate = `${coordinateRow.namespace}/${coordinateRow.slug}`;
        executeSync(
          this.db,
          this.query
            .deleteFrom("control_audit_events")
            .where("target_type", "=", "skill-hub-skill")
            .where((expression) =>
              expression.or([
                expression("target_id", "=", coordinate),
                sql<boolean>`substr(target_id, 1, ${coordinate.length + 1}) = ${`${coordinate}@`}`,
              ]),
            ),
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog_history")
          .set({ details_json: "{}", management: 1 })
          .where("skill_id", "=", row.id),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog")
          .set({
            display_name: "",
            summary: "",
            tags_json: "[]",
            sharing_mode: "PRIVATE",
            current_version: null,
            pending_transfer_user_id: null,
            purge_pending: 0,
            purged_at: params.now,
            revision: row.revision + 1,
            updated_at: params.now,
          })
          .where("id", "=", row.id),
      );
      this.history(row, null, "permanently-deleted", params.now, {}, true);
    });
  }

  async pruneHistory(now: number) {
    this.ensure();
    return runImmediateTransaction(this.db, () =>
      Number(
        executeSync(
          this.db,
          this.query
            .deleteFrom("skill_hub_catalog")
            .where("purged_at", "<=", now - HISTORY_RETENTION_MS),
        ).numAffectedRows,
      ),
    );
  }
}
