import path from "node:path";
import type { PlatformUser } from "./contracts.js";
import { assertSkillHubWorkspace } from "./skill-hub-command-workspace.js";
import { SkillHubRegistryMutationLock } from "./skill-hub-registry-mutation-lock.js";
import { SkillHubServiceBase } from "./skill-hub-service-base.js";
import {
  isInside,
  projectSkillHubAccessGrant,
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  type AuthenticatedWorkspace,
  type SkillInstallTarget,
  type SkillHubAudience,
} from "./skill-hub-service-support.js";

export abstract class SkillHubCatalogService extends SkillHubServiceBase {
  private readonly registryMutationLock = new SkillHubRegistryMutationLock();
  protected async withRegistryMutationLock<T>(
    namespace: string,
    slug: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return await this.registryMutationLock.run(namespace, slug, task);
  }

  protected async withRegistryMutationLocks<T>(
    coordinates: Array<{ namespace: string; slug: string }>,
    task: () => Promise<T>,
  ): Promise<T> {
    return await this.registryMutationLock.runMany(coordinates, task);
  }

  async authenticate(token: string): Promise<AuthenticatedWorkspace | null> {
    const auth = await this.options.authService.authenticateToken(token);
    if (auth.status !== "active") {
      return null;
    }
    this.triggerGovernanceProcessing();
    const binding = await this.options.store.getPersonalAgentBinding(auth.user.id);
    if (!binding || binding.state !== "active") {
      throw new SkillHubServiceError("personal Agent workspace is unavailable", 409);
    }
    const workspaceDir = path.resolve(this.workspaceRoot, binding.agentId);
    if (!isInside(this.workspaceRoot, workspaceDir) || workspaceDir === this.workspaceRoot) {
      throw new SkillHubServiceError("personal Agent workspace is invalid", 500);
    }
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
      throw new SkillHubServiceError("personal Agent workspace is invalid", 500);
    }
    return { user: route.user, agentId: route.binding.agentId, workspaceDir };
  }

  async config(actor: AuthenticatedWorkspace) {
    await this.reconcileOwners();
    const profile = await this.options.store.getPersonalExecutionProfile(actor.agentId);
    const allocation = await this.options.store.getVmAllocationForAgent(actor.agentId);
    const vmAvailable = allocation?.status === "ready" && Boolean(allocation.remoteWorkspaceDir);
    const unreadCount = await this.options.store.countUnreadSkillHubNotifications(actor.user.id);
    const publishChecks = await Promise.all(
      [...this.namespaces].map(async (namespace) => ({
        namespace,
        allowed: await this.canPublish(actor.user, namespace),
      })),
    );
    return {
      namespaces: publishChecks
        .filter((entry) => entry.allowed)
        .map((entry) => entry.namespace)
        .toSorted(),
      maxPackageBytes: this.options.maxPackageBytes,
      maxUploadBytes: SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
      capabilities: {
        scanner: true,
        forcePublish: Boolean(this.options.governance),
        ownerTransfer: true,
        accessControl: true,
        notifications: true,
        zipUpload: true,
        metadataEdit: typeof this.options.governance?.editSkill === "function",
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
      admin: actor.user.globalRole === "admin",
      notifications: { unreadCount },
      ...(actor.user.globalRole === "admin"
        ? { unassignedOwnerCount: await this.options.store.countUnassignedSkillHubSkills() }
        : {}),
    };
  }

  async search(
    user: PlatformUser,
    query: string,
    limit = 20,
    audience: SkillHubAudience = "employee",
    options: { requireComplete?: boolean } = {},
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new SkillHubServiceError("limit must be between 1 and 50", 400);
    }
    const result = await this.adapterCall(() => this.options.adapter.search(query.trim(), limit));
    if (options.requireComplete && result.total > result.items.length) {
      throw new SkillHubServiceError("search is incomplete; specify namespace/slug", 409, {
        code: "incomplete-search",
      });
    }
    const visibility = await Promise.all(
      result.items.map(
        async (item) =>
          this.namespaces.has(item.namespace.toLowerCase()) &&
          (await this.canAccessSkill(
            user,
            item.namespace.toLowerCase(),
            item.slug,
            item.visibility,
            item.latestVersion,
            audience,
          )),
      ),
    );
    const items = result.items.filter((_, index) => visibility[index]);
    return { items, total: items.length };
  }

  async workspaceSkills(actor: AuthenticatedWorkspace, source: SkillInstallTarget) {
    await assertSkillHubWorkspace(this.options.store, actor);
    await this.authorizeInstallTarget(actor.agentId, source);
    const status = await this.gatewayCall<{
      skills?: Array<{
        skillKey?: string;
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
    const ownerSource =
      source === "assigned_vm" ? "platformclaw-vm-workspace" : "openclaw-workspace";
    return {
      source,
      items: (status.skills ?? [])
        .filter((item) => item.source === ownerSource && typeof item.skillKey === "string")
        .map((item) =>
          Object.assign(
            { skillKey: item.skillKey! },
            typeof item.name === "string" ? { name: item.name } : {},
            typeof item.description === "string" ? { description: item.description } : {},
            typeof item.version === "string" ? { version: item.version } : {},
            typeof item.revision === "string" ? { revision: item.revision } : {},
            typeof item.eligible === "boolean" ? { eligible: item.eligible } : {},
            typeof item.disabled === "boolean" ? { disabled: item.disabled } : {},
            typeof item.modelVisible === "boolean" ? { modelVisible: item.modelVisible } : {},
            item.missing ? { missing: item.missing } : {},
          ),
        ),
    };
  }

  async uninstall(actor: AuthenticatedWorkspace, slugRaw: string) {
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const execution = await this.resolveExecutionTarget(actor.agentId);
    const installed = await this.workspaceSkills(actor, execution.activeTarget);
    const item = installed.items.find((candidate) => candidate.skillKey === slug);
    if (!item) {
      throw new SkillHubServiceError(`skill is not installed on the active target: ${slug}`, 404);
    }
    if (!/^sha256:[a-f0-9]{16}$/u.test(item.revision ?? "")) {
      throw new SkillHubServiceError("installed skill revision is unavailable", 409);
    }
    await assertSkillHubWorkspace(this.options.store, actor);
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
    await this.audit(actor.user.id, "skill-hub.uninstall", slug, {
      agentId: actor.agentId,
      destination: execution.activeTarget,
      version: item.version ?? null,
    });
    return { ok: true, slug, version: item.version, target: execution.activeTarget };
  }

  async detail(
    user: PlatformUser,
    namespaceRaw: string,
    slugRaw: string,
    audience: SkillHubAudience = "employee",
  ) {
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const skill = await this.adapterCall(() => this.options.adapter.getSkill(namespace, slug));
    this.validateSkillIdentity(skill.namespace, skill.slug, namespace, slug);
    await this.authorizeSkillAccess(user, namespace, slug, skill.visibility, undefined, audience);
    const versions = await this.adapterCall(() =>
      this.options.adapter.listVersions(namespace, slug),
    );
    const currentVersion = versions[0];
    const audits = currentVersion
      ? await this.adapterCall(() =>
          this.options.adapter.listSecurityAudits(skill.id, currentVersion.id),
        )
      : [];
    const owner = await this.options.store.getSkillHubOwnership(namespace, slug);
    // A room cannot inherit its sender's personal preview or management authority.
    const canManage =
      audience === "employee" &&
      (user.globalRole === "admin" ||
        (owner?.ownerUserId !== null && owner?.ownerUserId === user.id));
    const ownerUser =
      canManage && owner?.ownerUserId
        ? await this.options.store.getUserById(owner.ownerUserId)
        : undefined;
    const metadata =
      canManage && this.options.governance?.getEditableSkill
        ? await this.options.governance.getEditableSkill(namespace, slug)
        : undefined;
    if (metadata && metadata.id !== skill.id) {
      throw new SkillHubServiceError("Skill Hub returned mismatched editable skill metadata", 502);
    }
    return {
      skill: {
        ...skill,
        ...(metadata ? { revision: metadata.revision, visibility: metadata.visibility } : {}),
      },
      // The bootstrap registry identity may preview pending versions. Employees
      // sharing an aggregate must only download its published versions.
      versions:
        !canManage && skill.visibility !== "PRIVATE"
          ? versions.map((version) => ({
              ...version,
              downloadAvailable: version.downloadAvailable && version.status === "PUBLISHED",
            }))
          : versions,
      owner: owner
        ? {
            assigned: owner.ownerUserId !== null,
            isMine: owner.ownerUserId === user.id,
            unassigned: owner.ownerUserId === null,
            ...(canManage ? { revision: owner.updatedAt } : {}),
            ...(ownerUser
              ? {
                  user: {
                    id: ownerUser.id,
                    accountId: ownerUser.accountId,
                    ...(ownerUser.displayName ? { displayName: ownerUser.displayName } : {}),
                  },
                }
              : {}),
          }
        : null,
      scanner: this.projectScanner(currentVersion, audits),
      canManage,
      ...(canManage
        ? {
            access: (await this.options.store.listSkillHubAccess(namespace, slug, this.now())).map(
              projectSkillHubAccessGrant,
            ),
          }
        : {}),
    };
  }
}
