import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
  type OrganizationAuthorization,
} from "./contracts.js";
import { createSyncKysely, executeSync, takeFirstSync } from "./kysely-sync.js";
import type {
  SkillHubCatalogEntry,
  SkillHubCatalogStore,
  SkillHubSharing,
} from "./skill-hub-catalog-state.js";
import {
  ensureSkillHubCatalogSchema,
  type SkillHubCatalogHistoryRow,
  type SkillHubCatalogBlockedVersionRow,
  type SkillHubCatalogInstallationRow,
  type SkillHubCatalogIconRow,
  type SkillHubCatalogPublicationRow,
  type SkillHubCatalogRecipientRow,
  type SkillHubCatalogRow,
  type SkillHubCatalogCoordinateRow,
  type SkillHubCatalogMaintenanceCursorRow,
} from "./sqlite-schema-skill-hub-catalog.js";
import type { ControlPlaneDatabase } from "./sqlite-store-types.js";

type SkillHubCatalogDatabase = Pick<
  ControlPlaneDatabase,
  | "platform_users"
  | "agent_bindings"
  | "managed_scopes"
  | "skill_hub_skill_ownership"
  | "control_audit_events"
  | "skill_hub_edit_intents"
  | "skill_hub_notifications"
> & {
  skill_hub_catalog: SkillHubCatalogRow;
  skill_hub_catalog_coordinates: SkillHubCatalogCoordinateRow;
  skill_hub_catalog_recipients: SkillHubCatalogRecipientRow;
  skill_hub_catalog_icons: SkillHubCatalogIconRow;
  skill_hub_catalog_publications: SkillHubCatalogPublicationRow;
  skill_hub_catalog_history: SkillHubCatalogHistoryRow;
  skill_hub_catalog_migrations: { id: string; completed_at: number };
  skill_hub_catalog_blocked_versions: SkillHubCatalogBlockedVersionRow;
  skill_hub_catalog_installations: SkillHubCatalogInstallationRow;
  skill_hub_catalog_maintenance_cursors: SkillHubCatalogMaintenanceCursorRow;
};

export class SqliteSkillHubCatalogCore {
  protected readonly query = createSyncKysely<SkillHubCatalogDatabase>();
  private ready = false;

  constructor(
    protected readonly db: DatabaseSync,
    private readonly authorizeScope: (userId: string, scopeId: string) => OrganizationAuthorization,
  ) {}

  protected ensure(): void {
    if (!this.ready) {
      ensureSkillHubCatalogSchema(this.db);
      this.ready = true;
    }
  }

