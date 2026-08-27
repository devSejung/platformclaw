import { createHash } from "node:crypto";
import path from "node:path";
import type { PlatformUser } from "./contracts.js";
import { SkillHubServiceBase } from "./skill-hub-service-base.js";
import {
  compareSemVer,
  isInside,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  parseSkillMarkdown,
  projectSkillHubAccessGrant,
  safeName,
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SKILL_HUB_UPLOAD_ENTRY_BYTES,
  SKILL_HUB_UPLOAD_EXPANDED_BYTES,
  SKILL_HUB_UPLOAD_ENTRIES,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  UPLOAD_CHUNK_BYTES,
  validVersion,
  validVisibility,
  validateDownloadedArchive,
  type AuthenticatedWorkspace,
  type SkillInstallTarget,
} from "./skill-hub-service-support.js";
import { downloadVmWorkspaceArchive } from "./skill-hub-workspace-export.js";
import { validateZipArchiveFile, ZipArchiveValidationError } from "./zip-archive-validator.js";

type SkillHubInstallResult = {
  ok: true;
  noOp: false;
  slug: string;
  version: string;
  target: SkillInstallTarget;
};

export abstract class SkillHubPublicationService extends SkillHubServiceBase {
  private readonly installLocks = new Map<string, Promise<void>>();
  private readonly installsInFlight = new Map<string, Promise<SkillHubInstallResult>>();

