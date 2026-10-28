import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PlatformUser } from "./contracts.js";
import type { SkillHubCatalogEntry } from "./skill-hub-catalog-state.js";
import { assertSkillHubWorkspace } from "./skill-hub-command-workspace.js";
import { SkillHubRegistryMutationLock } from "./skill-hub-registry-mutation-lock.js";
import { projectSkillHubScan } from "./skill-hub-scan-policy.js";
import { SkillHubServiceBase } from "./skill-hub-service-base.js";
import {
  isInside,
  isValidSkillHubVersion,
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  type AuthenticatedWorkspace,
  type SkillInstallTarget,
  type SkillHubAudience,
  type SkillHubTargetSnapshot,
} from "./skill-hub-service-support.js";

export abstract class SkillHubCatalogService extends SkillHubServiceBase {
  private initialization?: Promise<void>;
  private readonly registryMutationLock = new SkillHubRegistryMutationLock();

  protected async initializeCatalog(): Promise<void> {
    this.initialization ??= this.importCatalog().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
  }

  private async importCatalog(): Promise<void> {
    const catalog = this.options.store.skillHubCatalog;
    if (await catalog.migrationComplete()) {
      return;
    }
    const governance = this.options.governance;
    if (!governance?.listOwnedSkills) {
      throw new SkillHubServiceError(
        "Skill Hub catalog migration needs the managed registry connection",
        503,
      );
    }
    const seen = new Set<string>();
    const importEntry = async (item: {
      id: number;
      namespace: string;
      slug: string;
      displayName: string;
      summary: string;
      currentVersion: string | null;
    }) => {
      const key = `${item.namespace}/${item.slug}`;
      seen.add(key);
      await catalog.importLegacy({
        ...item,
        id: randomUUID(),
        registryId: item.id,
        now: this.now(),
      });
    };
    const registryIds = new Set<number>();
    for (let page = 0; ; page += 1) {
      const result = await governance.listOwnedSkills(page, 100);
      for (const item of result.items) {
        if (registryIds.has(item.id)) {
          throw new SkillHubServiceError(
            "Registry repeated a catalog page; migration is incomplete",
            502,
          );
        }
        registryIds.add(item.id);
        await importEntry(item);
      }
      if ((page + 1) * 100 >= result.total) {
        break;
      }
      if (result.items.length === 0) {
        throw new SkillHubServiceError("Registry catalog migration is incomplete", 502);
      }
    }
    // Older publisher credentials may own recorded coordinates outside the current
    // account's inventory. Read them at cutover, never as a steady-state fallback.
    for (const coordinate of await catalog.listLegacyCoordinates()) {
      if (seen.has(`${coordinate.namespace}/${coordinate.slug}`)) {
        continue;
      }
      const native = await this.artifactSkill({ ...coordinate, registryId: null });
      const versions = await this.artifactVersions(native);
      await importEntry({ ...native, currentVersion: versions[0]?.version ?? null });
    }
    await catalog.finishMigration(this.now());
  }

  protected async withRegistryMutationLock<T>(
    namespace: string,
    slug: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return await this.registryMutationLock.run(namespace, slug, task);
  }

  async authenticate(token: string): Promise<AuthenticatedWorkspace | null> {
    const auth = await this.options.authService.authenticateToken(token);
    if (auth.status !== "active") {
      return null;
    }
    const binding = await this.options.store.getPersonalAgentBinding(auth.user.id);
    if (!binding || binding.state !== "active") {
      throw new SkillHubServiceError("Personal Agent workspace is unavailable", 409);
    }
    const workspaceDir = path.resolve(this.workspaceRoot, binding.agentId);
    if (!isInside(this.workspaceRoot, workspaceDir) || workspaceDir === this.workspaceRoot) {
      throw new SkillHubServiceError("Personal Agent workspace is invalid", 500);
    }
    await this.initializeCatalog();
    this.triggerGovernanceProcessing();
    return { user: auth.user, agentId: binding.agentId, workspaceDir };
  }

  async authenticateAccount(accountId: string): Promise<AuthenticatedWorkspace | null> {
    const route = await this.options.store.resolveAuthenticatedKnoxDmRoute({
      accountId: accountId.trim(),
    });
    if (route.status !== "resolved") {
      return null;
    }
    const workspaceDir = path.resolve(this.workspaceRoot, route.binding.agentId);
    if (!isInside(this.workspaceRoot, workspaceDir) || workspaceDir === this.workspaceRoot) {
      throw new SkillHubServiceError("Personal Agent workspace is invalid", 500);
    }
    await this.initializeCatalog();
    this.triggerGovernanceProcessing();
    return { user: route.user, agentId: route.binding.agentId, workspaceDir };
  }