  protected maintenanceCursor(kind: "publication" | "purge"): string | null {
    return (
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog_maintenance_cursors")
          .select("after_id")
          .where("kind", "=", kind),
      )?.after_id ?? null
    );
  }

  protected advanceMaintenanceCursor(
    kind: "publication" | "purge",
    afterId: string | undefined,
  ): void {
    if (afterId === undefined) {
      executeSync(
        this.db,
        this.query.deleteFrom("skill_hub_catalog_maintenance_cursors").where("kind", "=", kind),
      );
      return;
    }
    executeSync(
      this.db,
      this.query
        .insertInto("skill_hub_catalog_maintenance_cursors")
        .values({ kind, after_id: afterId })
        .onConflict((conflict) => conflict.column("kind").doUpdateSet({ after_id: afterId })),
    );
  }

  protected user(userId: string) {
    const user = takeFirstSync(
      this.db,
      this.query.selectFrom("platform_users").selectAll().where("id", "=", userId),
    );
    if (!user || user.status !== "active") {
      throw new ControlPlaneAuthorizationError("Active Skill Hub account required");
    }
    return user;
  }

  protected row(id: string): SkillHubCatalogRow {
    this.ensure();
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("skill_hub_catalog").selectAll().where("id", "=", id),
    );
    if (!row) {
      throw new ControlPlaneNotFoundError("skill-hub-skill", id);
    }
    return row;
  }

  protected manager(row: SkillHubCatalogRow, actorUserId: string): void {
    const actor = this.user(actorUserId);
    if (actor.global_role !== "admin" && row.owner_user_id !== actor.id) {
      throw new ControlPlaneAuthorizationError("Skill Hub owner or administrator required");
    }
  }

  protected administratorReason(
    row: SkillHubCatalogRow,
    actorUserId: string,
    reason?: string,
  ): string | undefined {
    const actor = this.user(actorUserId);
    if (actor.global_role !== "admin" || row.owner_user_id === actor.id) {
      return undefined;
    }
    const normalized = reason?.trim();
    if (!normalized || normalized.length > 500) {
      throw new ControlPlaneStateError(
        "Administrator changes to another owner's skill require a reason of 1–500 characters",
      );
    }
    return normalized;
  }

  protected revision(row: SkillHubCatalogRow, expectedRevision: number): void {
    if (row.revision !== expectedRevision) {
      throw new ControlPlaneConflictError(
        "skill-hub-changed",
        "This skill changed; reload before saving",
      );
    }
  }

  protected available(row: SkillHubCatalogRow): void {
    if (row.deleted_at !== null || row.purged_at !== null || row.purge_pending) {
      throw new ControlPlaneStateError(
        "This skill is in the trash or has been permanently deleted",
      );
    }
  }

  protected noPublication(id: string): void {
    if (
      takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog_publications")
          .select("operation_id")
          .where("skill_id", "=", id)
          .where("state", "=", "pending"),
      )
    ) {
      throw new ControlPlaneConflictError(
        "skill-hub-publication-pending",
        "Publication is still being reconciled; retry shortly",
      );
    }
  }

  protected sharing(id: string, mode: SkillHubSharing["mode"]): SkillHubSharing {
    const rows = executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_recipients")
        .selectAll()
        .where("skill_id", "=", id)
        .orderBy("kind")
        .orderBy("target_id"),
    ).rows;
    return {
      mode,
      userIds: rows.filter((row) => row.kind === "user").map((row) => row.target_id),
      scopeIds: rows.filter((row) => row.kind === "scope").map((row) => row.target_id),
    };
  }

  protected entry(row: SkillHubCatalogRow): SkillHubCatalogEntry {
    return {
      id: row.id,
      registryId: row.registry_id,
      namespace: row.namespace,
      slug: row.slug,
      ownerUserId: row.owner_user_id,
      displayName: row.display_name,
      summary: row.summary,
      tags: JSON.parse(row.tags_json) as string[],
      sharing: this.sharing(row.id, row.sharing_mode),
      revision: row.revision,
      currentVersion: row.current_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      purgedAt: row.purged_at,
      purgePending: row.purge_pending === 1,
      pendingTransferUserId: row.pending_transfer_user_id,
      hasIcon: Boolean(
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_catalog_icons")
            .select("skill_id")
            .where("skill_id", "=", row.id),
        ),
      ),
    };
  }

  protected access(
    row: SkillHubCatalogRow,
    actorUserId: string,
    audience: "employee" | "room" = "employee",
  ): boolean {
    const actor = this.user(actorUserId);
    if (
      row.deleted_at !== null ||
      row.purged_at !== null ||
      row.current_version === null ||
      row.purge_pending
    ) {
      return false;
    }
    if (audience === "room") {
      return row.sharing_mode === "PUBLIC";
    }
    if (
      actor.global_role === "admin" ||
      row.owner_user_id === actor.id ||
      row.sharing_mode === "PUBLIC"
    ) {
      return true;
    }
    if (row.sharing_mode !== "SELECTED") {
      return false;
    }
    const sharing = this.sharing(row.id, row.sharing_mode);
    return (
      sharing.userIds.includes(actor.id) ||
      sharing.scopeIds.some((scopeId) => {
        const scope = takeFirstSync(
          this.db,
          this.query.selectFrom("managed_scopes").select("status").where("id", "=", scopeId),
        );
        return scope?.status === "active" && this.authorizeScope(actor.id, scopeId).canRead;
      })
    );
  }

  protected setSharing(id: string, sharing: SkillHubSharing): void {
    if (!["PUBLIC", "SELECTED", "PRIVATE"].includes(sharing.mode)) {
      throw new ControlPlaneStateError("Invalid Skill Hub sharing mode");
    }
    const userIds = [...new Set(sharing.userIds)];
    const scopeIds = [...new Set(sharing.scopeIds)];
    if (
      userIds.length + scopeIds.length > 100 ||
      (sharing.mode === "SELECTED"
        ? userIds.length + scopeIds.length === 0
        : userIds.length + scopeIds.length !== 0)
    ) {
      throw new ControlPlaneStateError(
        "Choose recipients for selected sharing, or choose Public or Private",
      );
    }
    for (const userId of userIds) {
      this.user(userId);
    }
    for (const scopeId of scopeIds) {
      const scope = takeFirstSync(
        this.db,
        this.query.selectFrom("managed_scopes").select("status").where("id", "=", scopeId),
      );
      if (scope?.status !== "active") {
        throw new ControlPlaneStateError("Selected organization is unavailable");
      }
    }
    executeSync(
      this.db,
      this.query.deleteFrom("skill_hub_catalog_recipients").where("skill_id", "=", id),
    );
    const rows: SkillHubCatalogRecipientRow[] = [
      ...userIds.map((target_id) => ({ skill_id: id, kind: "user" as const, target_id })),
      ...scopeIds.map((target_id) => ({ skill_id: id, kind: "scope" as const, target_id })),
    ];
    if (rows.length > 0) {
      executeSync(this.db, this.query.insertInto("skill_hub_catalog_recipients").values(rows));
    }
  }

  protected history(
    row: SkillHubCatalogRow,
    actorUserId: string | null,
    action: string,
    now: number,
    details: Record<string, unknown> = {},
    management = false,
    version: string | null = null,
  ): void {
    const actor = actorUserId
      ? takeFirstSync(
          this.db,
          this.query
            .selectFrom("platform_users")
            .select(["account_id", "display_name"])
            .where("id", "=", actorUserId),
        )
      : undefined;
    executeSync(
      this.db,
      this.query.insertInto("skill_hub_catalog_history").values({
        id: randomUUID(),
        skill_id: row.id,
        actor_user_id: actorUserId,
        actor_name: actor ? actor.display_name || actor.account_id : null,
        action,
        version,
        management: management ? 1 : 0,
        details_json: JSON.stringify(details),
        created_at: now,
      }),
    );
  }

  async get(id: string) {
    this.ensure();
    const row = takeFirstSync(
      this.db,
      this.query.selectFrom("skill_hub_catalog").selectAll().where("id", "=", id),
    );
    return row ? this.entry(row) : null;
  }

  async getByCoordinate(namespace: string, slug: string) {
    this.ensure();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_coordinates as coordinate")
        .innerJoin("skill_hub_catalog as skill", "skill.id", "coordinate.skill_id")
        .selectAll("skill")
        .where("coordinate.namespace", "=", namespace)
        .where("coordinate.slug", "=", slug),
    );
    return row ? this.entry(row) : null;
  }

  protected recordCoordinate(
    row: SkillHubCatalogRow,
    namespace = row.namespace,
    slug = row.slug,
    kind: "current" | "legacy" = "current",
  ): boolean {
    const existing = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_coordinates")
        .selectAll()
        .where("namespace", "=", namespace)
        .where("slug", "=", slug),
    );
    if (existing && existing.skill_id !== row.id && existing.kind === "current") {
      if (kind === "legacy") {
        return false;
      }
      throw new ControlPlaneStateError("Registry coordinate already identifies another skill");
    }
    if (existing?.skill_id === row.id) {
      return true;
    }
    if (existing && existing.skill_id !== row.id && kind === "legacy") {
      throw new ControlPlaneStateError("Legacy skill reference is ambiguous");
    }
    executeSync(
      this.db,
      this.query
        .insertInto("skill_hub_catalog_coordinates")
        .values({ namespace, slug, skill_id: row.id, kind })
        .onConflict((conflict) =>
          conflict.columns(["namespace", "slug"]).doUpdateSet({ skill_id: row.id, kind }),
        ),
    );
    return true;
  }

  async list() {
    this.ensure();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog")
        .selectAll()
        .orderBy("updated_at", "desc")
        .orderBy("id"),
    ).rows.map((row) => this.entry(row));
  }

  async getIcon(id: string) {
    this.ensure();
    const icon = takeFirstSync(
      this.db,
      this.query.selectFrom("skill_hub_catalog_icons").selectAll().where("skill_id", "=", id),
    );
    return icon ? { contentType: icon.content_type, bytes: icon.bytes } : null;
  }

  async canAccess(params: Parameters<SkillHubCatalogStore["canAccess"]>[0]) {
    return this.access(this.row(params.skillId), params.userId, params.audience);
  }

  protected mutate(
    params: {
      skillId: string;
      actorUserId: string;
      expectedRevision: number;
      now: number;
      reason?: string;
    },
    update: Partial<SkillHubCatalogRow>,
    action: string,
    allowTrash = false,
  ) {
    const row = this.row(params.skillId);
    this.manager(row, params.actorUserId);
    const reason = this.administratorReason(row, params.actorUserId, params.reason);
    this.revision(row, params.expectedRevision);
    this.noPublication(row.id);
    if (!allowTrash) {
      this.available(row);
    }
    executeSync(
      this.db,
      this.query
        .updateTable("skill_hub_catalog")
        .set({ ...update, revision: row.revision + 1, updated_at: params.now })
        .where("id", "=", row.id),
    );
    this.history(row, params.actorUserId, action, params.now, reason ? { reason } : {}, true);
    return this.entry(this.row(row.id));
  }
}