  private async withInstallLock<T>(
    agentId: string,
    destination: SkillInstallTarget,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${agentId}\0${destination}`;
    const previous = this.installLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.installLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.installLocks.get(key) === tail) {
        this.installLocks.delete(key);
      }
    }
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

  async search(user: PlatformUser, query: string, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new SkillHubServiceError("limit must be between 1 and 50", 400);
    }
    const result = await this.adapterCall(() => this.options.adapter.search(query.trim(), limit));
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
          )),
      ),
    );
    const items = result.items.filter((_, index) => visibility[index]);
    return { items, total: items.length };
  }

  async commandCatalog(user: PlatformUser, page: number, pageSize = 20) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 25) {
      throw new SkillHubServiceError("page must be between 1 and 25", 400);
    }
    const fetchLimit = page * pageSize;
    const result = await this.adapterCall(() => this.options.adapter.search("", fetchLimit));
    const visible = (
      await Promise.all(
        result.items.map(async (item) => ({
          item,
          allowed:
            this.namespaces.has(item.namespace.toLowerCase()) &&
            (await this.canAccessSkill(
              user,
              item.namespace.toLowerCase(),
              item.slug,
              item.visibility,
              item.latestVersion,
            )),
        })),
      )
    )
      .filter((entry) => entry.allowed)
      .map((entry) => entry.item);
    return {
      items: visible.slice((page - 1) * pageSize, page * pageSize),
      page,
      pageSize,
      hasNext: result.total > fetchLimit || visible.length > page * pageSize,
      registryTotal: result.total,
    };
  }

  async resolveCommandSkill(user: PlatformUser, raw: string) {
    const value = raw.trim().toLowerCase();
    if (!value) {
      throw new SkillHubServiceError("skill slug is required", 400);
    }
    const separator = value.indexOf("/");
    if (separator >= 0) {
      const namespace = this.authorizeNamespace(value.slice(0, separator));
      const slug = safeName(value.slice(separator + 1), "skill slug", SKILL_KEY_PATTERN);
      const detail = await this.detail(user, namespace, slug);
      const version = detail.versions.find((candidate) => candidate.downloadAvailable)?.version;
      if (!version) {
        throw new SkillHubServiceError("skill has no downloadable version", 409);
      }
      return { namespace, slug, version };
    }
    const slug = safeName(value, "skill slug", SKILL_KEY_PATTERN);
    const result = await this.search(user, slug, 50);
    const matches = result.items.filter((item) => item.slug.toLowerCase() === slug);
    if (matches.length === 0) {
      throw new SkillHubServiceError(`skill not found: ${slug}`, 404);
    }
    if (matches.length > 1) {
      throw new SkillHubServiceError("skill slug is ambiguous", 409, {
        candidates: matches.map((item) => `${item.namespace}/${item.slug}`),
      });
    }
    const match = matches[0]!;
    return { namespace: match.namespace, slug: match.slug, version: match.latestVersion };
  }

  async workspaceSkills(actor: AuthenticatedWorkspace, source: SkillInstallTarget) {
    await this.authorizeInstallTarget(actor.agentId, source);
    const status = await this.gatewayCall<{
      skills?: Array<{
        skillKey?: string;
        name?: string;
        description?: string;
        source?: string;
        version?: string;
        revision?: string;
      }>;
    }>("skills.status", {
      agentId: actor.agentId,
      refresh: true,
      backendTarget: source,
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
          ),
        ),
    };
  }

  async commandInstalled(actor: AuthenticatedWorkspace) {
    const execution = await this.resolveExecutionTarget(actor.agentId);
    const workspace = await this.workspaceSkills(actor, execution.activeTarget);
    return { target: workspace.source, items: workspace.items };
  }

  async uninstall(actor: AuthenticatedWorkspace, slugRaw: string) {
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const execution = await this.resolveExecutionTarget(actor.agentId);
    const installed = await this.commandInstalled(actor);
    const item = installed.items.find((candidate) => candidate.skillKey === slug);
    if (!item) {
      throw new SkillHubServiceError(`skill is not installed on the active target: ${slug}`, 404);
    }
    if (!/^sha256:[a-f0-9]{16}$/u.test(item.revision ?? "")) {
      throw new SkillHubServiceError("installed skill revision is unavailable", 409);
    }
    const result = await this.gatewayCall<Record<string, unknown>>("skills.uninstall", {
      agentId: actor.agentId,
      slug,
      destination: "sandbox-backend",
      backendTarget: execution.activeTarget,
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

  async detail(user: PlatformUser, namespaceRaw: string, slugRaw: string) {
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const skill = await this.adapterCall(() => this.options.adapter.getSkill(namespace, slug));
    this.validateSkillIdentity(skill.namespace, skill.slug, namespace, slug);
    await this.authorizeSkillAccess(user, namespace, slug, skill.visibility);
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
    const canManage =
      user.globalRole === "admin" ||
      (owner?.ownerUserId !== null && owner?.ownerUserId === user.id);
    const ownerUser =
      canManage && owner?.ownerUserId
        ? await this.options.store.getUserById(owner.ownerUserId)
        : undefined;
    return {
      skill,
      versions,
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
      scanner: this.projectScanner(currentVersion?.version, audits),
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

  async publish(
    actor: AuthenticatedWorkspace,
    params: {
      skill: string;
      source?: SkillInstallTarget;
      namespace: string;
      version: string;
      visibility: string;
    },
  ) {
    const skill = safeName(params.skill, "skill", SKILL_KEY_PATTERN);
    const namespace = await this.authorizePublishNamespace(actor.user, params.namespace);
    const version = validVersion(params.version);
    const visibility = validVisibility(params.visibility);
    await this.authorizeVisibilityCeiling(namespace, visibility);
    await this.authorizeExistingSkillMutation(actor.user, namespace, skill);
    const source = params.source ?? (await this.resolveExecutionTarget(actor.agentId)).activeTarget;
    const execution = await this.authorizeInstallTarget(actor.agentId, source);
    if (source === "assigned_vm") {
      const archive = await downloadVmWorkspaceArchive(this.gatewayCall.bind(this), {
        agentId: actor.agentId,
        slug: skill,
        version,
        expectedTargetRevision: execution.targetRevision,
        expectedAllocationId: execution.allocationId!,
      });
      try {
        return await this.publishArchive(
          actor,
          { slug: skill, namespace, version, visibility },
          archive,
          { source },
        );
      } finally {
        await archive.cleanup();
      }
    }
    const archive = await this.packageWorkspaceSkill(actor.workspaceDir, skill, version);
    await this.authorizePublishNamespace(actor.user, namespace);
    const finalCapabilities = await this.resolveNamespaceCapabilities(actor.user, namespace);
    const currentOwnership = await this.authorizeExistingSkillMutation(
      actor.user,
      namespace,
      skill,
    );
    const result = await this.adapterCall(() =>
      this.options.adapter.publish({
        namespace,
        archive,
        filename: `${skill}-${version}.zip`,
        visibility,
      }),
    );
    if (
      result.namespace !== namespace ||
      result.slug !== skill ||
      result.version !== version ||
      result.visibility !== visibility
    ) {
      throw new SkillHubServiceError("Skill Hub returned a mismatched publish result", 502);
    }
    const recorded = await this.options.store.recordSkillHubPublication({
      namespace,
      slug: skill,
      ownerUserId: actor.user.id,
      expectedOwnerUserId: currentOwnership?.ownerUserId ?? null,
      expectedOwnerUpdatedAt: currentOwnership?.updatedAt ?? null,
      expectedBindingUpdatedAt: finalCapabilities.binding!.updatedAt,
      visibility,
      version,
      changedAt: this.now(),
    });
    await this.reconcileOwners();
    await this.enqueueGovernance(recorded.ownerUserId, namespace, skill, version, visibility);
    await this.audit(actor.user.id, "skill-hub.publish", `${namespace}/${skill}@${version}`, {
      visibility,
      archiveBytes: archive.byteLength,
      source,
    });
    return recorded.reconciliationRequired
      ? { ...result, ownershipReviewRequired: true as const }
      : result;
  }

  async publishArchive(
    actor: AuthenticatedWorkspace,
    params: { slug: string; namespace: string; version: string; visibility: string },
    archive: { path: string; size: number },
    options: { source?: SkillInstallTarget } = {},
  ) {
    const slug = safeName(params.slug, "skill slug", SKILL_KEY_PATTERN);
    const namespace = await this.authorizePublishNamespace(actor.user, params.namespace);
    const version = validVersion(params.version);
    const visibility = validVisibility(params.visibility);
    await this.authorizeVisibilityCeiling(namespace, visibility);
    await this.authorizeExistingSkillMutation(actor.user, namespace, slug);
    let skillMarkdown: Buffer;
    try {
      ({ skillMarkdown } = await validateZipArchiveFile(archive.path, archive.size, {
        archiveBytes: SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
        expandedBytes: SKILL_HUB_UPLOAD_EXPANDED_BYTES,
        entryBytes: SKILL_HUB_UPLOAD_ENTRY_BYTES,
        files: MAX_SKILL_FILES,
        entries: SKILL_HUB_UPLOAD_ENTRIES,
        retainedEntryBytes: MAX_SKILL_MD_BYTES,
      }));
    } catch (error) {
      if (error instanceof ZipArchiveValidationError) {
        throw new SkillHubServiceError(error.message, 400);
      }
      throw error;
    }
    const metadata = parseSkillMarkdown(skillMarkdown.toString("utf8"), slug);
    if (metadata.version !== version) {
      throw new SkillHubServiceError("SKILL.md version does not match the requested version", 400);
    }
    await this.authorizePublishNamespace(actor.user, namespace);
    const finalCapabilities = await this.resolveNamespaceCapabilities(actor.user, namespace);
    const currentOwnership = await this.authorizeExistingSkillMutation(actor.user, namespace, slug);
    const result = await this.adapterCall(() =>
      this.options.adapter.publish({
        namespace,
        archive,
        filename: `${slug}-${version}.zip`,
        visibility,
      }),
    );
    if (
      result.namespace !== namespace ||
      result.slug !== slug ||
      result.version !== version ||
      result.visibility !== visibility
    ) {
      throw new SkillHubServiceError("Skill Hub returned a mismatched publish result", 502);
    }
    const recorded = await this.options.store.recordSkillHubPublication({
      namespace,
      slug,
      ownerUserId: actor.user.id,
      expectedOwnerUserId: currentOwnership?.ownerUserId ?? null,
      expectedOwnerUpdatedAt: currentOwnership?.updatedAt ?? null,
      expectedBindingUpdatedAt: finalCapabilities.binding!.updatedAt,
      visibility,
      version,
      changedAt: this.now(),
    });
    await this.reconcileOwners();
    await this.enqueueGovernance(recorded.ownerUserId, namespace, slug, version, visibility);
    await this.audit(
      actor.user.id,
      options.source ? "skill-hub.publish" : "skill-hub.publish-upload",
      `${namespace}/${slug}@${version}`,
      {
        visibility,
        archiveBytes: archive.size,
        ...(options.source ? { source: options.source } : {}),
      },
    );
    return recorded.reconciliationRequired
      ? { ...result, ownershipReviewRequired: true as const }
      : result;
  }

  async install(
    actor: AuthenticatedWorkspace,
    params: {
      namespace: string;
      slug: string;
      version: string;
      destination: SkillInstallTarget;
      acknowledgedReplacement?: boolean;
      currentRevision?: string;
    },
  ) {
    const requestKey = JSON.stringify([
      actor.agentId,
      actor.user.id,
      params.destination,
      params.namespace,
      params.slug,
      params.version,
      params.acknowledgedReplacement === true,
      params.currentRevision ?? null,
    ]);
    const existing = this.installsInFlight.get(requestKey);
    if (existing) {
      return await existing;
    }
    const operation = this.withInstallLock(actor.agentId, params.destination, async () =>
      this.installUnlocked(actor, params),
    );
    this.installsInFlight.set(requestKey, operation);
    try {
      return await operation;
    } finally {
      if (this.installsInFlight.get(requestKey) === operation) {
        this.installsInFlight.delete(requestKey);
      }
    }
  }

  private async installUnlocked(
    actor: AuthenticatedWorkspace,
    params: {
      namespace: string;
      slug: string;
      version: string;
      destination: SkillInstallTarget;
      acknowledgedReplacement?: boolean;
      currentRevision?: string;
    },
  ): Promise<SkillHubInstallResult> {
    const execution = await this.authorizeInstallTarget(actor.agentId, params.destination);
    const namespace = this.authorizeNamespace(params.namespace);
    const slug = safeName(params.slug, "skill slug", SKILL_KEY_PATTERN);
    const version = validVersion(params.version);
    const detail = await this.adapterCall(() => this.options.adapter.getSkill(namespace, slug));
    this.validateSkillIdentity(detail.namespace, detail.slug, namespace, slug);
    await this.authorizeSkillAccess(actor.user, namespace, slug, detail.visibility, version);
    const status = await this.gatewayCall<{
      skills?: Array<{ skillKey?: string; source?: string; version?: string; revision?: string }>;
    }>("skills.status", {
      agentId: actor.agentId,
      refresh: true,
      backendTarget: params.destination,
    });
    const installedSource =
      params.destination === "assigned_vm" ? "platformclaw-vm-workspace" : "openclaw-workspace";
    const installed = status?.skills?.find(
      (candidate) => candidate.skillKey === slug && candidate.source === installedSource,
    );
    const installedVersion = installed?.version;
    const installedRevision = installed?.revision;
    if (installed && !installedVersion) {
      throw new SkillHubServiceError("installed skill does not declare a valid version", 409, {
        code: "installed-version-unavailable",
      });
    }
    const replacing = installedVersion !== undefined;
    if (replacing && !/^sha256:[a-f0-9]{16}$/u.test(installedRevision ?? "")) {
      throw new SkillHubServiceError("installed skill revision is unavailable", 409, {
        code: "installed-version-unavailable",
      });
    }
    if (
      replacing &&
      (!params.acknowledgedReplacement || params.currentRevision !== installedRevision)
    ) {
      const comparison = compareSemVer(version, installedVersion);
      const direction = comparison > 0 ? "upgrade" : comparison < 0 ? "downgrade" : "reinstall";
      throw new SkillHubServiceError(
        `confirm replacement of installed ${slug}@${installedVersion}`,
        409,
        {
          code: "existing-skill-replacement-required",
          currentVersion: installedVersion,
          currentRevision: installedRevision,
          requestedVersion: version,
          direction,
        },
      );
    }
    const archive = await this.adapterCall(() =>
      this.options.adapter.download(namespace, slug, version),
    );
    await validateDownloadedArchive(archive, slug, version, {
      archiveBytes: SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
      expandedBytes: SKILL_HUB_UPLOAD_EXPANDED_BYTES,
      entryBytes: SKILL_HUB_UPLOAD_ENTRY_BYTES,
      files: MAX_SKILL_FILES,
      entries: SKILL_HUB_UPLOAD_ENTRIES,
    });
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const begin = await this.gatewayCall<{ uploadId?: string; receivedBytes?: number }>(
      "skills.upload.begin",
      {
        kind: "skill-archive",
        slug,
        sizeBytes: archive.byteLength,
        sha256,
        force: replacing,
        idempotencyKey: JSON.stringify([
          "skill-hub",
          actor.agentId,
          params.destination,
          replacing ? "update" : "install",
          namespace,
          slug,
          version,
          sha256,
        ]),
      },
    );
    const receivedBytes = begin?.receivedBytes;
    if (
      !begin?.uploadId ||
      typeof receivedBytes !== "number" ||
      !Number.isSafeInteger(receivedBytes) ||
      receivedBytes < 0 ||
      receivedBytes > archive.byteLength
    ) {
      throw new SkillHubServiceError("Gateway returned an invalid upload session", 503);
    }
    // Begin is the resume authority: retries continue a partial upload and skip chunks after commit.
    for (let offset = receivedBytes; offset < archive.byteLength; offset += UPLOAD_CHUNK_BYTES) {
      const chunk = archive.subarray(
        offset,
        Math.min(offset + UPLOAD_CHUNK_BYTES, archive.byteLength),
      );
      await this.gatewayCall("skills.upload.chunk", {
        uploadId: begin.uploadId,
        offset,
        dataBase64: chunk.toString("base64"),
      });
    }
    await this.gatewayCall("skills.upload.commit", { uploadId: begin.uploadId, sha256 });
    const currentDetail = await this.adapterCall(() =>
      this.options.adapter.getSkill(namespace, slug),
    );
    this.validateSkillIdentity(currentDetail.namespace, currentDetail.slug, namespace, slug);
    await this.authorizeSkillAccess(actor.user, namespace, slug, currentDetail.visibility, version);
    const result = await this.gatewayCall<Record<string, unknown>>("skills.install", {
      agentId: actor.agentId,
      source: "upload",
      uploadId: begin.uploadId,
      slug,
      force: replacing,
      sha256,
      destination: "sandbox-backend",
      backendTarget: params.destination,
      expectedTargetRevision: execution.targetRevision,
      ...(installedRevision ? { expectedSkillRevision: installedRevision } : {}),
    });
    if (result.ok !== true || result.slug !== slug) {
      throw new SkillHubServiceError("Gateway returned an invalid install result", 503);
    }
    await this.audit(actor.user.id, "skill-hub.install", `${namespace}/${slug}@${version}`, {
      agentId: actor.agentId,
      sha256,
      destination: params.destination,
    });
    return {
      ok: true,
      noOp: false,
      slug,
      version,
      target: params.destination,
    };
  }
}
