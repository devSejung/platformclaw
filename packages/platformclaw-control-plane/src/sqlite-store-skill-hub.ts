import { randomUUID } from "node:crypto";
import { ControlPlaneStateError } from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import type {
  SkillHubAccessGrant,
  SkillHubNotification,
  SkillHubOwnership,
  SkillHubStateStore,
  SkillHubGovernanceJob,
  SkillHubNamespaceBinding,
} from "./skill-hub-state.js";
import { ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneMcpStore } from "./sqlite-store-mcp.js";
import type {
  SkillHubAccessRow,
  SkillHubNamespaceBindingRow,
  SkillHubNotificationRow,
  SkillHubOwnershipRow,
} from "./sqlite-store-types.js";

function ownership(row: SkillHubOwnershipRow): SkillHubOwnership {
  return {
    namespace: row.namespace,
    slug: row.slug,
    ownerUserId: row.owner_user_id,
    ...(row.previous_owner_user_id === null
      ? {}
      : { previousOwnerUserId: row.previous_owner_user_id }),
    visibility: row.visibility,
    currentVersion: row.current_version,
    updatedAt: row.updated_at,
  };
}

function access(row: SkillHubAccessRow): SkillHubAccessGrant {
  return {
    namespace: row.namespace,
    slug: row.slug,
    userId: row.user_id,
    grantedByUserId: row.granted_by_user_id,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    inheritVersions: row.inherit_versions === 1,
    ...(row.granted_version === null ? {} : { grantedVersion: row.granted_version }),
    canReshare: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

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

function namespaceBinding(row: SkillHubNamespaceBindingRow): SkillHubNamespaceBinding {
  return {
    namespace: row.namespace,
    scopeKind: row.scope_kind,
    ...(row.scope_id === null ? {} : { scopeId: row.scope_id }),
    visibilityCeiling: row.visibility_ceiling,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export abstract class SqliteControlPlaneSkillHubStore
  extends SqliteControlPlaneMcpStore
  implements SkillHubStateStore
{
  private skillHubStateSchemaReady = false;

  private ensureSkillHubStateSchema(): void {
    if (this.skillHubStateSchemaReady) {
      return;
    }
    ensureSkillHubStateSchema(this.db);
    this.skillHubStateSchemaReady = true;
  }

  async getSkillHubOwnership(namespace: string, slug: string): Promise<SkillHubOwnership | null> {
    this.ensureSkillHubStateSchema();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_ownership")
        .selectAll()
        .where("namespace", "=", namespace)
        .where("slug", "=", slug),
    );
    return row ? ownership(row) : null;
  }

  async recordSkillHubPublication(
    params: Parameters<SkillHubStateStore["recordSkillHubPublication"]>[0],
  ): Promise<SkillHubOwnership> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const owner = this.requireUserRow(params.ownerUserId);
      if (owner.status !== "active") {
        throw new ControlPlaneStateError("Skill Hub owner must be active");
      }
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_skill_ownership")
          .values({
            namespace: params.namespace,
            slug: params.slug,
            owner_user_id: owner.id,
            previous_owner_user_id: null,
            visibility: params.visibility,
            current_version: params.version,
            updated_at: params.changedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["namespace", "slug"]).doUpdateSet({
              visibility: params.visibility,
              current_version: params.version,
              updated_at: params.changedAt,
            }),
          ),
      );
      return ownership(
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_skill_ownership")
            .selectAll()
            .where("namespace", "=", params.namespace)
            .where("slug", "=", params.slug),
        )!,
      );
    });
  }

  async transferSkillHubOwner(
    params: Parameters<SkillHubStateStore["transferSkillHubOwner"]>[0],
  ): Promise<SkillHubOwnership> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const target = this.requireUserRow(params.ownerUserId);
      if (target.status !== "active") {
        throw new ControlPlaneStateError("Skill Hub owner must be active");
      }
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .selectAll()
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug),
      );
      if (!current || current.owner_user_id !== params.expectedOwnerUserId) {
        throw new ControlPlaneStateError("Skill Hub owner changed; reload and retry");
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_skill_ownership")
          .set({
            owner_user_id: target.id,
            previous_owner_user_id: current.owner_user_id,
            updated_at: params.changedAt,
          })
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug)
          .where("owner_user_id", "is", current.owner_user_id),
      );
      return ownership({
        ...current,
        owner_user_id: target.id,
        previous_owner_user_id: current.owner_user_id,
        updated_at: params.changedAt,
      });
    });
  }

  async reconcileInactiveSkillHubOwners(changedAt: number, primaryAdminUserId?: string) {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const primaryAdmin = primaryAdminUserId
        ? takeFirstSync(
            this.db,
            this.query
              .selectFrom("platform_users")
              .select("id")
              // Deployment derives this from the initial-admin account ID, while
              // persisted settings may hold the stable internal user ID.
              .where((expression) =>
                expression.or([
                  expression("id", "=", primaryAdminUserId),
                  expression("account_id", "=", primaryAdminUserId),
                ]),
              )
              .where("status", "=", "active")
              .where("global_role", "=", "admin"),
          )
        : undefined;
      const activeAdmins = executeSync(
        this.db,
        this.query
          .selectFrom("platform_users")
          .select("id")
          .where("status", "=", "active")
          .where("global_role", "=", "admin"),
      ).rows;
      const stale = executeSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .innerJoin(
            "platform_users",
            "platform_users.id",
            "skill_hub_skill_ownership.owner_user_id",
          )
          .select([
            "skill_hub_skill_ownership.namespace as namespace",
            "skill_hub_skill_ownership.slug as slug",
            "skill_hub_skill_ownership.owner_user_id as owner_user_id",
          ])
          .where("platform_users.status", "=", "disabled"),
      ).rows;
      for (const skill of stale) {
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_skill_ownership")
            .set({
              owner_user_id: primaryAdmin?.id ?? null,
              previous_owner_user_id: skill.owner_user_id,
              updated_at: changedAt,
            })
            .where("namespace", "=", skill.namespace)
            .where("slug", "=", skill.slug),
        );
        for (const admin of primaryAdmin ? [primaryAdmin] : activeAdmins) {
          executeSync(
            this.db,
            this.query.insertInto("skill_hub_notifications").values({
              id: randomUUID(),
              user_id: admin.id,
              kind: primaryAdmin ? "owner-reassigned" : "owner-unassigned",
              namespace: skill.namespace,
              slug: skill.slug,
              message: primaryAdmin
                ? `Ownership of ${skill.namespace}/${skill.slug} was reassigned because the previous owner is inactive.`
                : `${skill.namespace}/${skill.slug} needs an owner because the previous owner is inactive.`,
              created_at: changedAt,
              read_at: null,
            }),
          );
        }
      }
      return {
        reassigned: primaryAdmin ? stale.length : 0,
        unassigned: primaryAdmin ? 0 : stale.length,
      };
    });
  }

  async countUnassignedSkillHubSkills(): Promise<number> {
    this.ensureSkillHubStateSchema();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_ownership")
        .select((expression) => expression.fn.countAll<number>().as("count"))
        .where("owner_user_id", "is", null),
    );
    return row?.count ?? 0;
  }

  async listUnassignedSkillHubSkills(): Promise<SkillHubOwnership[]> {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_ownership")
        .selectAll()
        .where("owner_user_id", "is", null)
        .orderBy("updated_at", "desc"),
    ).rows.map(ownership);
  }

  async listSkillHubAccess(namespace: string, slug: string, now: number) {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_access")
        .selectAll()
        .where("namespace", "=", namespace)
        .where("slug", "=", slug)
        .where((expression) =>
          expression.or([expression("expires_at", "is", null), expression("expires_at", ">", now)]),
        )
        .orderBy("user_id"),
    ).rows.map(access);
  }

  async hasSkillHubAccess(params: Parameters<SkillHubStateStore["hasSkillHubAccess"]>[0]) {
    this.ensureSkillHubStateSchema();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_access")
        .select("user_id")
        .where("namespace", "=", params.namespace)
        .where("slug", "=", params.slug)
        .where("user_id", "=", params.userId)
        .where((expression) =>
          expression.or([
            expression("expires_at", "is", null),
            expression("expires_at", ">", params.now),
          ]),
        )
        .where((expression) =>
          expression.or([
            expression("inherit_versions", "=", 1),
            expression("granted_version", "=", params.version ?? ""),
          ]),
        ),
    );
    return Boolean(row);
  }

  async setSkillHubAccess(params: Parameters<SkillHubStateStore["setSkillHubAccess"]>[0]) {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const target = this.requireUserRow(params.userId);
      if (target.status !== "active") {
        throw new ControlPlaneStateError("Skill Hub access recipient must be active");
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_access")
          .select("created_at")
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug)
          .where("user_id", "=", target.id),
      );
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_skill_access")
          .values({
            namespace: params.namespace,
            slug: params.slug,
            user_id: target.id,
            granted_by_user_id: params.grantedByUserId,
            expires_at: params.expiresAt ?? null,
            inherit_versions: params.inheritVersions ? 1 : 0,
            granted_version: params.inheritVersions ? null : (params.grantedVersion ?? null),
            created_at: existing?.created_at ?? params.changedAt,
            updated_at: params.changedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["namespace", "slug", "user_id"]).doUpdateSet({
              granted_by_user_id: params.grantedByUserId,
              expires_at: params.expiresAt ?? null,
              inherit_versions: params.inheritVersions ? 1 : 0,
              granted_version: params.inheritVersions ? null : (params.grantedVersion ?? null),
              updated_at: params.changedAt,
            }),
          ),
      );
      return access(
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_skill_access")
            .selectAll()
            .where("namespace", "=", params.namespace)
            .where("slug", "=", params.slug)
            .where("user_id", "=", target.id),
        )!,
      );
    });
  }

  async removeSkillHubAccess(namespace: string, slug: string, userId: string): Promise<boolean> {
    this.ensureSkillHubStateSchema();
    return (
      Number(
        executeSync(
          this.db,
          this.query
            .deleteFrom("skill_hub_skill_access")
            .where("namespace", "=", namespace)
            .where("slug", "=", slug)
            .where("user_id", "=", userId),
        ).numAffectedRows,
      ) > 0
    );
  }

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

  async getSkillHubNamespaceBinding(namespace: string): Promise<SkillHubNamespaceBinding | null> {
    this.ensureSkillHubStateSchema();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_namespace_bindings")
        .selectAll()
        .where("namespace", "=", namespace),
    );
    return row ? namespaceBinding(row) : null;
  }

  async listSkillHubNamespaceBindings(): Promise<SkillHubNamespaceBinding[]> {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query.selectFrom("skill_hub_namespace_bindings").selectAll().orderBy("namespace"),
    ).rows.map(namespaceBinding);
  }

  async setSkillHubNamespaceBinding(
    params: Parameters<SkillHubStateStore["setSkillHubNamespaceBinding"]>[0],
  ): Promise<SkillHubNamespaceBinding> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      if (params.scopeKind === "team" ? params.scopeId !== undefined : !params.scopeId) {
        throw new ControlPlaneStateError("Skill Hub namespace scope binding is invalid");
      }
      if (params.scopeId) {
        const scope = takeFirstSync(
          this.db,
          this.query.selectFrom("managed_scopes").selectAll().where("id", "=", params.scopeId),
        );
        if (!scope || scope.status !== "active" || scope.kind !== params.scopeKind) {
          throw new ControlPlaneStateError("Skill Hub namespace scope is unavailable");
        }
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_namespace_bindings")
          .values({
            namespace: params.namespace,
            scope_kind: params.scopeKind,
            scope_id: params.scopeId ?? null,
            visibility_ceiling: params.visibilityCeiling,
            created_by_user_id: existing?.created_by_user_id ?? params.actorUserId,
            created_at: existing?.created_at ?? params.changedAt,
            updated_at: params.changedAt,
          })
          .onConflict((conflict) =>
            conflict.column("namespace").doUpdateSet({
              scope_kind: params.scopeKind,
              scope_id: params.scopeId ?? null,
              visibility_ceiling: params.visibilityCeiling,
              updated_at: params.changedAt,
            }),
          ),
      );
      return namespaceBinding(
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_namespace_bindings")
            .selectAll()
            .where("namespace", "=", params.namespace),
        )!,
      );
    });
  }

  async removeSkillHubNamespaceBinding(namespace: string): Promise<boolean> {
    this.ensureSkillHubStateSchema();
    return (
      Number(
        executeSync(
          this.db,
          this.query.deleteFrom("skill_hub_namespace_bindings").where("namespace", "=", namespace),
        ).numAffectedRows,
      ) > 0
    );
  }

  async hasSkillHubNamespaceAccess(
    userId: string,
    binding: SkillHubNamespaceBinding,
  ): Promise<boolean> {
    this.ensureSkillHubStateSchema();
    if (binding.scopeKind === "team" || !binding.scopeId) {
      return false;
    }
    const direct = takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scope_memberships")
        .select("user_id")
        .where("scope_id", "=", binding.scopeId)
        .where("user_id", "=", userId),
    );
    if (direct || binding.scopeKind === "group") {
      return Boolean(direct);
    }
    const parentLeader = takeFirstSync(
      this.db,
      this.query
        .selectFrom("managed_scopes")
        .innerJoin(
          "managed_scope_memberships",
          "managed_scope_memberships.scope_id",
          "managed_scopes.parent_group_id",
        )
        .select("managed_scope_memberships.user_id")
        .where("managed_scopes.id", "=", binding.scopeId)
        .where("managed_scope_memberships.user_id", "=", userId)
        .where("managed_scope_memberships.role", "=", "leader"),
    );
    return Boolean(parentLeader);
  }
}
