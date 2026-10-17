import { randomUUID } from "node:crypto";
import { ControlPlaneConflictError, ControlPlaneStateError } from "./contracts.js";
import { executeSync, runImmediateTransaction, takeFirstSync } from "./kysely-sync.js";
import type {
  SkillHubEditCompletion,
  SkillHubEditIntent,
  SkillHubEditPlan,
  SkillHubEditResult,
  SkillHubStateStore,
} from "./skill-hub-state.js";
import {
  projectSkillHubOwnership,
  SqliteControlPlaneSkillHubStore,
} from "./sqlite-store-skill-hub.js";
import type { SkillHubEditIntentRow, SkillHubOwnershipRow } from "./sqlite-store-types.js";

function editIntent(row: SkillHubEditIntentRow): SkillHubEditIntent {
  const payload = JSON.parse(row.payload_json) as Omit<SkillHubEditIntent, "state" | "result">;
  return {
    ...payload,
    state: row.state,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as SkillHubEditResult } : {}),
  };
}

export abstract class SqliteControlPlaneSkillHubEditStore
  extends SqliteControlPlaneSkillHubStore
  implements SkillHubStateStore
{
  async beginSkillHubEdit(params: SkillHubEditPlan): Promise<SkillHubEditIntent> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const existing = this.selectSkillHubEdit(params.id);
      if (existing) {
        const intent = editIntent(existing);
        const persisted = new Map(Object.entries(intent));
        if (Object.entries(params).some(([key, value]) => persisted.get(key) !== value)) {
          throw new ControlPlaneStateError("Skill Hub edit ID already belongs to another request");
        }
        return intent;
      }
      const current = this.requireSkillHubManager(
        params.actorUserId,
        params.namespace,
        params.slug,
      );
      this.requireSkillHubCoordinateAvailable(params.targetNamespace, params.slug);
      const sourceBinding = this.selectSkillHubEditBinding(params.namespace);
      const targetBinding = this.selectSkillHubEditBinding(params.targetNamespace);
      if (
        !sourceBinding ||
        !targetBinding ||
        current.updated_at !== params.expectedOwnerUpdatedAt ||
        sourceBinding.updated_at !== params.expectedSourceBindingUpdatedAt ||
        targetBinding.updated_at !== params.expectedTargetBindingUpdatedAt
      ) {
        throw new ControlPlaneConflictError(
          "skill_hub_owner_changed",
          "Skill Hub skill or namespace changed; reload and retry",
        );
      }
      const moving = params.namespace !== params.targetNamespace;
      if (moving) {
        if (this.selectSkillHubEditOwnership(params.targetNamespace, params.slug)) {
          throw new ControlPlaneConflictError(
            "skill_hub_owner_changed",
            "Skill Hub destination already has this skill",
          );
        }
        if (
          !this.isSkillHubNamespaceOwnerEligible(params.actorUserId, targetBinding) ||
          !current.owner_user_id ||
          !this.isSkillHubNamespaceOwnerEligible(current.owner_user_id, targetBinding)
        ) {
          throw new ControlPlaneStateError(
            "Actor and current owner must be eligible for the destination namespace",
          );
        }
      }
      const visibilityRank = { PRIVATE: 0, NAMESPACE_ONLY: 1, PUBLIC: 2 } as const;
      if (visibilityRank[params.visibility] > visibilityRank[targetBinding.visibility_ceiling]) {
        throw new ControlPlaneStateError("Skill visibility exceeds the namespace ceiling");
      }
      const payload = { ...params, originalOwnership: projectSkillHubOwnership(current) };
      executeSync(
        this.db,
        this.query.insertInto("skill_hub_edit_intents").values({
          id: params.id,
          namespace: params.namespace,
          slug: params.slug,
          target_namespace: params.targetNamespace,
          state: "pending",
          payload_json: JSON.stringify(payload),
          result_json: null,
          created_at: params.changedAt,
          updated_at: params.changedAt,
        }),
      );
      this.insertAudit(
        params.actorUserId,
        "skill-hub.edit.started",
        "skill-hub-skill",
        `${params.namespace}/${params.slug}`,
        params.changedAt,
        { editId: params.id, targetNamespace: params.targetNamespace },
      );
      return { ...payload, state: "pending" };
    });
  }

  async getSkillHubEdit(id: string): Promise<SkillHubEditIntent | null> {
    this.ensureSkillHubStateSchema();
    const row = this.selectSkillHubEdit(id);
    return row ? editIntent(row) : null;
  }

  async getSkillHubPendingEdit(
    namespace: string,
    slug: string,
  ): Promise<SkillHubEditIntent | null> {
    this.ensureSkillHubStateSchema();
    const row = this.selectPendingSkillHubEdit(namespace, slug);
    return row ? editIntent(row) : null;
  }

  async listPendingSkillHubEdits(limit = 20): Promise<SkillHubEditIntent[]> {
    this.ensureSkillHubStateSchema();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_edit_intents")
        .selectAll()
        .where("state", "=", "pending")
        .orderBy("updated_at")
        .orderBy("id")
        .limit(Math.max(1, Math.min(100, Math.trunc(limit) || 20))),
    ).rows.map(editIntent);
  }

  async recordSkillHubEditRecoveryAttempt(
    params: Parameters<SkillHubStateStore["recordSkillHubEditRecoveryAttempt"]>[0],
  ): Promise<void> {
    this.ensureSkillHubStateSchema();
    runImmediateTransaction(this.db, () => {
      const latest = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_edit_intents")
          .select("updated_at")
          .where("state", "=", "pending")
          .orderBy("updated_at", "desc")
          .limit(1),
      );
      // Scheduling rotates independently of the immutable request payload. A
      // monotonic tail prevents failed receipts starving newer edits after restart.
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_edit_intents")
          .set({ updated_at: Math.max(params.attemptedAt, (latest?.updated_at ?? 0) + 1) })
          .where("id", "=", params.id)
          .where("state", "=", "pending"),
      );
    });
  }

  async completeSkillHubEdit(
    params: Parameters<SkillHubStateStore["completeSkillHubEdit"]>[0],
  ): Promise<SkillHubEditCompletion> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const row = this.selectSkillHubEdit(params.id);
      if (!row) {
        throw new ControlPlaneStateError("Skill Hub edit does not exist");
      }
      const intent = editIntent(row);
      if (intent.state === "completed" && intent.result) {
        return { state: "completed" as const, result: intent.result };
      }
      if (intent.state !== "pending") {
        throw new ControlPlaneStateError("Skill Hub edit is no longer pending");
      }
      const current = this.selectSkillHubEditOwnership(intent.namespace, intent.slug);
      const moving = intent.namespace !== intent.targetNamespace;
      if (moving && this.selectSkillHubEditOwnership(intent.targetNamespace, intent.slug)) {
        throw new ControlPlaneConflictError(
          "skill_hub_owner_changed",
          "Skill Hub edit destination is occupied; administrator recovery is required",
        );
      }
      const sourceBinding = this.selectSkillHubEditBinding(intent.namespace);
      const targetBinding = this.selectSkillHubEditBinding(intent.targetNamespace);
      const actor = this.selectUserById(intent.actorUserId);
      const actorCanManage =
        actor?.status === "active" &&
        (actor.global_role === "admin" || actor.id === current?.owner_user_id);
      const ownerEligible = Boolean(
        current?.owner_user_id &&
        sourceBinding &&
        targetBinding &&
        this.isSkillHubNamespaceOwnerEligible(current.owner_user_id, sourceBinding) &&
        this.isSkillHubNamespaceOwnerEligible(current.owner_user_id, targetBinding),
      );
      const reconciliationRequired =
        Boolean(intent.privacy) ||
        !current ||
        current.updated_at !== intent.expectedOwnerUpdatedAt ||
        current.owner_user_id !== intent.originalOwnership.ownerUserId ||
        sourceBinding?.updated_at !== intent.expectedSourceBindingUpdatedAt ||
        targetBinding?.updated_at !== intent.expectedTargetBindingUpdatedAt ||
        !ownerEligible ||
        !actorCanManage ||
        (moving &&
          (!targetBinding ||
            !this.isSkillHubNamespaceOwnerEligible(intent.actorUserId, targetBinding)));
      if (reconciliationRequired) {
        const metadata = params.registryMetadata;
        this.requireSkillHubEditMetadata(intent, metadata);
        const privacy = intent.privacy ?? this.skillHubPrivacyRequest(intent, metadata!);
        if (!intent.privacy || params.privacyConfirmedOperationId !== privacy.operationId) {
          // Reservations remain pending until the registry itself is Private. Local
          // ownership alone cannot undo a committed registry edit or pending approval.
          const pending = { ...intent, privacy };
          this.saveSkillHubEditPrivacy(pending, params.changedAt);
          return { state: "privacy-required" as const, intent: pending };
        }
        if (metadata!.visibility !== "PRIVATE" || metadata!.effectiveVisibility !== "PRIVATE") {
          throw new ControlPlaneStateError("Registry privacy recovery has not been confirmed");
        }
      }
      const updatedAt = Math.max(
        params.changedAt,
        (current?.updated_at ?? intent.expectedOwnerUpdatedAt) + 1,
      );
      const next: SkillHubOwnershipRow = {
        namespace: intent.targetNamespace,
        slug: intent.slug,
        owner_user_id: reconciliationRequired ? null : current!.owner_user_id,
        previous_owner_user_id: reconciliationRequired
          ? (current?.owner_user_id ?? intent.originalOwnership.ownerUserId)
          : current!.previous_owner_user_id,
        visibility: reconciliationRequired ? "PRIVATE" : intent.visibility,
        current_version: current?.current_version ?? intent.originalOwnership.currentVersion,
        updated_at: updatedAt,
      };
      if (moving) {
        // Insert the new parent before moving children: the old foreign keys have
        // delete cascades, so deleting or renaming the source first loses ACLs/jobs.
        executeSync(this.db, this.query.insertInto("skill_hub_skill_ownership").values(next));
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_skill_access")
            .set({ namespace: intent.targetNamespace })
            .where("namespace", "=", intent.namespace)
            .where("slug", "=", intent.slug),
        );
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_governance_jobs")
            .set({ namespace: intent.targetNamespace })
            .where("namespace", "=", intent.namespace)
            .where("slug", "=", intent.slug),
        );
        executeSync(
          this.db,
          this.query
            .deleteFrom("skill_hub_skill_ownership")
            .where("namespace", "=", intent.namespace)
            .where("slug", "=", intent.slug),
        );
      } else {
        executeSync(
          this.db,
          this.query
            .insertInto("skill_hub_skill_ownership")
            .values(next)
            .onConflict((conflict) => conflict.columns(["namespace", "slug"]).doUpdateSet(next)),
        );
      }
      if (reconciliationRequired || intent.visibility === "PRIVATE") {
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_governance_jobs")
            .set({
              state: "blocked",
              last_error: reconciliationRequired ? "owner-review-required" : "visibility-private",
              updated_at: updatedAt,
            })
            .where("namespace", "=", intent.targetNamespace)
            .where("slug", "=", intent.slug)
            .where("state", "=", "pending"),
        );
      } else {
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_governance_jobs")
            .set({
              state: "pending",
              owner_user_id: next.owner_user_id,
              next_attempt_at: updatedAt,
              last_error: null,
              updated_at: updatedAt,
            })
            .where("namespace", "=", intent.targetNamespace)
            .where("slug", "=", intent.slug)
            .where("state", "=", "blocked")
            .where("last_error", "=", "visibility-private"),
        );
      }
      if (intent.visibility !== "PRIVATE") {
        // The registry prepares the current review round. Its explicit list
        // reopens old decisions; current audits and atomic SAFE approval gate it.
        if (params.reviewVersions?.length) {
          executeSync(
            this.db,
            this.query
              .updateTable("skill_hub_governance_jobs")
              .set({
                state: reconciliationRequired ? "blocked" : "pending",
                owner_user_id: next.owner_user_id,
                attempts: 0,
                next_attempt_at: updatedAt,
                last_error: reconciliationRequired ? "owner-review-required" : null,
                updated_at: updatedAt,
              })
              .where("namespace", "=", intent.targetNamespace)
              .where("slug", "=", intent.slug)
              .where("version", "in", [...params.reviewVersions]),
          );
        }
        const reviewVersions = new Set([next.current_version, ...(params.reviewVersions ?? [])]);
        for (const version of reviewVersions) {
          executeSync(
            this.db,
            this.query
              .insertInto("skill_hub_governance_jobs")
              .values({
                namespace: intent.targetNamespace,
                slug: intent.slug,
                version,
                owner_user_id: next.owner_user_id,
                state: reconciliationRequired ? "blocked" : "pending",
                attempts: 0,
                next_attempt_at: updatedAt,
                last_error: reconciliationRequired ? "owner-review-required" : null,
                updated_at: updatedAt,
              })
              .onConflict((conflict) =>
                conflict.columns(["namespace", "slug", "version"]).doNothing(),
              ),
          );
        }
      }
      const result = {
        ownership: projectSkillHubOwnership(next),
        reconciliationRequired,
        ...(params.publicationPending ? { publicationPending: true } : {}),
      };
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_edit_intents")
          .set({ state: "completed", result_json: JSON.stringify(result), updated_at: updatedAt })
          .where("id", "=", intent.id),
      );
      this.insertAudit(
        intent.actorUserId,
        "skill-hub.edit.completed",
        "skill-hub-skill",
        `${intent.targetNamespace}/${intent.slug}`,
        updatedAt,
        {
          editId: intent.id,
          sourceNamespace: intent.namespace,
          targetNamespace: intent.targetNamespace,
          visibility: next.visibility,
          reconciliationRequired,
        },
      );
      if (reconciliationRequired) {
        this.notifySkillHubEditReview(intent, updatedAt);
      }
      return { state: "completed" as const, result };
    });
  }

  async rebaseSkillHubEditPrivacy(
    params: Parameters<SkillHubStateStore["rebaseSkillHubEditPrivacy"]>[0],
  ): Promise<SkillHubEditIntent> {
    this.ensureSkillHubStateSchema();
    return runImmediateTransaction(this.db, () => {
      const row = this.selectSkillHubEdit(params.id);
      const intent = row ? editIntent(row) : null;
      if (
        intent?.state !== "pending" ||
        intent.privacy?.operationId !== params.expectedOperationId
      ) {
        throw new ControlPlaneStateError("Skill Hub privacy recovery attempt changed");
      }
      this.requireSkillHubEditMetadata(intent, params.metadata);
      // Only a definitive registry CAS rejection permits a new request. An unknown
      // outcome must replay the stored UUID and exact body across process restarts.
      const pending = { ...intent, privacy: this.skillHubPrivacyRequest(intent, params.metadata) };
      this.saveSkillHubEditPrivacy(pending, params.changedAt);
      return pending;
    });
  }

  private requireSkillHubEditMetadata(
    intent: SkillHubEditIntent,
    metadata: Parameters<SkillHubStateStore["completeSkillHubEdit"]>[0]["registryMetadata"],
  ) {
    if (
      !metadata ||
      metadata.id !== intent.skillId ||
      metadata.namespace !== intent.targetNamespace ||
      metadata.slug !== intent.slug
    ) {
      throw new ControlPlaneStateError("Registry privacy recovery skill identity does not match");
    }
  }

  private skillHubPrivacyRequest(
    intent: SkillHubEditIntent,
    metadata: NonNullable<
      Parameters<SkillHubStateStore["completeSkillHubEdit"]>[0]["registryMetadata"]
    >,
  ) {
    return {
      operationId: randomUUID(),
      skillId: intent.skillId,
      namespace: intent.targetNamespace,
      slug: intent.slug,
      expectedRevision: metadata.revision,
      targetNamespace: intent.targetNamespace,
      displayName: metadata.displayName,
      summary: metadata.summary,
      visibility: "PRIVATE" as const,
    };
  }

  private saveSkillHubEditPrivacy(intent: SkillHubEditIntent, changedAt: number) {
    const payload = { ...intent, state: undefined, result: undefined };
    executeSync(
      this.db,
      this.query
        .updateTable("skill_hub_edit_intents")
        .set({ payload_json: JSON.stringify(payload), updated_at: changedAt })
        .where("id", "=", intent.id)
        .where("state", "=", "pending"),
    );
  }

  async cancelSkillHubEdit(
    params: Parameters<SkillHubStateStore["cancelSkillHubEdit"]>[0],
  ): Promise<void> {
    this.ensureSkillHubStateSchema();
    runImmediateTransaction(this.db, () => {
      const actor = this.requireUserRow(params.actorUserId);
      const row = this.selectSkillHubEdit(params.id);
      if (!row || row.state !== "pending") {
        return;
      }
      const intent = editIntent(row);
      if (intent.privacy) {
        throw new ControlPlaneStateError(
          "Registry privacy recovery must finish before releasing this edit",
        );
      }
      if (actor.global_role !== "admin" && actor.id !== intent.actorUserId) {
        throw new ControlPlaneStateError("Skill Hub edit actor or administrator required");
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_edit_intents")
          .set({ state: "cancelled", updated_at: params.changedAt })
          .where("id", "=", params.id),
      );
      this.insertAudit(
        params.actorUserId,
        "skill-hub.edit.cancelled",
        "skill-hub-skill",
        `${intent.namespace}/${intent.slug}`,
        params.changedAt,
        { editId: intent.id, reason: params.reason },
      );
    });
  }

  private selectSkillHubEdit(id: string) {
    return takeFirstSync(
      this.db,
      this.query.selectFrom("skill_hub_edit_intents").selectAll().where("id", "=", id),
    );
  }

  private selectSkillHubEditOwnership(namespace: string, slug: string) {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_skill_ownership")
        .selectAll()
        .where("namespace", "=", namespace)
        .where("slug", "=", slug),
    );
  }

  private selectSkillHubEditBinding(namespace: string) {
    return takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_namespace_bindings")
        .selectAll()
        .where("namespace", "=", namespace),
    );
  }

  private notifySkillHubEditReview(intent: SkillHubEditIntent, changedAt: number) {
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
          namespace: intent.targetNamespace,
          slug: intent.slug,
          message: `${intent.targetNamespace}/${intent.slug} needs ownership review after a concurrent skill edit change.`,
          created_at: changedAt,
          read_at: null,
        }),
      );
    }
  }
}