  protected async projectEntry(entry: SkillHubCatalogEntry, user: PlatformUser) {
    const owner = entry.ownerUserId
      ? await this.options.store.getUserById(entry.ownerUserId)
      : null;
    return {
      id: entry.id,
      slug: entry.slug,
      displayName: entry.displayName,
      summary: entry.summary,
      tags: entry.tags,
      sharing: { mode: entry.sharing.mode },
      revision: entry.revision,
      latestVersion: entry.currentVersion,
      iconUrl: entry.hasIcon ? `/platformclaw/api/skill-hub/skills/by-id/${entry.id}/icon` : null,
      owner: {
        assigned: Boolean(entry.ownerUserId),
        isMine: entry.ownerUserId === user.id,
        unassigned: !owner || owner.status !== "active",
        revision: entry.revision,
        ...(owner
          ? {
              user: {
                id: owner.id,
                accountId: owner.accountId,
                ...(owner.displayName ? { displayName: owner.displayName } : {}),
              },
            }
          : {}),
      },
    };
  }

  async config(actor: AuthenticatedWorkspace) {
    const profile = await this.options.store.getPersonalExecutionProfile(actor.agentId);
    const allocation = await this.options.store.getVmAllocationForAgent(actor.agentId);
    const vmAvailable = allocation?.status === "ready" && Boolean(allocation.remoteWorkspaceDir);
    const entries = await this.options.store.skillHubCatalog.list();
    const pending = await this.options.store.skillHubCatalog.listRecoverablePublications(
      actor.user.id,
    );
    const current = await this.activeUser(actor.user.id);
    return {
      defaultSharing: "PUBLIC" as const,
      scopes: (await this.options.organization.listScopes())
        .filter((scope) => scope.status === "active")
        .map((scope) =>
          Object.assign(
            { id: scope.id, kind: scope.kind, name: scope.name },
            scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {},
          ),
        ),
      ownedSkills: entries
        .filter(
          (entry) =>
            entry.ownerUserId === actor.user.id &&
            entry.deletedAt === null &&
            entry.purgedAt === null &&
            !entry.purgePending &&
            entry.currentVersion !== null,
        )
        .map((entry) => ({
          id: entry.id,
          slug: entry.slug,
          displayName: entry.displayName,
          revision: entry.revision,
        })),
      maxPackageBytes: this.options.maxPackageBytes,
      maxUploadBytes: SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
      limits: { iconBytes: 2 * 1024 * 1024, tags: 5, tagChars: 32 },
      capabilities: {
        scanner: true,
        forcePublish: false,
        ownerTransfer: true,
        accessControl: true,
        notifications: true,
        zipUpload: true,
        metadataEdit: true,
        trash: true,
        icons: true,
        history: true,
      },
      installTargets: [
        { target: "platform_server" as const, available: true, status: "ready" },
        {
          target: "assigned_vm" as const,
          available: vmAvailable,
          status: allocation?.status ?? "unassigned",
          ...(vmAvailable ? {} : { disabledReason: "My VM workspace is not ready." }),
        },
      ],
      activeTarget: profile?.activeTarget ?? "platform_server",
      admin: current.globalRole === "admin",
      notifications: {
        unreadCount: await this.options.store.countUnreadSkillHubNotifications(actor.user.id),
      },
      maintenanceError: this.maintenanceError,
      pendingPublications: pending
        .filter((receipt) => receipt.ownerUserId === current.id || current.globalRole === "admin")
        .map(({ ownerUserId, ...publication }) =>
          Object.assign(publication, { isMine: ownerUserId === current.id }),
        ),
    };
  }

