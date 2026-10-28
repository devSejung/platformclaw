import path from "node:path";
import { ControlPlaneAuthorizationError, type PlatformUser } from "./contracts.js";
import type { SkillHubSharing, SkillHubCatalogIcon } from "./skill-hub-catalog-state.js";
import { SkillHubCommandService } from "./skill-hub-command-service.js";
import { workspaceForAgent } from "./skill-hub-command-workspace.js";
import { SkillHubServiceError } from "./skill-hub-service-support.js";

export {
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SKILL_HUB_UPLOAD_ENTRY_BYTES,
  SKILL_HUB_UPLOAD_ENTRIES,
  SKILL_HUB_UPLOAD_EXPANDED_BYTES,
  MAX_SKILL_FILES,
  SkillHubServiceError,
} from "./skill-hub-service-support.js";
export type { AuthenticatedWorkspace, SkillInstallTarget } from "./skill-hub-service-support.js";

export class SkillHubService extends SkillHubCommandService {
  async roomSkills(
    agentId: string,
    candidates: Array<{ name: string; filePath: string; sourceFilePath?: string }>,
  ) {
    const bindings = await this.options.store.listAgentBindingsByState("active");
    const binding = bindings.find((item) => item.agentId === agentId);
    if (!binding) {
      throw new SkillHubServiceError("Active Agent binding is unavailable", 409);
    }
    if (binding.kind !== "knox-room") {
      return { excludedPaths: [] as string[] };
    }
    await this.initializeCatalog();
    const origins = await this.options.store.skillHubCatalog.listInstallations(
      agentId,
      "platform-server",
    );
    const workspaceDir = workspaceForAgent(this.options.workspaceRoot, agentId);
    const originsByPath = new Map(
      origins
        .filter((origin) => origin.destination === "platform_server")
        .map((origin) => [path.join(workspaceDir, "skills", origin.slug, "SKILL.md"), origin]),
    );
    // A folder basename is not provenance: local, bundled, and node skills can
    // share it, and materialization can rename it. Match the original installed
    // file in this admitted room's canonical workspace instead of its run path.
    const matched = candidates.flatMap((candidate) => {
      const sourceFilePath = candidate.sourceFilePath ?? candidate.filePath;
      const origin = path.isAbsolute(sourceFilePath)
        ? originsByPath.get(path.normalize(sourceFilePath))
        : undefined;
      return origin ? [{ candidate, origin }] : [];
    });
    // Provenance outlives discovery: disabled, malformed, or shadowed packages
    // must retain the same room access boundary as visible candidates.
    const relevant = origins.filter((origin) => origin.destination === "platform_server");
    for (const origin of relevant) {
      const entry = await this.options.store.skillHubCatalog.get(origin.skillId);
      if (
        entry &&
        entry.deletedAt === null &&
        entry.purgedAt === null &&
        entry.sharing.mode === "PUBLIC"
      ) {
        const blocked = await this.options.store.skillHubCatalog.getBlockedVersions(entry.id);
        if (!blocked.includes(origin.version)) {
          // A failed scanner round is unverified evidence. Loss of the artifact
          // authority itself must fail closed instead of reusing an older decision.
          await this.versionScans(entry);
        }
      }
    }
    let excluded: Set<string>;
    try {
      excluded = new Set(await this.options.store.skillHubCatalog.roomExcludedSlugs(agentId));
    } catch (error) {
      if (error instanceof ControlPlaneAuthorizationError) {
        throw new SkillHubServiceError("Active Agent binding is unavailable", 409);
      }
      throw error;
    }
    return {
      excludedPaths: matched
        .filter(({ origin }) => excluded.has(origin.slug))
        .map(({ candidate }) => candidate.filePath),
      excludedSourceDirectories: [...excluded].map((slug) => {
        const directory = path.join(workspaceDir, "skills", slug);
        if (path.dirname(directory) !== path.join(workspaceDir, "skills")) {
          throw new SkillHubServiceError("Installed skill provenance is invalid", 503);
        }
        return directory;
      }),
    };
  }

  async updateMetadata(
    user: PlatformUser,
    id: string,
    params: {
      expectedRevision: number;
      reason?: string;
      displayName?: string;
      summary?: string;
      tags?: string[];
      sharing?: SkillHubSharing;
    },
  ) {
    const entry = await this.options.store.skillHubCatalog.updateMetadata({
      ...params,
      skillId: id,
      actorUserId: user.id,
      now: this.now(),
    });
    return { ok: true, id: entry.id, revision: entry.revision };
  }

