import { randomUUID } from "node:crypto";
import {
  ControlPlaneConflictError,
  ControlPlaneAuthorizationError,
  ControlPlaneNotFoundError,
  ControlPlaneStateError,
} from "./contracts.js";
import {
  executeSync,
  runImmediateTransaction,
  runReadTransaction,
  takeFirstSync,
} from "./kysely-sync.js";
import type {
  SkillHubCatalogStore,
  SkillHubPublicationReceipt,
  SkillHubSharing,
} from "./skill-hub-catalog-state.js";
import type {
  SkillHubCatalogPublicationRow,
  SkillHubCatalogRow,
} from "./sqlite-schema-skill-hub-catalog.js";
import { ensureSkillHubNotificationSchema } from "./sqlite-schema.js";
import { SqliteSkillHubCatalogCore } from "./sqlite-skill-hub-catalog-core.js";
const PUBLIC_SHARING: SkillHubSharing = { mode: "PUBLIC", userIds: [], scopeIds: [] };
function receipt(row: SkillHubCatalogPublicationRow): SkillHubPublicationReceipt {
  return {
    operationId: row.operation_id,
    skillId: row.skill_id,
    actorUserId: row.actor_user_id,
    version: row.version,
    fingerprint: row.fingerprint,
    expectedRevision: row.expected_revision,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteSkillHubCatalogArtifacts extends SqliteSkillHubCatalogCore {
  async blockVersion(params: Parameters<SkillHubCatalogStore["blockVersion"]>[0]) {
    this.ensure();
    ensureSkillHubNotificationSchema(this.db);
    return runImmediateTransaction(this.db, () => {
      const row = this.row(params.skillId);
      const recorded =
        Number(
          executeSync(
            this.db,
            this.query
              .insertInto("skill_hub_catalog_blocked_versions")
              .values({
                skill_id: row.id,
                version: params.version,
                reason: params.reason,
                recorded_at: params.now,
              })
              .onConflict((conflict) => conflict.columns(["skill_id", "version"]).doNothing()),
          ).numAffectedRows,
        ) > 0;
      if (recorded) {
        this.history(
          row,
          null,
          "version-blocked",
          params.now,
          { reason: params.reason },
          true,
          params.version,
        );
        if (row.owner_user_id !== null) {
          // The durable block, audit, and owner outcome commit together. A crash
          // must not leave a recorded block whose notification can never retry.
          executeSync(
            this.db,
            this.query.insertInto("skill_hub_notifications").values({
              id: randomUUID(),
              user_id: row.owner_user_id,
              kind: "malware-blocked",
              namespace: row.namespace,
              slug: row.slug,
              message:
                "A Skill Hub version was blocked as confirmed malware. Open Skill Hub to review its history.",
              created_at: params.now,
              read_at: null,
            }),
          );
        }
      }
      return recorded;
    });
  }

  async getBlockedVersions(skillId: string) {
    this.ensure();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_blocked_versions")
        .select("version")
        .where("skill_id", "=", skillId)
        .orderBy("version"),
    ).rows.map((row) => row.version);
  }

  async recordInstallation(params: Parameters<SkillHubCatalogStore["recordInstallation"]>[0]) {
    this.ensure();
    if (
      !/^[a-f0-9]{64}$/u.test(params.archiveSha256) ||
      !params.targetId.trim() ||
      (params.destination === "platform_server") !== (params.targetId === "platform-server") ||
      (params.installedRevision !== undefined &&
        !/^sha256:[a-f0-9]{16}$/u.test(params.installedRevision))
    ) {
      throw new ControlPlaneStateError("Invalid installed skill identity");
    }
    // Persist before the filesystem effect. A lost reply must leave a pending
    // origin that the next room run excludes, never an untracked executable copy.
    const operationId = params.operationId ?? randomUUID();
    executeSync(
      this.db,
      this.query
        .insertInto("skill_hub_catalog_installations")
        .values({
          operation_id: operationId,
          agent_id: params.agentId,
          destination: params.destination,
          target_id: params.targetId,
          slug: params.slug,
          skill_id: params.skillId,
          version: params.version,
          archive_sha256: params.archiveSha256,
          installed_revision: params.installedRevision ?? null,
          installed_at: params.installedAt,
          state: params.state ?? "pending",
        })
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "destination", "target_id", "slug"]).doUpdateSet({
            operation_id: operationId,
            skill_id: params.skillId,
            version: params.version,
            archive_sha256: params.archiveSha256,
            installed_revision: params.installedRevision ?? null,
            installed_at: params.installedAt,
            state: params.state ?? "pending",
          }),
        ),
    );
    return {
      ...params,
      operationId,
      installedRevision: params.installedRevision ?? null,
      state: params.state ?? "pending",
    };
  }

  async completeInstallation(params: Parameters<SkillHubCatalogStore["completeInstallation"]>[0]) {
    this.ensure();
    if (
      params.installedRevision !== undefined &&
      !/^sha256:[a-f0-9]{16}$/u.test(params.installedRevision)
    ) {
      throw new ControlPlaneStateError("Invalid installed skill revision");
    }
    const completed = Number(
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog_installations")
          .set({
            state: "completed",
            installed_revision: params.installedRevision ?? null,
            installed_at: params.now,
          })
          .where("agent_id", "=", params.agentId)
          .where("destination", "=", params.destination)
          .where("target_id", "=", params.targetId)
          .where("slug", "=", params.slug)
          .where("operation_id", "=", params.operationId)
          .where("skill_id", "=", params.skillId)
          .where("version", "=", params.version)
          .where("archive_sha256", "=", params.archiveSha256),
      ).numAffectedRows,
    );
    if (completed === 0) {
      throw new ControlPlaneConflictError(
        "skill-hub-installation-changed",
        "Another installation replaced this pending operation",
      );
    }
  }

  async listInstallations(agentId: string, targetId: string) {
    this.ensure();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_installations")
        .selectAll()
        .where("agent_id", "=", agentId)
        .where("target_id", "=", targetId)
        .orderBy("destination")
        .orderBy("slug"),
    ).rows.map((row) => ({
      operationId: row.operation_id,
      agentId: row.agent_id,
      destination: row.destination,
      targetId: row.target_id,
      slug: row.slug,
      skillId: row.skill_id,
      version: row.version,
      archiveSha256: row.archive_sha256,
      installedRevision: row.installed_revision,
      installedAt: row.installed_at,
      state: row.state,
    }));
  }

  async removeInstallation(params: Parameters<SkillHubCatalogStore["removeInstallation"]>[0]) {
    this.ensure();
    let query = this.query
      .deleteFrom("skill_hub_catalog_installations")
      .where("agent_id", "=", params.agentId)
      .where("destination", "=", params.destination)
      .where("target_id", "=", params.targetId)
      .where("slug", "=", params.slug);
    if (params.operationId !== undefined) {
      query = query.where("operation_id", "=", params.operationId);
    }
    executeSync(this.db, query);
  }

  async getPublication(operationId: string) {
    this.ensure();
    const row = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_publications")
        .selectAll()
        .where("operation_id", "=", operationId),
    );
    return row ? receipt(row) : null;
  }

  async roomExcludedSlugs(agentId: string): Promise<string[]> {
    this.ensure();
    return runReadTransaction(this.db, () => {
      const binding = takeFirstSync(
        this.db,
        this.query
          .selectFrom("agent_bindings")
          .select(["kind", "state"])
          .where("agent_id", "=", agentId),
      );
      if (binding?.state !== "active") {
        throw new ControlPlaneAuthorizationError(
          "Skill Hub run authorization requires an active Agent binding",
        );
      }
      if (binding.kind === "personal") {
        return [];
      }
      const origins = executeSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog_installations as origin")
          .leftJoin("skill_hub_catalog as skill", "skill.id", "origin.skill_id")
          .leftJoin("skill_hub_catalog_blocked_versions as blocked", (join) =>
            join
              .onRef("blocked.skill_id", "=", "origin.skill_id")
              .onRef("blocked.version", "=", "origin.version"),
          )
          .select([
            "origin.slug",
            "origin.state",
            "origin.installed_revision",
            "skill.id",
            "skill.deleted_at",
            "skill.purged_at",
            "skill.purge_pending",
            "skill.sharing_mode",
            "skill.current_version",
            "blocked.version as blocked_version",
          ])
          .where("origin.agent_id", "=", agentId)
          .where("origin.destination", "=", "platform_server")
          .where("origin.target_id", "=", "platform-server"),
      ).rows;
      return [
        ...new Set(
          origins
            .filter(
              (origin) =>
                origin.state !== "completed" ||
                origin.installed_revision === null ||
                origin.id === null ||
                origin.deleted_at !== null ||
                origin.purged_at !== null ||
                origin.purge_pending !== 0 ||
                origin.sharing_mode !== "PUBLIC" ||
                origin.current_version === null ||
                origin.blocked_version !== null,
            )
            .map((origin) => origin.slug),
        ),
      ];
    });
  }

  async listPendingPublications(limit = 20) {
    this.ensure();
    return executeSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_publications")
        .selectAll()
        .where("state", "=", "pending")
        .orderBy("created_at")
        .limit(limit),
    ).rows.map(receipt);
  }

  async listRecoverablePublications(actorUserId: string) {
    this.ensure();
    return runReadTransaction(this.db, () => {
      const actor = this.user(actorUserId);
      const query = this.query
        .selectFrom("skill_hub_catalog_publications as publication")
        .innerJoin("skill_hub_catalog as skill", "skill.id", "publication.skill_id")
        .selectAll("publication")
        .select(["skill.owner_user_id", "skill.display_name", "skill.slug"])
        .where("publication.state", "=", "pending")
        .orderBy("publication.created_at")
        .orderBy("publication.operation_id");
      // Recovery belongs to the current manager, including the owner when an
      // administrator started the upload. A maintenance batch is not a UI cap.
      return executeSync(
        this.db,
        actor.global_role === "admin" ? query : query.where("skill.owner_user_id", "=", actor.id),
      ).rows.map((row) =>
        Object.assign(receipt(row), {
          ownerUserId: row.owner_user_id,
          displayName: row.display_name,
          slug: row.slug,
        }),
      );
    });
  }

  async claimPendingPublications(limit = 20) {
    this.ensure();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ControlPlaneStateError("Invalid publication maintenance limit");
    }
    return runImmediateTransaction(this.db, () => {
      const cursor = this.maintenanceCursor("publication");
      const query = this.query
        .selectFrom("skill_hub_catalog_publications")
        .selectAll()
        .where("state", "=", "pending")
        .orderBy("operation_id");
      const rows = executeSync(
        this.db,
        (cursor === null ? query : query.where("operation_id", ">", cursor)).limit(limit),
      ).rows;
      if (cursor !== null && rows.length < limit) {
        rows.push(
          ...executeSync(
            this.db,
            query.where("operation_id", "<=", cursor).limit(limit - rows.length),
          ).rows,
        );
      }
      // Advance before external I/O. A failed oldest item cannot monopolize the
      // next batch, and a process restart resumes the same fair rotation.
      this.advanceMaintenanceCursor("publication", rows.at(-1)?.operation_id);
      return rows.map(receipt);
    });
  }

  async bindRegistryIdentity(params: Parameters<SkillHubCatalogStore["bindRegistryIdentity"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      const row = this.row(params.skillId);
      if (
        !Number.isSafeInteger(params.registryId) ||
        params.registryId < 1 ||
        row.namespace !== params.expectedNamespace ||
        row.slug !== params.expectedSlug ||
        row.purged_at !== null ||
        (row.registry_id !== null && row.registry_id !== params.registryId)
      ) {
        throw new ControlPlaneConflictError(
          "skill-hub-native-identity-changed",
          "Registry skill identity changed",
        );
      }
      if (row.registry_id === null) {
        // Discovery must commit before deletion: after a lost native reply the
        // immutable ID is the only authority for its durable cleanup receipt.
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_catalog")
            .set({ registry_id: params.registryId })
            .where("id", "=", row.id)
            .where("registry_id", "is", null),
        );
      }
      return this.entry(this.row(row.id));
    });
  }

  async reservePublication(params: Parameters<SkillHubCatalogStore["reservePublication"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      this.user(params.actorUserId);
      const prior = takeFirstSync(
        this.db,
        this.query
          .selectFrom("skill_hub_catalog_publications")
          .selectAll()
          .where("operation_id", "=", params.operationId),
      );
      if (prior) {
        const row = this.row(prior.skill_id);
        if (
          prior.actor_user_id !== params.actorUserId ||
          prior.fingerprint !== params.fingerprint ||
          prior.version !== params.version ||
          row.slug !== params.slug ||
          (params.skillId !== undefined && prior.skill_id !== params.skillId)
        ) {
          throw new ControlPlaneConflictError(
            "skill-hub-publication-changed",
            "This publication ID belongs to another request",
          );
        }
        this.manager(row, params.actorUserId);
        this.administratorReason(row, params.actorUserId, params.reason);
        this.available(row);
        if (prior.state === "cancelled") {
          throw new ControlPlaneConflictError(
            "skill-hub-publication-cancelled",
            "This publication was cancelled; start a new publication",
          );
        }
        if (prior.state === "pending") {
          this.revision(row, prior.expected_revision);
        }
        return { entry: this.entry(row), receipt: receipt(prior), reused: true };
      }
      let row: SkillHubCatalogRow;
      if (params.skillId) {
        if (params.sharing !== undefined) {
          throw new ControlPlaneStateError(
            "Change sharing in the skill details before publishing a new version",
          );
        }
        row = this.row(params.skillId);
        this.manager(row, params.actorUserId);
        this.administratorReason(row, params.actorUserId, params.reason);
        this.available(row);
        this.revision(row, params.expectedRevision ?? -1);
        if (row.slug !== params.slug) {
          throw new ControlPlaneStateError("Published skill package name cannot change");
        }
        this.noPublication(row.id);
      } else {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(params.operationId)) {
          throw new ControlPlaneStateError("Publication operation ID must be a UUID");
        }
        row = {
          id: params.operationId,
          registry_id: null,
          namespace: `pc-${params.operationId}`,
          slug: params.slug,
          owner_user_id: params.actorUserId,
          display_name: params.displayName ?? params.slug,
          summary: params.summary ?? "",
          tags_json: "[]",
          sharing_mode: (params.sharing ?? PUBLIC_SHARING).mode,
          revision: 1,
          current_version: null,
          created_at: params.now,
          updated_at: params.now,
          deleted_at: null,
          purged_at: null,
          purge_pending: 0,
          pending_transfer_user_id: null,
        };
        executeSync(this.db, this.query.insertInto("skill_hub_catalog").values(row));
        this.recordCoordinate(row);
        this.setSharing(row.id, params.sharing ?? PUBLIC_SHARING);
      }
      const publication: SkillHubCatalogPublicationRow = {
        operation_id: params.operationId,
        skill_id: row.id,
        actor_user_id: params.actorUserId,
        version: params.version,
        fingerprint: params.fingerprint,
        expected_revision: row.revision,
        state: "pending",
        created_at: params.now,
        updated_at: params.now,
      };
      executeSync(
        this.db,
        this.query.insertInto("skill_hub_catalog_publications").values(publication),
      );
      const reason = this.administratorReason(row, params.actorUserId, params.reason);
      if (reason) {
        this.history(
          row,
          params.actorUserId,
          "administrator-publication-requested",
          params.now,
          { reason },
          true,
          params.version,
        );
      }
      return { entry: this.entry(row), receipt: receipt(publication), reused: false };
    });
  }

  private publication(operationId: string, requireActiveManager = true) {
    const publication = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_publications")
        .selectAll()
        .where("operation_id", "=", operationId),
    );
    if (!publication) {
      throw new ControlPlaneNotFoundError("skill-hub-publication", operationId);
    }
    const row = this.row(publication.skill_id);
    if (requireActiveManager) {
      this.manager(row, publication.actor_user_id);
    }
    this.available(row);
    if (publication.state === "cancelled") {
      throw new ControlPlaneConflictError(
        "skill-hub-publication-cancelled",
        "This publication was cancelled",
      );
    }
    if (publication.state === "pending") {
      this.revision(row, publication.expected_revision);
    }
    return { publication, row };
  }

  async validatePublication(operationId: string) {
    this.ensure();
    return this.entry(this.publication(operationId).row);
  }

  async completePublication(params: Parameters<SkillHubCatalogStore["completePublication"]>[0]) {
    this.ensure();
    return runImmediateTransaction(this.db, () => {
      if (!Number.isSafeInteger(params.registryId) || params.registryId < 1) {
        throw new ControlPlaneStateError("Invalid registry skill identity");
      }
      // Completion records an already committed immutable effect. The original
      // publisher may since be disabled; live authority is checked before upload.
      const { row, publication } = this.publication(params.operationId, false);
      if (row.registry_id !== null && row.registry_id !== params.registryId) {
        throw new ControlPlaneStateError("Registry skill identity changed during publication");
      }
      if (publication.state === "completed") {
        return this.entry(row);
      }
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog")
          .set({
            registry_id: params.registryId,
            current_version: publication.version,
            revision: row.revision + 1,
            updated_at: params.now,
          })
          .where("id", "=", row.id),
      );
      executeSync(
        this.db,
        this.query
          .updateTable("skill_hub_catalog_publications")
          .set({ state: "completed", updated_at: params.now })
          .where("operation_id", "=", params.operationId),
      );
      this.history(
        row,
        publication.actor_user_id,
        "version-published",
        params.now,
        {},
        false,
        publication.version,
      );
      return this.entry(this.row(row.id));
    });
  }

  private cancellation(
    params: Parameters<SkillHubCatalogStore["authorizePublicationCancellation"]>[0],
  ) {
    const publication = takeFirstSync(
      this.db,
      this.query
        .selectFrom("skill_hub_catalog_publications")
        .selectAll()
        .where("operation_id", "=", params.operationId),
    );
    if (!publication) {
      throw new ControlPlaneNotFoundError("skill-hub-publication", params.operationId);
    }
    const row = this.row(publication.skill_id);
    this.manager(row, params.actorUserId);
    const reason = this.administratorReason(row, params.actorUserId, params.reason);
    if (publication.state === "completed") {
      throw new ControlPlaneConflictError(
        "skill-hub-publication-completed",
        "This publication already completed; refresh Skill Hub",
      );
    }
    return { publication, row, reason };
  }

  async authorizePublicationCancellation(
    params: Parameters<SkillHubCatalogStore["authorizePublicationCancellation"]>[0],
  ) {
    this.ensure();
    return runReadTransaction(this.db, () => receipt(this.cancellation(params).publication));
  }

  async cancelPublication(params: Parameters<SkillHubCatalogStore["cancelPublication"]>[0]) {
    this.ensure();
    runImmediateTransaction(this.db, () => {
      const { publication, row, reason } = this.cancellation(params);
      if (publication.state === "pending") {
        executeSync(
          this.db,
          this.query
            .updateTable("skill_hub_catalog_publications")
            .set({ state: "cancelled", updated_at: params.now })
            .where("operation_id", "=", params.operationId),
        );
        if (row.current_version === null && row.deleted_at === null) {
          // A cancelled first upload may already have created private native
          // content. Keep its identity visible in trash until normal purge.
          executeSync(
            this.db,
            this.query
              .updateTable("skill_hub_catalog")
              .set({
                deleted_at: params.now,
                pending_transfer_user_id: null,
                revision: row.revision + 1,
                updated_at: params.now,
              })
              .where("id", "=", row.id),
          );
        }
        this.history(
          row,
          params.actorUserId,
          "publication-cancelled",
          params.now,
          reason ? { reason } : {},
          true,
          publication.version,
        );
      }
    });
  }
}
