import {
  ControlPlaneAuthorizationError,
  ControlPlaneConflictError,
  ControlPlaneStateError,
} from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import {
  DEFAULT_SKILL_HUB_NAMESPACE,
  resolveSkillHubScopeCapabilities,
} from "./skill-hub-organization-policy.js";
import type { SkillHubNamespaceCreation, SkillHubStateStore } from "./skill-hub-state.js";
import { ensureSkillHubStateSchema } from "./sqlite-schema.js";
import { SqliteControlPlaneMcpStore } from "./sqlite-store-mcp.js";
import type { SkillHubNamespaceCreationRow } from "./sqlite-store-types.js";

function projectCreation(row: SkillHubNamespaceCreationRow): SkillHubNamespaceCreation {
  return {
    namespace: row.namespace,
    operationId: row.operation_id,
    actorUserId: row.actor_user_id,
    scopeKind: row.scope_kind,
    ...(row.scope_id ? { scopeId: row.scope_id } : {}),
    state: row.state,
    ...(row.registry_namespace_id !== null
      ? { registryNamespaceId: row.registry_namespace_id }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export abstract class SqliteControlPlaneSkillHubNamespaceCreationStore extends SqliteControlPlaneMcpStore {
  private skillHubStateSchemaReady = false;

  protected ensureSkillHubStateSchema(): void {
    if (this.skillHubStateSchemaReady) {
      return;
    }
    ensureSkillHubStateSchema(this.db);
    this.skillHubStateSchemaReady = true;
  }

  async ensureDefaultSkillHubNamespace(
    params: Parameters<SkillHubStateStore["ensureDefaultSkillHubNamespace"]>[0],
  ): Promise<void> {
    this.ensureSkillHubStateSchema();
    runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      if (actor.status !== "active") {
        throw new ControlPlaneAuthorizationError("active PlatformClaw user required");
      }
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", DEFAULT_SKILL_HUB_NAMESPACE),
      );
      if (
        existing?.scope_kind === "global" &&
        existing.scope_id === null &&
        existing.access_state === "active" &&
        existing.visibility_ceiling !== "PRIVATE"
      ) {
        return;
      }
      // Global is implicit membership, including deployments that previously
      // restricted or rebound it. Repair its canonical row before owner reconciliation.
      const changedAt = existing
        ? Math.max(params.changedAt, existing.updated_at + 1)
        : params.changedAt;
      const visibilityCeiling =
        existing?.visibility_ceiling === "PUBLIC" ? "PUBLIC" : "NAMESPACE_ONLY";
      executeSync(
        this.db,
        this.query
          .insertInto("skill_hub_namespace_bindings")
          .values({
            namespace: DEFAULT_SKILL_HUB_NAMESPACE,
            scope_kind: "global",
            scope_id: null,
            visibility_ceiling: visibilityCeiling,
            access_state: "active",
            created_by_user_id: existing?.created_by_user_id ?? actor.id,
            created_at: existing?.created_at ?? changedAt,
            updated_at: changedAt,
          })
          .onConflict((conflict) =>
            conflict.column("namespace").doUpdateSet({
              scope_kind: "global",
              scope_id: null,
              visibility_ceiling: visibilityCeiling,
              access_state: "active",
              updated_at: changedAt,
            }),
          ),
      );
      this.insertAudit(
        actor.id,
        existing ? "skill-hub.namespace.default-restored" : "skill-hub.namespace.initialized",
        "skill-hub-namespace",
        DEFAULT_SKILL_HUB_NAMESPACE,
        changedAt,
        {
          accessState: "active",
          previousUpdatedAt: existing?.updated_at ?? null,
          previousScopeKind: existing?.scope_kind ?? null,
          previousScopeId: existing?.scope_id ?? null,
          previousAccessState: existing?.access_state ?? null,
          previousVisibilityCeiling: existing?.visibility_ceiling ?? null,
        },
      );
    });
  }

  async listCompletedSkillHubNamespaces(): Promise<string[]> {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_namespace_creations")
        .select("namespace")
        .where("state", "=", "completed")
        .orderBy("namespace"),
    ).rows.map((row) => row.namespace);
  }

  async listSkillHubNamespaceCreations(actorUserId: string): Promise<SkillHubNamespaceCreation[]> {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_namespace_creations")
        .selectAll()
        .where("actor_user_id", "=", actorUserId)
        .where("state", "!=", "completed")
        .orderBy("updated_at", "desc")
        .limit(100),
    ).rows.map(projectCreation);
  }

  private requireNamespaceCreationScope(params: {
    actorUserId: string;
    scopeKind: SkillHubNamespaceCreation["scopeKind"];
    scopeId?: string;
  }): void {
    const actor = this.requireUserRow(params.actorUserId);
    if (params.scopeKind === "global" ? params.scopeId !== undefined : !params.scopeId) {
      throw new ControlPlaneStateError("Skill Hub namespace scope binding is invalid");
    }
    if (params.scopeId) {
      const scope = this.requireScopeRow(params.scopeId);
      if (scope.kind !== params.scopeKind) {
        throw new ControlPlaneStateError("Skill Hub namespace scope kind does not match");
      }
    }
    const organizationAuthorization = params.scopeId
      ? this.resolveOrganizationAuthorizationSnapshot(actor.id, params.scopeId)
      : undefined;
    if (
      !resolveSkillHubScopeCapabilities({
        user: this.rowToUser(actor),
        scopeKind: params.scopeKind,
        scopeId: params.scopeId,
        organizationAuthorization,
      }).canPublish
    ) {
      throw new ControlPlaneAuthorizationError("Skill Hub namespace publish authority required");
    }
  }

  async beginSkillHubNamespaceCreation(
    params: Parameters<SkillHubStateStore["beginSkillHubNamespaceCreation"]>[0],
  ): Promise<SkillHubNamespaceCreation> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      this.requireNamespaceCreationScope(params);
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_creations")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      const binding = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .selectAll()
          .where("namespace", "=", params.namespace),
      );
      const sameRequest =
        current?.actor_user_id === params.actorUserId &&
        current.scope_kind === params.scopeKind &&
        current.scope_id === (params.scopeId ?? null);
      if (
        binding &&
        sameRequest &&
        current.state === "completed" &&
        binding.created_by_user_id === current.actor_user_id &&
        binding.scope_kind === current.scope_kind &&
        binding.scope_id === current.scope_id
      ) {
        return projectCreation(current);
      }
      if (params.namespace === DEFAULT_SKILL_HUB_NAMESPACE || binding) {
        throw new ControlPlaneConflictError(
          "skill-hub-namespace-conflict",
          "Skill Hub namespace already exists or is reserved",
        );
      }
      if (current) {
        if (current.state === "completed" || !sameRequest) {
          throw new ControlPlaneConflictError(
            "skill-hub-namespace-conflict",
            "Skill Hub namespace is reserved by another creation",
          );
        }
        return projectCreation(current);
      }
      const row: SkillHubNamespaceCreationRow = {
        namespace: params.namespace,
        operation_id: params.operationId,
        actor_user_id: params.actorUserId,
        scope_kind: params.scopeKind,
        scope_id: params.scopeId ?? null,
        state: "pending",
        registry_namespace_id: null,
        created_at: params.changedAt,
        updated_at: params.changedAt,
      };
      executeSync(this.db, this.query.insertInto("skill_hub_namespace_creations").values(row));
      this.insertAudit(
        params.actorUserId,
        "skill-hub.namespace.creation-started",
        "skill-hub-namespace",
        params.namespace,
        params.changedAt,
        { scopeKind: params.scopeKind, scopeId: params.scopeId ?? null },
      );
      return projectCreation(row);
    });
  }

  async recordSkillHubNamespaceCreation(
    params: Parameters<SkillHubStateStore["recordSkillHubNamespaceCreation"]>[0],
  ): Promise<void> {
    this.ensureSkillHubStateSchema();
    runImmediateTransaction(this.db, () => {
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_creations")
          .selectAll()
          .where("namespace", "=", params.namespace)
          .where("operation_id", "=", params.operationId),
      );
      if (!current || current.state === "completed") {
        return;
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_namespace_creations")
          .set({
            state: params.state,
            registry_namespace_id: params.registryNamespaceId ?? current.registry_namespace_id,
            updated_at: params.changedAt,
          })
          .where("namespace", "=", params.namespace)
          .where("operation_id", "=", params.operationId),
      );
      this.insertAudit(
        current.actor_user_id,
        `skill-hub.namespace.creation-${params.state}`,
        "skill-hub-namespace",
        params.namespace,
        params.changedAt,
        {},
      );
    });
  }

  async completeSkillHubNamespaceCreation(
    params: Parameters<SkillHubStateStore["completeSkillHubNamespaceCreation"]>[0],
  ) {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const current = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_creations")
          .selectAll()
          .where("namespace", "=", params.namespace)
          .where("operation_id", "=", params.operationId),
      );
      if (
        !current ||
        current.state !== "registry-created" ||
        current.registry_namespace_id === null
      ) {
        throw new ControlPlaneConflictError(
          "skill-hub-namespace-conflict",
          "Skill Hub namespace creation state changed; reload and retry",
        );
      }
      this.requireNamespaceCreationScope({
        actorUserId: current.actor_user_id,
        scopeKind: current.scope_kind,
        ...(current.scope_id ? { scopeId: current.scope_id } : {}),
      });
      const existing = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_namespace_bindings")
          .select("namespace")
          .where("namespace", "=", params.namespace),
      );
      if (existing) {
        throw new ControlPlaneConflictError(
          "skill-hub-namespace-conflict",
          "Skill Hub namespace binding already exists",
        );
      }
      executeSync(
        this.db,
        this.query.insertInto("skill_hub_namespace_bindings").values({
          namespace: current.namespace,
          scope_kind: current.scope_kind,
          scope_id: current.scope_id,
          access_state: "active",
          visibility_ceiling: "NAMESPACE_ONLY",
          created_by_user_id: current.actor_user_id,
          created_at: params.changedAt,
          updated_at: params.changedAt,
        }),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_namespace_creations")
          .set({ state: "completed", updated_at: params.changedAt })
          .where("namespace", "=", current.namespace),
      );
      this.insertAudit(
        current.actor_user_id,
        "skill-hub.namespace.created",
        "skill-hub-namespace",
        current.namespace,
        params.changedAt,
        { scopeKind: current.scope_kind, registryNamespaceId: current.registry_namespace_id },
      );
      return {
        namespace: current.namespace,
        scopeKind: current.scope_kind,
        ...(current.scope_id ? { scopeId: current.scope_id } : {}),
        accessState: "active" as const,
        visibilityCeiling: "NAMESPACE_ONLY" as const,
        createdByUserId: current.actor_user_id,
        createdAt: params.changedAt,
        updatedAt: params.changedAt,
      };
    });
  }
}
