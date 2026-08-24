import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import { resolveSkillHubNamespaceCapabilities } from "./skill-hub-organization-policy.js";
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

/* oxlint-disable max-lines -- TODO: split namespace binding lifecycle from Skill Hub state. */

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
    accessState: row.access_state,
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

  protected ensureSkillHubStateSchema(): void {
    if (this.skillHubStateSchemaReady) {
      return;
    }
    ensureSkillHubStateSchema(this.db);
    this.skillHubStateSchemaReady = true;
  }

  private isSkillHubNamespaceOwnerEligible(userId: string, binding: SkillHubNamespaceBindingRow) {
    const user = this.selectUserById(userId);
    if (!user) {
      return false;
    }
    const projectedBinding = namespaceBinding(binding);
    const organizationAuthorization = binding.scope_id
      ? this.resolveOrganizationAuthorizationSnapshot(user.id, binding.scope_id)
      : undefined;
    return resolveSkillHubNamespaceCapabilities({
      user: this.rowToUser(user),
      binding: projectedBinding,
      ...(organizationAuthorization ? { organizationAuthorization } : {}),
    }).canOwn;
  }

  private requireSkillHubManager(actorUserId: string, namespace: string, slug: string) {
    const actor = this.requireUserRow(actorUserId);
    const current = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_ownership")
        .selectAll()
        .where("namespace", "=", namespace)
        .where("slug", "=", slug),
    );
    if (
      actor.status !== "active" ||
      !current ||
      (actor.global_role !== "admin" && current.owner_user_id !== actor.id)
    ) {
      throw new ControlPlaneAuthorizationError("Skill Hub skill owner or administrator required");
    }
    const binding = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_namespace_bindings")
        .selectAll()
        .where("namespace", "=", namespace),
    );
    if (
      actor.global_role !== "admin" &&
      (!binding || !this.isSkillHubNamespaceOwnerEligible(actor.id, binding))
    ) {
      throw new ControlPlaneAuthorizationError("Skill Hub namespace membership required");
    }
    return current;
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
      const binding = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .selectAll()
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug),
      );
      const ownerRevisionMatches =
        (current?.owner_user_id ?? null) === params.expectedOwnerUserId &&
        (current?.updated_at ?? null) === params.expectedOwnerUpdatedAt;
      const bindingRevisionMatches = binding?.updated_at === params.expectedBindingUpdatedAt;
      const ownerStillEligible = Boolean(
        binding && this.isSkillHubNamespaceOwnerEligible(owner.id, binding),
      );
      const reconciliationRequired =
        !ownerRevisionMatches || !bindingRevisionMatches || !ownerStillEligible;
      const recordedOwnerId = reconciliationRequired ? null : owner.id;
      const recordedVisibility = reconciliationRequired ? "PRIVATE" : params.visibility;
      const recordedAt = current
        ? Math.max(params.changedAt, current.updated_at + 1)
        : params.changedAt;
      const priorOwnerId = current?.owner_user_id ?? owner.id;
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_skill_ownership")
          .values({
            namespace: params.namespace,
            slug: params.slug,
            owner_user_id: recordedOwnerId,
            previous_owner_user_id: recordedOwnerId ? null : priorOwnerId,
            visibility: recordedVisibility,
            current_version: params.version,
            updated_at: recordedAt,
          })
          .onConflict((conflict) =>
            conflict.columns(["namespace", "slug"]).doUpdateSet({
              visibility: recordedVisibility,
              current_version: params.version,
              ...(reconciliationRequired
                ? { owner_user_id: null, previous_owner_user_id: priorOwnerId }
                : {}),
              updated_at: recordedAt,
            }),
          ),
      );
      const result = ownership(
        takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_skill_ownership")
            .selectAll()
            .where("namespace", "=", params.namespace)
            .where("slug", "=", params.slug),
        )!,
      );
      if (reconciliationRequired) {
        this.insertAudit(
          owner.id,
          "skill-hub.publish.reconciliation-required",
          "skill-hub-skill",
          `${params.namespace}/${params.slug}`,
          params.changedAt,
          {
            reason:
              "ownership, namespace binding, or organization eligibility changed while registry publish was in flight",
          },
        );
        const admins = executeSync(
          this.db,
          this.query
            .selectFrom("platform_users")
            .select("id")
            .where("status", "=", "active")
            .where("global_role", "=", "admin"),
        ).rows;
        for (const admin of admins) {
          executeSync(
            this.db,
            this.query.insertInto("skill_hub_notifications").values({
              id: randomUUID(),
              user_id: admin.id,
              kind: "owner-unassigned",
              namespace: params.namespace,
              slug: params.slug,
              message: `${params.namespace}/${params.slug} needs ownership review after a concurrent publication change.`,
              created_at: params.changedAt,
              read_at: null,
            }),
          );
        }
      }
      return reconciliationRequired ? { ...result, reconciliationRequired: true } : result;
    });
  }

  async transferSkillHubOwner(
    params: Parameters<SkillHubStateStore["transferSkillHubOwner"]>[0],
  ): Promise<SkillHubOwnership> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const current = this.requireSkillHubManager(
        params.actorUserId,
        params.namespace,
        params.slug,
      );
      const target = this.requireUserRow(params.ownerUserId);
      if (target.status !== "active") {
        throw new ControlPlaneStateError("Skill Hub owner must be active");
      }
      const binding = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      if (!binding || !this.isSkillHubNamespaceOwnerEligible(target.id, binding)) {
        throw new ControlPlaneStateError("new owner is not eligible for this namespace");
      }
      if (
        !current ||
        current.owner_user_id !== params.expectedOwnerUserId ||
        current.updated_at !== params.expectedOwnerUpdatedAt
      ) {
        throw new ControlPlaneConflictError(
          "skill_hub_owner_changed",
          "Skill Hub owner changed; reload and retry",
        );
      }
      const updatedAt = Math.max(params.changedAt, current.updated_at + 1);
      const visibilityRank = { PRIVATE: 0, NAMESPACE_ONLY: 1, PUBLIC: 2 } as const;
      const restoredVisibility =
        visibilityRank[params.registryVisibility] > visibilityRank[binding.visibility_ceiling]
          ? binding.visibility_ceiling
          : params.registryVisibility;
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_skill_ownership")
          .set({
            owner_user_id: target.id,
            previous_owner_user_id: current.owner_user_id,
            visibility: restoredVisibility,
            updated_at: updatedAt,
          })
          .where("namespace", "=", params.namespace)
          .where("slug", "=", params.slug)
          .where("owner_user_id", "is", current.owner_user_id),
      );
      this.insertAudit(
        params.actorUserId,
        "skill-hub.owner.transferred",
        "skill-hub-skill",
        `${params.namespace}/${params.slug}`,
        updatedAt,
        { fromUserId: current.owner_user_id, toUserId: target.id },
      );
      const notificationUsers = [current.owner_user_id, target.id].filter(
        (userId, index, values): userId is string =>
          Boolean(userId) && values.indexOf(userId) === index,
      );
      for (const userId of notificationUsers) {
        executeSync(
          this.db,
          this.query.insertInto("skill_hub_notifications").values({
            id: randomUUID(),
            user_id: userId,
            kind: "owner-transferred",
            namespace: params.namespace,
            slug: params.slug,
            message:
              userId === target.id
                ? `You now own ${params.namespace}/${params.slug}.`
                : `You no longer own ${params.namespace}/${params.slug}.`,
            created_at: updatedAt,
            read_at: null,
          }),
        );
      }
      return ownership({
        ...current,
        owner_user_id: target.id,
        previous_owner_user_id: current.owner_user_id,
        visibility: restoredVisibility,
        updated_at: updatedAt,
      });
    });
  }

  async reconcileInactiveSkillHubOwners(changedAt: number) {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const activeAdmins = executeSync(
        this.db,
        this.query
          .selectFrom("platform_users")
          .select("id")
          .where("status", "=", "active")
          .where("global_role", "=", "admin"),
      ).rows;
      const assigned = executeSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .select([
            "skill_hub_skill_ownership.namespace as namespace",
            "skill_hub_skill_ownership.slug as slug",
            "skill_hub_skill_ownership.owner_user_id as owner_user_id",
          ])
          .where("skill_hub_skill_ownership.owner_user_id", "is not", null),
      ).rows;
      const stale = assigned.filter((skill) => {
        const binding = takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_namespace_bindings")
            .selectAll()
            .where("namespace", "=", skill.namespace),
        );
        return (
          !skill.owner_user_id ||
          !binding ||
          !this.isSkillHubNamespaceOwnerEligible(skill.owner_user_id, binding)
        );
      });
      for (const skill of stale) {
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_skill_ownership")
            .set({
              owner_user_id: null,
              previous_owner_user_id: skill.owner_user_id,
              visibility: "PRIVATE",
              updated_at: changedAt,
            })
            .where("namespace", "=", skill.namespace)
            .where("slug", "=", skill.slug),
        );
        for (const admin of activeAdmins) {
          executeSync(
            this.db,
            this.query.insertInto("skill_hub_notifications").values({
              id: randomUUID(),
              user_id: admin.id,
              kind: "owner-unassigned",
              namespace: skill.namespace,
              slug: skill.slug,
              message: `${skill.namespace}/${skill.slug} needs an owner because the previous owner is inactive or no longer eligible for its organization scope.`,
              created_at: changedAt,
              read_at: null,
            }),
          );
        }
      }
      return {
        reassigned: 0,
        unassigned: stale.length,
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
      this.requireSkillHubManager(params.grantedByUserId, params.namespace, params.slug);
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
      this.insertAudit(
        params.grantedByUserId,
        "skill-hub.access.granted",
        "skill-hub-skill",
        `${params.namespace}/${params.slug}`,
        params.changedAt,
        {
          userId: target.id,
          expiresAt: params.expiresAt ?? null,
          inheritVersions: params.inheritVersions,
        },
      );
      executeSync(
        this.db,
        this.query.insertInto("skill_hub_notifications").values({
          id: randomUUID(),
          user_id: target.id,
          kind: "access-granted",
          namespace: params.namespace,
          slug: params.slug,
          message: `You can now access ${params.namespace}/${params.slug}.`,
          created_at: params.changedAt,
          read_at: null,
        }),
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

  async removeSkillHubAccess(
    params: Parameters<SkillHubStateStore["removeSkillHubAccess"]>[0],
  ): Promise<boolean> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireSkillHubManager(params.actorUserId, params.namespace, params.slug);
      const removed =
        Number(
          executeSync(
            this.db,
            this.query
              .deleteFrom("skill_hub_skill_access")
              .where("namespace", "=", params.namespace)
              .where("slug", "=", params.slug)
              .where("user_id", "=", params.userId),
          ).numAffectedRows,
        ) > 0;
      if (removed) {
        this.insertAudit(
          params.actorUserId,
          "skill-hub.access.revoked",
          "skill-hub-skill",
          `${params.namespace}/${params.slug}`,
          params.changedAt,
          { userId: params.userId },
        );
      }
      return removed;
    });
  }

  async searchSkillHubManagementUsers(
    params: Parameters<SkillHubStateStore["searchSkillHubManagementUsers"]>[0],
  ) {
    this.ensureSkillHubStateSchema();
    return runReadTransaction(this.db, () => {
      this.requireSkillHubManager(params.actorUserId, params.namespace, params.slug);
      const needle = params.query.trim();
      if (needle.length < 2 || needle.length > 128) {
        throw new ControlPlaneStateError("user search query must contain 2-128 characters");
      }
      const limit = Math.max(1, Math.min(Math.trunc(params.limit), 20));
      const pattern = `%${needle.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      let candidates = this.query
        .selectFrom("platform_users")
        .select(["id", "account_id", "display_name", "global_role"])
        .where("status", "=", "active")
        .where(
          sql<boolean>`(account_id LIKE ${pattern} ESCAPE '\\' OR display_name LIKE ${pattern} ESCAPE '\\')`,
        );
      let ownerBinding: SkillHubNamespaceBindingRow | undefined;
      if (params.purpose === "owner") {
        const binding = takeFirstSync(
          this.db,
          this.query
            .selectFrom("skill_hub_namespace_bindings")
            .selectAll()
            .where("namespace", "=", params.namespace),
        );
        if (!binding || binding.access_state !== "active") {
          return [];
        }
        ownerBinding = binding;
        if (binding.scope_kind === "global") {
          candidates = candidates.where("global_role", "=", "admin");
        } else {
          const scope = this.requireScopeRow(binding.scope_id!);
          const lineage = this.scopeLineageRows(scope);
          const eligible = executeSync(
            this.db,
            this.query
              .selectFrom("managed_scope_memberships")
              .select("user_id")
              .distinct()
              .where((expression) =>
                expression.or([
                  expression("scope_id", "=", scope.id),
                  expression.and([
                    expression(
                      "scope_id",
                      "in",
                      lineage.filter((entry) => entry.id !== scope.id).map((entry) => entry.id),
                    ),
                    expression("role", "=", "leader"),
                  ]),
                ]),
              ),
          ).rows.map((row) => row.user_id);
          candidates = candidates.where((expression) =>
            expression.or([
              expression("global_role", "=", "admin"),
              expression("id", "in", eligible.length > 0 ? eligible : ["__none__"]),
            ]),
          );
        }
      }
      const rows = executeSync(
        this.db,
        candidates.orderBy("account_id").orderBy("id").limit(limit),
      ).rows;
      // The SQL predicate keeps this bounded; canonical policy is still the final projection gate.
      return rows
        .filter(
          (user) => !ownerBinding || this.isSkillHubNamespaceOwnerEligible(user.id, ownerBinding),
        )
        .map((user) => ({
          id: user.id,
          accountId: user.account_id,
          ...(user.display_name ? { displayName: user.display_name } : {}),
        }));
    });
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
      const reason = params.reason.trim();
      if (!reason || reason.length > 500) {
        throw new ControlPlaneStateError(
          "Skill Hub namespace change reason must be 1 to 500 characters",
        );
      }
      if (params.scopeKind === "global" ? params.scopeId !== undefined : !params.scopeId) {
        throw new ControlPlaneStateError("Skill Hub namespace scope binding is invalid");
      }
      if (
        (params.scopeKind === "global" && params.accessState !== "restricted") ||
        (params.scopeKind !== "global" && params.accessState !== "active")
      ) {
        throw new ControlPlaneStateError(
          "Global namespaces start restricted and managed namespaces start active",
        );
      }
      if (params.scopeId) {
        const scope = this.requireScopeRow(params.scopeId);
        if (
          scope.kind !== params.scopeKind ||
          this.scopeLineageRows(scope).some((entry) => entry.status !== "active")
        ) {
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
      if (
        (params.expectedUpdatedAt === null && existing) ||
        (params.expectedUpdatedAt !== null &&
          (!existing || existing.updated_at !== params.expectedUpdatedAt))
      ) {
        throw new ControlPlaneConflictError(
          "skill_hub_namespace_binding_changed",
          "Skill Hub namespace binding changed; reload and retry",
        );
      }
      const changedAt = existing
        ? Math.max(params.changedAt, existing.updated_at + 1)
        : params.changedAt;
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_namespace_bindings")
          .values({
            namespace: params.namespace,
            scope_kind: params.scopeKind,
            scope_id: params.scopeId ?? null,
            visibility_ceiling: params.visibilityCeiling,
            access_state: params.accessState,
            created_by_user_id: existing?.created_by_user_id ?? params.actorUserId,
            created_at: existing?.created_at ?? changedAt,
            updated_at: changedAt,
          })
          .onConflict((conflict) =>
            conflict.column("namespace").doUpdateSet({
              scope_kind: params.scopeKind,
              scope_id: params.scopeId ?? null,
              visibility_ceiling: params.visibilityCeiling,
              access_state: params.accessState,
              updated_at: changedAt,
            }),
          ),
      );
      const resultRow = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      )!;
      const result = namespaceBinding(resultRow);
      let ownersUnassigned = 0;
      if (
        existing &&
        (existing.scope_kind !== params.scopeKind || existing.scope_id !== (params.scopeId ?? null))
      ) {
        const ownedSkills = executeSync(
          this.db,
          this.query
            .selectFrom("skill_hub_skill_ownership")
            .select(["slug", "owner_user_id"])
            .where("namespace", "=", params.namespace)
            .where("owner_user_id", "is not", null),
        ).rows;
        const admins = executeSync(
          this.db,
          this.query
            .selectFrom("platform_users")
            .select("id")
            .where("status", "=", "active")
            .where("global_role", "=", "admin"),
        ).rows;
        for (const skill of ownedSkills) {
          const owner = skill.owner_user_id ? this.selectUserById(skill.owner_user_id) : undefined;
          const eligible = owner
            ? this.isSkillHubNamespaceOwnerEligible(owner.id, resultRow)
            : false;
          if (eligible) {
            continue;
          }
          executeSync(
            this.db,
            this.query
              .updateTable("skill_hub_skill_ownership")
              .set({
                owner_user_id: null,
                previous_owner_user_id: skill.owner_user_id,
                updated_at: changedAt,
              })
              .where("namespace", "=", params.namespace)
              .where("slug", "=", skill.slug)
              .where("owner_user_id", "is", skill.owner_user_id),
          );
          ownersUnassigned += 1;
          for (const admin of admins) {
            executeSync(
              this.db,
              this.query.insertInto("skill_hub_notifications").values({
                id: randomUUID(),
                user_id: admin.id,
                kind: "owner-unassigned",
                namespace: params.namespace,
                slug: skill.slug,
                message: `${params.namespace}/${skill.slug} needs an owner after its namespace scope changed.`,
                created_at: changedAt,
                read_at: null,
              }),
            );
          }
        }
      }
      this.insertAudit(
        params.actorUserId,
        "skill-hub.namespace.bound",
        "skill-hub-namespace",
        params.namespace,
        changedAt,
        {
          reason,
          scopeKind: result.scopeKind,
          scopeId: result.scopeId ?? null,
          accessState: result.accessState,
          visibilityCeiling: result.visibilityCeiling,
          previousUpdatedAt: existing?.updated_at ?? null,
          ownersUnassigned,
        },
      );
      return result;
    });
  }

  async setSkillHubNamespaceAccessState(
    params: Parameters<SkillHubStateStore["setSkillHubNamespaceAccessState"]>[0],
  ): Promise<SkillHubNamespaceBinding> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const reason = params.reason.trim();
      if (!reason || reason.length > 500) {
        throw new ControlPlaneStateError(
          "Skill Hub namespace change reason must be 1 to 500 characters",
        );
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      if (!existing || existing.updated_at !== params.expectedUpdatedAt) {
        throw new ControlPlaneConflictError(
          "skill_hub_namespace_binding_changed",
          "Skill Hub namespace binding changed; reload and retry",
        );
      }
      if (existing.scope_kind !== "global") {
        throw new ControlPlaneStateError(
          "Only Global namespace access can be restricted or activated",
        );
      }
      const changedAt = Math.max(params.changedAt, existing.updated_at + 1);
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_namespace_bindings")
          .set({ access_state: params.accessState, updated_at: changedAt })
          .where("namespace", "=", params.namespace)
          .where("updated_at", "=", params.expectedUpdatedAt),
      );
      this.insertAudit(
        params.actorUserId,
        "skill-hub.namespace.access-state.changed",
        "skill-hub-namespace",
        params.namespace,
        changedAt,
        { reason, from: existing.access_state, to: params.accessState },
      );
      return namespaceBinding({
        ...existing,
        access_state: params.accessState,
        updated_at: changedAt,
      });
    });
  }

  async removeSkillHubNamespaceBinding(
    params: Parameters<SkillHubStateStore["removeSkillHubNamespaceBinding"]>[0],
  ): Promise<boolean> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireAdmin(params.actorUserId);
      const reason = params.reason.trim();
      if (!reason || reason.length > 500) {
        throw new ControlPlaneStateError(
          "Skill Hub namespace change reason must be 1 to 500 characters",
        );
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      if (!existing || existing.updated_at !== params.expectedUpdatedAt) {
        throw new ControlPlaneConflictError(
          "skill_hub_namespace_binding_changed",
          "Skill Hub namespace binding changed; reload and retry",
        );
      }
      const populated = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_skill_ownership")
          .select("slug")
          .where("namespace", "=", params.namespace)
          .limit(1),
      );
      if (populated) {
        throw new ControlPlaneConflictError(
          "skill_hub_namespace_populated",
          "Skill Hub namespace still owns skills; transfer or retire them before unbinding",
        );
      }
      const removed =
        Number(
          executeSync(
            this.db,
            this.query
              .deleteFrom("skill_hub_namespace_bindings")
              .where("namespace", "=", params.namespace)
              .where("updated_at", "=", params.expectedUpdatedAt),
          ).numAffectedRows,
        ) > 0;
      this.insertAudit(
        params.actorUserId,
        "skill-hub.namespace.unbound",
        "skill-hub-namespace",
        params.namespace,
        params.changedAt,
        { reason, previousUpdatedAt: existing.updated_at },
      );
      return removed;
    });
  }
}