  async search(
    user: PlatformUser,
    query: string,
    limit = 20,
    audience: SkillHubAudience = "employee",
    _options: { requireComplete?: boolean } = {},
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new SkillHubServiceError("Invalid result limit", 400);
    }
    const needle = query.trim().toLocaleLowerCase();
    const items = [];
    for (const entry of await this.options.store.skillHubCatalog.list()) {
      if (
        needle &&
        ![entry.displayName, entry.slug, entry.summary, ...entry.tags].some((value) =>
          value.toLocaleLowerCase().includes(needle),
        )
      ) {
        continue;
      }
      if (
        !(await this.options.store.skillHubCatalog.canAccess({
          skillId: entry.id,
          userId: user.id,
          audience,
        }))
      ) {
        continue;
      }
      const projected = await this.projectEntry(entry, user);
      const latest = await this.requireEntry(user, entry.id, audience).catch((error: unknown) => {
        if (error instanceof SkillHubServiceError && error.statusCode === 404) {
          return null;
        }
        throw error;
      });
      if (latest?.revision === entry.revision) {
        items.push(projected);
      }
    }
    return { items: items.slice(0, limit), total: items.length };
  }

  protected async versionScans(entry: SkillHubCatalogEntry) {
    const native = await this.artifactSkill(entry);
    if (
      entry.registryId === null ||
      native.id !== entry.registryId ||
      native.namespace !== entry.namespace ||
      native.slug !== entry.slug
    ) {
      throw new SkillHubServiceError(
        "Registry skill identity changed; ask an administrator to reconcile it",
        409,
      );
    }
    const versions = await this.artifactVersions(native, entry.currentVersion);
    const projected = [];
    const blocked = new Set(await this.options.store.skillHubCatalog.getBlockedVersions(entry.id));
    for (let offset = 0; offset < versions.length; offset += 5) {
      projected.push(
        ...(await Promise.all(
          versions.slice(offset, offset + 5).map(async (version) => {
            if (!this.options.governance) {
              throw new SkillHubServiceError("Managed artifact access is unavailable", 503);
            }
            const evidence = await this.options.governance.getArtifactSecurity({
              skillId: native.id,
              versionId: version.id,
              namespace: entry.namespace,
              slug: entry.slug,
            });
            let scan = evidence.blocked
              ? ({ status: "blocked", badge: "Malware blocked", blocked: true } as const)
              : projectSkillHubScan(evidence.audits);
            if (scan.blocked) {
              await this.options.store.skillHubCatalog.blockVersion({
                skillId: entry.id,
                version: version.version,
                reason: "Confirmed malware hash",
                now: this.now(),
              });
            } else if (blocked.has(version.version)) {
              scan = { status: "blocked", badge: "Malware blocked", blocked: true };
            }
            return Object.assign({}, version, {
              scanner: scan,
              downloadAvailable: evidence.artifactAvailable && !scan.blocked,
            });
          }),
        )),
      );
    }
    return projected;
  }

  async detailById(user: PlatformUser, id: string, audience: SkillHubAudience = "employee") {
    const entry = await this.requireEntry(user, id, audience);
    const projected = await this.projectEntry(entry, user);
    const versions = await this.versionScans(entry);
    const current = await this.activeUser(user.id);
    const canManage =
      audience === "employee" &&
      (current.globalRole === "admin" || entry.ownerUserId === current.id);
    const users = canManage
      ? await Promise.all(
          entry.sharing.userIds.map(async (userId) => {
            const recipient = await this.options.store.getUserById(userId);
            return recipient
              ? {
                  id: recipient.id,
                  accountId: recipient.accountId,
                  ...(recipient.displayName ? { displayName: recipient.displayName } : {}),
                }
              : null;
          }),
        )
      : [];
    const scopes = canManage
      ? (await this.options.organization.listScopes())
          .filter((scope) => entry.sharing.scopeIds.includes(scope.id))
          .map((scope) =>
            Object.assign(
              { id: scope.id, kind: scope.kind, name: scope.name },
              scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {},
            ),
          )
      : [];
    const latest = await this.requireEntry(current, id, audience);
    const finalUser = await this.activeUser(user.id);
    if (
      latest.revision !== entry.revision ||
      (canManage && finalUser.globalRole !== "admin" && latest.ownerUserId !== finalUser.id)
    ) {
      throw new SkillHubServiceError("Skill sharing changed; refresh and retry", 409);
    }
    return {
      skill: projected,
      owner: projected.owner,
      versions,
      scanner: versions[0]?.scanner ?? projectSkillHubScan([]),
      canManage,
      ...(canManage
        ? {
            sharing: {
              ...entry.sharing,
              users: users.filter((recipient) => recipient !== null),
              scopes,
            },
          }
        : {}),
    };
  }

  async detail(
    user: PlatformUser,
    namespace: string,
    slug: string,
    audience: SkillHubAudience = "employee",
  ) {
    const entry = await this.options.store.skillHubCatalog.getByCoordinate(namespace, slug);
    if (!entry) {
      throw new SkillHubServiceError("Skill Hub skill not found", 404);
    }
    return await this.detailById(user, entry.id, audience);
  }

  async workspaceSkills(
    actor: AuthenticatedWorkspace,
    source: SkillInstallTarget,
    expectedTarget?: SkillHubTargetSnapshot,
  ) {
    await assertSkillHubWorkspace(this.options.store, actor);
    const execution = await this.authorizeInstallTarget(actor.agentId, source);
    if (expectedTarget) {
      await this.revalidateInstallTarget(actor.agentId, source, expectedTarget);
    }
    const status = await this.gatewayCall<{
      skills?: Array<{
        baseDir?: string;
        name?: string;
        description?: string;
        source?: string;
        version?: string;
        revision?: string;
        eligible?: boolean;
        disabled?: boolean;
        modelVisible?: boolean;
        missing?: {
          bins: string[];
          anyBins: string[];
          env: string[];
          config: string[];
          os: string[];
        };
      }>;
    }>("skills.status", {
      agentId: actor.agentId,
      refresh: true,
      ...(actor.roomBinding ? {} : { backendTarget: source }),
    });
    await this.revalidateInstallTarget(actor.agentId, source, execution);
    const origins = await this.options.store.skillHubCatalog.listInstallations(
      actor.agentId,
      execution.targetId,
    );
    return {
      source,
      targetId: execution.targetId,
      targetRevision: execution.targetRevision,
      ...(execution.targetLabel ? { targetLabel: execution.targetLabel } : {}),
      items: (status.skills ?? []).flatMap((item) => {
        const slug = this.workspaceSkillSlug(item, source);
        // Keep durable provenance for room policy, but only present a matching
        // installed manifest as the completed Hub version. Local edits need the
        // existing explicit replacement flow rather than an incorrect no-op.
        const origin = origins.find(
          (candidate) =>
            candidate.slug === slug &&
            candidate.destination === source &&
            candidate.state === "completed" &&
            candidate.version === item.version &&
            candidate.installedRevision !== null &&
            candidate.installedRevision === item.revision,
        );
        return slug
          ? [
              Object.assign(
                { skillKey: slug },
                origin
                  ? {
                      hubSkillId: origin.skillId,
                      hubVersion: origin.version,
                    }
                  : {},
                typeof item.name === "string" ? { name: item.name } : {},
                typeof item.description === "string" ? { description: item.description } : {},
                typeof item.version === "string" && isValidSkillHubVersion(item.version)
                  ? { version: item.version }
                  : {},
                typeof item.revision === "string" ? { revision: item.revision } : {},
                typeof item.eligible === "boolean" ? { eligible: item.eligible } : {},
                typeof item.disabled === "boolean" ? { disabled: item.disabled } : {},
                typeof item.modelVisible === "boolean" ? { modelVisible: item.modelVisible } : {},
                item.missing ? { missing: item.missing } : {},
              ),
            ]
          : [];
      }),
    };
  }

  async uninstall(actor: AuthenticatedWorkspace, slugRaw: string) {
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const execution = await this.resolveExecutionTarget(actor.agentId);
    const target = await this.authorizeInstallTarget(actor.agentId, execution.activeTarget);
    if (target.targetRevision !== execution.targetRevision) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
      );
    }
    return await this.withWorkspaceMutationLock(actor.agentId, execution.activeTarget, async () =>
      this.uninstallLocked(actor, slug, { ...target, activeTarget: execution.activeTarget }),
    );
  }

  private async uninstallLocked(
    actor: AuthenticatedWorkspace,
    slug: string,
    execution: SkillHubTargetSnapshot & { activeTarget: SkillInstallTarget },
  ) {
    const origin = (
      await this.options.store.skillHubCatalog.listInstallations(actor.agentId, execution.targetId)
    ).find((item) => item.destination === execution.activeTarget && item.slug === slug);
    const installed = await this.workspaceSkills(actor, execution.activeTarget, execution);
    const item = installed.items.find((candidate) => candidate.skillKey === slug);
    if (!item) {
      throw new SkillHubServiceError(`skill is not installed on the active target: ${slug}`, 404);
    }
    if (!/^sha256:[a-f0-9]{16}$/u.test(item.revision ?? "")) {
      throw new SkillHubServiceError("installed skill revision is unavailable", 409);
    }
    await assertSkillHubWorkspace(this.options.store, actor);
    await this.revalidateInstallTarget(actor.agentId, execution.activeTarget, execution);
    const result = await this.gatewayCall<Record<string, unknown>>("skills.uninstall", {
      agentId: actor.agentId,
      slug,
      destination: "sandbox-backend",
      ...(actor.roomBinding ? {} : { backendTarget: execution.activeTarget }),
      expectedTargetRevision: execution.targetRevision,
      expectedSkillRevision: item.revision,
    });
    if (result.ok !== true || result.slug !== slug) {
      throw new SkillHubServiceError("Gateway returned an invalid uninstall result", 503);
    }
    if (origin) {
      await this.options.store.skillHubCatalog.removeInstallation({
        agentId: actor.agentId,
        destination: execution.activeTarget,
        targetId: execution.targetId,
        slug,
        operationId: origin.operationId,
      });
    }
    await this.audit(actor.user.id, "skill-hub.uninstall", slug, {
      agentId: actor.agentId,
      destination: execution.activeTarget,
      version: item.version ?? null,
    });
    return { ok: true, slug, version: item.version, target: execution.activeTarget };
  }
}
