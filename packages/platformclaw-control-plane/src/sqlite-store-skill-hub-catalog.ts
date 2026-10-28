import { sql } from "kysely";
import { ControlPlaneAuthorizationError, ControlPlaneStateError } from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import type { SkillHubCatalogStore } from "./skill-hub-catalog-state.js";
import type { SkillHubCatalogRow } from "./sqlite-schema-skill-hub-catalog.js";
import { ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteSkillHubCatalogLifecycle } from "./sqlite-skill-hub-catalog-lifecycle.js";
export class SqliteSkillHubCatalogStore
  extends SqliteSkillHubCatalogLifecycle
  implements SkillHubCatalogStore
{
  async updateMetadata(params: Parameters<SkillHubCatalogStore["updateMetadata"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const row = this.row(params.skillId);
      this.manager(row, params.actorUserId);
      const reason = this.administratorReason(row, params.actorUserId, params.reason);
      this.available(row);
      this.revision(row, params.expectedRevision);
      this.noPublication(row.id);
      if (
        (params.displayName !== undefined &&
          (!params.displayName.trim() || params.displayName.length > 200)) ||
        (params.summary !== undefined && params.summary.length > 4_000)
      ) {
        throw new ControlPlaneStateError("Invalid Skill Hub name or description");
      }
      const tags = params.tags?.map((tag) => tag.trim());
      if (tags && (tags.length > 5 || tags.some((tag) => !tag || Array.from(tag).length > 32))) {
        throw new ControlPlaneStateError("Use up to five tags, each containing 1–32 characters");
      }
      if (params.sharing) {
        this.setSharing(row.id, params.sharing);
      }
      if (params.icon !== undefined) {
        executeSync(
          this.db,
          this.query.deleteFrom("skill_hub_catalog_icons").where("skill_id", "=", row.id),
        );
        if (params.icon) {
          if (
            params.icon.bytes.byteLength === 0 ||
            params.icon.bytes.byteLength > 2 * 1024 * 1024
          ) {
            throw new ControlPlaneStateError("Skill icon must contain at most 2 MiB");
          }
          executeSync(
            this.db,
            this.query.insertInto("skill_hub_catalog_icons").values({
              skill_id: row.id,
              content_type: params.icon.contentType,
              bytes: params.icon.bytes,
            }),
          );
        }
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog")
          .set({
            ...(params.displayName !== undefined
              ? { display_name: params.displayName.trim() }
              : {}),
            ...(params.summary !== undefined ? { summary: params.summary } : {}),
            ...(tags ? { tags_json: JSON.stringify([...new Set(tags)]) } : {}),
            ...(params.sharing ? { sharing_mode: params.sharing.mode } : {}),
            revision: row.revision + 1,
            updated_at: params.now,
          })
          .where("id", "=", row.id),
      );
      const fields = [
        params.displayName !== undefined && "name",
        params.summary !== undefined && "description",
        tags !== undefined && "tags",
        params.icon !== undefined && "icon",
      ].filter(Boolean);
      if (fields.length > 0) {
        this.history(row, params.actorUserId, "metadata-updated", params.now, { fields });
      }
      if (params.sharing) {
        this.history(
          row,
          params.actorUserId,
          "sharing-updated",
          params.now,
          { from: row.sharing_mode, to: params.sharing.mode },
          true,
        );
      }
      if (reason) {
        this.history(
          row,
          params.actorUserId,
          "administrator-metadata-updated",
          params.now,
          { reason },
          true,
        );
      }
      return this.entry(this.row(row.id));
    });
  }

  async requestTransfer(params: Parameters<SkillHubCatalogStore["requestTransfer"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const recipient = this.user(params.recipientUserId);
      const row = this.row(params.skillId);
      if (recipient.id === row.owner_user_id) {
        throw new ControlPlaneStateError("This user already owns the skill");
      }
      return this.mutate(params, { pending_transfer_user_id: recipient.id }, "transfer-requested");
    });
  }

  async acceptTransfer(params: Parameters<SkillHubCatalogStore["acceptTransfer"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const actor = this.user(params.actorUserId);
      const row = this.row(params.skillId);
      this.available(row);
      this.revision(row, params.expectedRevision);
      this.noPublication(row.id);
      if (row.pending_transfer_user_id !== actor.id) {
        throw new ControlPlaneAuthorizationError(
          "This ownership invitation is not addressed to you",
        );
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog")
          .set({
            owner_user_id: actor.id,
            pending_transfer_user_id: null,
            revision: row.revision + 1,
            updated_at: params.now,
          })
          .where("id", "=", row.id),
      );
      this.history(
        row,
        actor.id,
        "owner-transferred",
        params.now,
        { fromUserId: row.owner_user_id, toUserId: actor.id },
        true,
      );
      return this.entry(this.row(row.id));
    });
  }

  async listTransfers(actorUserId: string) {
    this.ensure();
    this.user(actorUserId);
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog")
        .selectAll()
        .where("pending_transfer_user_id", "=", actorUserId)
        .where("deleted_at", "is", null)
        .where("purged_at", "is", null),
    ).rows.map((row) => this.entry(row));
  }

  async searchUsers(params: Parameters<SkillHubCatalogStore["searchUsers"]>[0]) {
    this.ensure();
    this.user(params.actorUserId);
    const needle = params.query.trim();
    if (needle.length < 2 || needle.length > 128) {
      throw new ControlPlaneStateError("User search requires 2–128 characters");
    }
    const pattern = `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return executeSync(
      this.db,
      this.query
        .selectFrom("platform_users")
        .select(["id", "account_id", "display_name"])
        .where("status", "=", "active")
        .where(
          sql<boolean>`(account_id LIKE ${pattern} ESCAPE '\\' OR display_name LIKE ${pattern} ESCAPE '\\')`,
        )
        .orderBy("account_id")
        .limit(Math.max(1, Math.min(params.limit ?? 20, 20))),
    ).rows.map((row) =>
      Object.assign(
        { id: row.id, accountId: row.account_id },
        row.display_name ? { displayName: row.display_name } : {},
      ),
    );
  }

  async importLegacy(params: Parameters<SkillHubCatalogStore["importLegacy"]>[0]) {
    this.ensure();
    ensureSkillHubStateSchema(this.db);
    return runImmediateTransaction(this.db, () => {
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog")
          .selectAll()
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug),
      );
      if (existing) {
        if (existing.registry_id !== params.registryId) {
          throw new ControlPlaneStateError(
            "Registry skill identity changed during catalog migration",
          );
        }
        this.recordCoordinate(existing);
        this.backfillLegacyRoomInstallations(existing);
        this.importLegacyHistory(existing, existing.namespace, existing.slug);
        return this.entry(existing);
      }
      const legacy = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .selectAll()
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug),
      );
      const moved = this.recoverLegacyMove(params.registryId, params.namespace, params.slug);
      const row: SkillHubCatalogRow = {
        id: params.id,
        registry_id: params.registryId,
        namespace: params.namespace,
        slug: params.slug,
        owner_user_id: legacy ? legacy.owner_user_id : moved.ownerUserId,
        display_name: params.displayName,
        summary: params.summary,
        tags_json: "[]",
        sharing_mode: "PUBLIC",
        revision: 1,
        current_version: params.currentVersion,
        created_at: params.now,
        updated_at: params.now,
        deleted_at: null,
        purged_at: null,
        purge_pending: 0,
        pending_transfer_user_id: null,
      };
      executeSync(this.db, this.query.insertInto("skill_hub_catalog").values(row));
      this.recordCoordinate(row);
      this.backfillLegacyRoomInstallations(row);
      this.importLegacyHistory(row, row.namespace, row.slug);
      for (const source of moved.sources) {
        if (this.recordCoordinate(row, source.namespace, source.slug, "legacy")) {
          this.backfillLegacyRoomInstallations(row, source.namespace, source.slug);
          this.importLegacyHistory(row, source.namespace, source.slug);
        }
        this.history(
          row,
          null,
          "legacy-edit-cutover",
          params.now,
          { operationId: source.operationId, ownerPreserved: row.owner_user_id !== null },
          true,
        );
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_edit_intents")
            .set({ state: "cancelled", updated_at: params.now })
            .where("id", "=", source.operationId),
        );
      }
      this.history(row, null, "sharing-migrated", params.now, {}, true);
      return this.entry(row);
    });
  }

  private recoverLegacyMove(
    registryId: number,
    namespace: string,
    slug: string,
  ): {
    ownerUserId: string | null;
    sources: Array<{ namespace: string; slug: string; operationId: string }>;
  } {
    const intents = executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_edit_intents")
        .selectAll()
        .where("state", "=", "pending")
        .where("slug", "=", slug),
    ).rows;
    const candidates: Array<{
      ownerUserId: string | null;
      namespace: string;
      slug: string;
      operationId: string;
    }> = [];
    for (const intent of intents) {
      const payload = JSON.parse(intent.payload_json) as {
        skillId?: unknown;
        targetNamespace?: unknown;
        actorUserId?: unknown;
        expectedOwnerUpdatedAt?: unknown;
        originalOwnership?: { ownerUserId?: unknown; updatedAt?: unknown };
      } | null;
      if (
        !payload ||
        payload.skillId !== registryId ||
        payload.targetNamespace !== namespace ||
        intent.target_namespace !== namespace
      ) {
        continue;
      }
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .selectAll()
          .where("namespace", "=", intent.namespace)
          .where("slug", "=", slug),
      );
      const owner = current?.owner_user_id
        ? takeFirstSync(
            this.db,
            this.query
              .selectFrom("platform_users")
              .selectAll()
              .where("id", "=", current.owner_user_id),
          )
        : undefined;
      // The committed native ID and unchanged ownership receipt prove the old
      // owner. Today's account status/role controls new actions, not attribution.
      const eligible =
        owner !== undefined &&
        current?.updated_at === payload.expectedOwnerUpdatedAt &&
        current?.updated_at === payload.originalOwnership?.updatedAt &&
        current?.owner_user_id === payload.originalOwnership?.ownerUserId;
      candidates.push({
        ownerUserId: eligible ? owner.id : null,
        namespace: intent.namespace,
        slug: intent.slug,
        operationId: intent.id,
      });
    }
    const owners = [...new Set(candidates.map((candidate) => candidate.ownerUserId))];
    return {
      ownerUserId: owners.length === 1 ? owners[0]! : null,
      sources: candidates.map(({ namespace: sourceNamespace, slug: sourceSlug, operationId }) => ({
        namespace: sourceNamespace,
        slug: sourceSlug,
        operationId,
      })),
    };
  }

  private importLegacyHistory(row: SkillHubCatalogRow, namespace: string, slug: string): void {
    const coordinate = `${namespace}/${slug}`;
    const prefix = `${coordinate}@`;
    const events = executeSync(
      this.db,
      this.query
        .selectFrom("control_audit_events")
        .selectAll()
        .where("target_type", "=", "skill-hub-skill")
        .where((expression) =>
          expression.or([
            expression("target_id", "=", coordinate),
            sql<boolean>`substr(target_id, 1, ${prefix.length}) = ${prefix}`,
          ]),
        )
        .orderBy("created_at"),
    ).rows;
    for (const event of events) {
      const actor = event.actor_user_id
        ? takeFirstSync(
            this.db,
            this.query
              .selectFrom("platform_users")
              .select(["account_id", "display_name"])
              .where("id", "=", event.actor_user_id),
          )
        : undefined;
      const management = !["skill-hub.publish", "skill-hub.publish-upload"].includes(
        event.event_type,
      );
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_catalog_history")
          .values({
            id: `legacy-${event.id}`,
            skill_id: row.id,
            actor_user_id: event.actor_user_id,
            actor_name: actor ? actor.display_name || actor.account_id : null,
            action: event.event_type,
            version: event.target_id.startsWith(prefix)
              ? event.target_id.slice(prefix.length)
              : null,
            management: management ? 1 : 0,
            details_json: event.details_json ?? "{}",
            created_at: event.created_at,
          })
          .onConflict((conflict) => conflict.column("id").doNothing()),
      );
    }
  }

  private backfillLegacyRoomInstallations(
    row: SkillHubCatalogRow,
    namespace = row.namespace,
    slug = row.slug,
  ): void {
    const prefix = `${namespace}/${slug}@`;
    const events = executeSync(
      this.db,
      this.query
        .selectFrom("control_audit_events")
        .selectAll()
        .where("event_type", "=", "skill-hub.install")
        .where("target_type", "=", "skill-hub-skill")
        .where(sql<boolean>`substr(target_id, 1, ${prefix.length}) = ${prefix}`)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc"),
    ).rows;
    for (const event of events) {
      const details = JSON.parse(event.details_json ?? "{}") as {
        agentId?: unknown;
        destination?: unknown;
        sha256?: unknown;
      } | null;
      if (!details || typeof details.agentId !== "string") {
        throw new ControlPlaneStateError(
          `Legacy Skill Hub installation ${event.id} has invalid provenance`,
        );
      }
      const binding = takeFirstSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .select("kind")
          .where("agent_id", "=", details.agentId),
      );
      if (binding?.kind !== "knox-room") {
        continue;
      }
      if (
        details.destination !== "platform_server" ||
        typeof details.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(details.sha256) ||
        event.target_id.length <= prefix.length
      ) {
        throw new ControlPlaneStateError(`Legacy room installation ${event.id} cannot be verified`);
      }
      const archiveSha256 = details.sha256;
      // Old audit proves the origin, not today's filesystem revision. Keep it
      // pending until verified or reinstalled; never upgrade a room copy to trusted.
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_catalog_installations")
          .values({
            operation_id: `legacy-${event.id}`,
            agent_id: details.agentId,
            destination: details.destination,
            target_id: "platform-server",
            slug: row.slug,
            skill_id: row.id,
            version: event.target_id.slice(prefix.length),
            archive_sha256: archiveSha256,
            installed_revision: null,
            installed_at: event.created_at,
            state: "pending",
          })
          .onConflict((conflict) =>
            conflict
              .columns(["agent_id", "destination", "target_id", "slug"])
              .doUpdateSet({
                operation_id: `legacy-${event.id}`,
                skill_id: row.id,
                version: event.target_id.slice(prefix.length),
                archive_sha256: archiveSha256,
                installed_revision: null,
                installed_at: event.created_at,
                state: "pending",
              })
              .where("operation_id", "like", "legacy-%")
              .where("installed_at", "<", event.created_at),
          ),
      );
    }
  }

  async migrationComplete() {
    this.ensure();
    return Boolean(
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog_migrations")
          .select("id")
          .where("id", "=", "sharing-v1"),
      ),
    );
  }

  async listLegacyCoordinates() {
    this.ensure();
    ensureSkillHubStateSchema(this.db);
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_ownership as legacy")
        .leftJoin("skill_hub_catalog_coordinates as coordinate", (join) =>
          join
            .onRef("coordinate.namespace", "=", "legacy.namespace")
            .onRef("coordinate.slug", "=", "legacy.slug"),
        )
        .select(["legacy.namespace", "legacy.slug"])
        .where("coordinate.skill_id", "is", null)
        .orderBy("legacy.namespace")
        .orderBy("legacy.slug"),
    ).rows;
  }

  async finishMigration(now: number) {
    this.ensure();
    executeSync(
      this.db,
      this.query
        .insertInto("skill_hub_catalog_migrations")
        .values({ id: "sharing-v1", completed_at: now })
        .onConflict((conflict) => conflict.column("id").doNothing()),
    );
  }
}