  async updateIcon(
    user: PlatformUser,
    id: string,
    expectedRevision: number,
    icon: SkillHubCatalogIcon | null,
    reason?: string,
  ) {
    const entry = await this.options.store.skillHubCatalog.updateMetadata({
      skillId: id,
      actorUserId: user.id,
      expectedRevision,
      now: this.now(),
      icon,
      reason,
    });
    return { ok: true, id: entry.id, revision: entry.revision };
  }

  async icon(user: PlatformUser, id: string) {
    await this.requireEntry(user, id);
    const icon = await this.options.store.skillHubCatalog.getIcon(id);
    if (!icon) {
      throw new SkillHubServiceError("Skill icon not found", 404);
    }
    await this.requireEntry(user, id);
    return icon;
  }

  async users(user: PlatformUser, query: string) {
    return {
      users: await this.options.store.skillHubCatalog.searchUsers({
        actorUserId: user.id,
        query,
        limit: 50,
      }),
    };
  }

  async history(user: PlatformUser, id: string) {
    const rows = await this.options.store.skillHubCatalog.listHistory({
      skillId: id,
      actorUserId: user.id,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        action: row.action,
        version: row.version ?? undefined,
        actor: row.actorUserId
          ? { id: row.actorUserId, ...(row.actorName ? { displayName: row.actorName } : {}) }
          : null,
        createdAt: row.createdAt,
        details: row.details,
      })),
    };
  }

  async trash(user: PlatformUser) {
    const current = await this.activeUser(user.id);
    const entries = (await this.options.store.skillHubCatalog.list()).filter(
      (entry) =>
        entry.deletedAt !== null &&
        entry.purgedAt === null &&
        (current.globalRole === "admin" || entry.ownerUserId === current.id),
    );
    return {
      items: await Promise.all(
        entries.map(async (entry) =>
          Object.assign(await this.projectEntry(entry, current), {
            deletedAt: entry.deletedAt,
            purgeAt: entry.deletedAt! + 30 * 24 * 60 * 60_000,
            purgePending: entry.purgePending,
          }),
        ),
      ),
    };
  }

  async deletePublishedSkill(
    user: PlatformUser,
    id: string,
    expectedRevision: number,
    reason?: string,
  ) {
    const entry = await this.options.store.skillHubCatalog.trash({
      skillId: id,
      actorUserId: user.id,
      expectedRevision,
      reason,
      now: this.now(),
    });
    this.triggerGovernanceProcessing();
    return { ok: true, id, revision: entry.revision };
  }

  async restore(user: PlatformUser, id: string, expectedRevision: number, reason?: string) {
    const entry = await this.options.store.skillHubCatalog.restore({
      skillId: id,
      actorUserId: user.id,
      expectedRevision,
      reason,
      now: this.now(),
    });
    return { ok: true, id, revision: entry.revision };
  }

  async requestTransfer(
    user: PlatformUser,
    id: string,
    expectedRevision: number,
    userId: string,
    reason?: string,
  ) {
    const entry = await this.options.store.skillHubCatalog.requestTransfer({
      skillId: id,
      actorUserId: user.id,
      expectedRevision,
      recipientUserId: userId,
      reason,
      now: this.now(),
    });
    return { ok: true, id, revision: entry.revision };
  }

  async transfers(user: PlatformUser) {
    const entries = await this.options.store.skillHubCatalog.listTransfers(user.id);
    return {
      items: await Promise.all(
        entries.map(async (entry) => {
          const owner = entry.ownerUserId
            ? await this.options.store.getUserById(entry.ownerUserId)
            : null;
          return {
            id: entry.id,
            displayName: entry.displayName,
            revision: entry.revision,
            from: owner
              ? {
                  id: owner.id,
                  accountId: owner.accountId,
                  ...(owner.displayName ? { displayName: owner.displayName } : {}),
                }
              : null,
          };
        }),
      ),
    };
  }

  async acceptTransfer(user: PlatformUser, id: string, expectedRevision: number, reason?: string) {
    const entry = await this.options.store.skillHubCatalog.acceptTransfer({
      skillId: id,
      actorUserId: user.id,
      expectedRevision,
      reason,
      now: this.now(),
    });
    return { ok: true, id, revision: entry.revision };
  }

  async cancelPublication(user: PlatformUser, operationId: string, reason?: string) {
    const catalog = this.options.store.skillHubCatalog;
    const params = { operationId, actorUserId: user.id, reason };
    const receipt = await catalog.authorizePublicationCancellation(params);
    const entry = await this.requireManager(user, receipt.skillId);
    return await this.withRegistryMutationLock(entry.namespace, entry.slug, async () => {
      await catalog.authorizePublicationCancellation(params);
      if (await this.reconcilePublication(operationId)) {
        throw new SkillHubServiceError(
          "This publication already completed; refresh Skill Hub",
          409,
        );
      }
      await catalog.cancelPublication({ ...params, now: this.now() });
      return { ok: true };
    });
  }

  async notifications(user: PlatformUser, limit = 50) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SkillHubServiceError("Notification limit must be 1 to 100", 400);
    }
    return {
      items: await this.options.store.listSkillHubNotifications(user.id, limit),
      unreadCount: await this.options.store.countUnreadSkillHubNotifications(user.id),
    };
  }

  async markNotificationsRead(user: PlatformUser, ids?: readonly string[]) {
    if (
      ids &&
      (ids.length > 100 || ids.some((id) => typeof id !== "string" || !id || id.length > 128))
    ) {
      throw new SkillHubServiceError("Invalid notification IDs", 400);
    }
    return {
      ok: true,
      updated: await this.options.store.markSkillHubNotificationsRead({
        userId: user.id,
        ids,
        readAt: this.now(),
      }),
    };
  }

  override async processGovernanceQueue(): Promise<{ processed: number }> {
    if (this.governanceClosed || this.governanceProcessing) {
      return { processed: 0 };
    }
    this.governanceProcessing = true;
    let processed = 0;
    this.maintenanceError = null;
    try {
      const catalog = this.options.store.skillHubCatalog;
      for (const receipt of await catalog.claimPendingPublications(20)) {
        const entry = await catalog.get(receipt.skillId);
        if (!entry) {
          continue;
        }
        await this.withRegistryMutationLock(entry.namespace, entry.slug, async () => {
          try {
            if (await this.reconcilePublication(receipt.operationId)) {
              processed += 1;
            }
          } catch (error) {
            if (!(error instanceof SkillHubServiceError && error.statusCode === 404)) {
              this.maintenanceError =
                "A publication needs reconciliation; retry it or ask an administrator to cancel it.";
            }
          }
        });
      }
      for (const due of await catalog.claimPurgeDue(this.now(), 20)) {
        try {
          await this.withRegistryMutationLock(due.namespace, due.slug, async () => {
            const entry = await catalog.beginPurge({
              skillId: due.id,
              expectedRevision: due.revision,
              now: this.now(),
            });
            const governance = this.options.governance;
            if (!governance) {
              throw new SkillHubServiceError("Managed artifact cleanup is unavailable", 503);
            }
            let registryId = entry.registryId;
            if (registryId === null) {
              // A cancelled first publication may have failed before native
              // reservation. Establish the same durable identity before the
              // existing verified whole-skill cleanup, even for an empty skill.
              const native = await this.ensureArtifactIdentity(entry, async () => {
                const current = await catalog.get(entry.id);
                if (
                  !current ||
                  !current.purgePending ||
                  current.purgedAt !== null ||
                  current.registryId !== null ||
                  current.namespace !== entry.namespace ||
                  current.slug !== entry.slug
                ) {
                  throw new SkillHubServiceError("Skill Hub cleanup state changed", 409);
                }
              });
              registryId = native.id;
            }
            let deletion = await governance.getArtifactDeletion(registryId);
            if (!deletion || deletion.state === "pending") {
              deletion = await governance.deleteArtifact({
                skillId: registryId,
                namespace: entry.namespace,
                slug: entry.slug,
              });
            }
            if (deletion.state !== "completed" || !deletion.completedAt) {
              this.maintenanceError =
                "Skill Hub cleanup is pending. Existing trash stays unavailable; an administrator can retry cleanup.";
              return;
            }
            await catalog.finishPurge({
              skillId: entry.id,
              now: Math.max(this.now(), Date.parse(deletion.completedAt)),
            });
            processed += 1;
          });
        } catch {
          this.maintenanceError =
            "Skill Hub cleanup is pending. Existing trash stays unavailable; an administrator can retry cleanup.";
        }
      }
      await catalog.pruneHistory(this.now());
      for (const entry of await catalog.list()) {
        if (entry.deletedAt !== null || entry.purgedAt !== null || entry.currentVersion === null) {
          continue;
        }
        try {
          await this.versionScans(entry);
        } catch {
          this.maintenanceError ??=
            "Some skill versions could not be checked. Refresh or ask an administrator to reconcile the registry.";
        }
      }
    } catch {
      this.maintenanceError =
        "Skill Hub cleanup is pending. Existing trash stays unavailable; an administrator can retry cleanup.";
    } finally {
      this.governanceProcessing = false;
      this.triggerGovernanceProcessing(30_000);
    }
    return { processed };
  }
}
