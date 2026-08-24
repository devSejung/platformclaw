import { randomUUID } from "node:crypto";
import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import { resolveSkillHubNamespaceCapabilities } from "./skill-hub-organization-policy.js";
import type { SkillHubNamespaceBinding, SkillHubStateStore } from "./skill-hub-state.js";
import { ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneMcpStore } from "./sqlite-store-mcp.js";
import type { SkillHubNamespaceBindingRow } from "./sqlite-store-types.js";

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

export abstract class SqliteControlPlaneSkillHubNamespaceStore extends SqliteControlPlaneMcpStore {
  private skillHubStateSchemaReady = false;

  protected ensureSkillHubStateSchema(): void {
    if (this.skillHubStateSchemaReady) {
      return;
    }
    ensureSkillHubStateSchema(this.db);
    this.skillHubStateSchemaReady = true;
  }

  protected isSkillHubNamespaceOwnerEligible(userId: string, binding: SkillHubNamespaceBindingRow) {
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

  protected requireSkillHubManager(actorUserId: string, namespace: string, slug: string) {
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
