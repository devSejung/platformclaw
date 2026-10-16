import { createHash } from "node:crypto";
import type { PlatformUser } from "./contracts.js";
import type { SkillHubVisibility } from "./skill-hub-adapter.js";
import { SkillHubCatalogService } from "./skill-hub-catalog-service.js";
import { assertSkillHubWorkspace } from "./skill-hub-command-workspace.js";
import {
  compareSemVer,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  parseSkillMarkdown,
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
  type SkillHubAudience,
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

export abstract class SkillHubPublicationService extends SkillHubCatalogService {
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
    return await this.withRegistryMutationLock(namespace, skill, async () => {
      await this.authorizePublishNamespace(actor.user, namespace);
      const finalCapabilities = await this.resolveNamespaceCapabilities(actor.user, namespace);
      const currentOwnership = await this.authorizeExistingSkillMutation(
        actor.user,
        namespace,
        skill,
      );
      await assertSkillHubWorkspace(this.options.store, actor);
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
    });
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
    return await this.withRegistryMutationLock(namespace, slug, async () => {
      await this.authorizePublishNamespace(actor.user, namespace);
      const finalCapabilities = await this.resolveNamespaceCapabilities(actor.user, namespace);
      const currentOwnership = await this.authorizeExistingSkillMutation(
        actor.user,
        namespace,
        slug,
      );
      await assertSkillHubWorkspace(this.options.store, actor);
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
    });
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
      expectedTargetRevision?: number;
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
      params.expectedTargetRevision ?? null,
    ]);
    const existing = this.installsInFlight.get(requestKey);
    if (existing) {
      return await existing;
    }
    const operation = this.withInstallLock(actor.agentId, params.destination, async () =>
      this.withRegistryMutationLock(params.namespace, params.slug, () =>
        this.installUnlocked(actor, params),
      ),
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
      expectedTargetRevision?: number;
    },
  ): Promise<SkillHubInstallResult> {
    const execution = await this.authorizeInstallTarget(actor.agentId, params.destination);
    if (
      params.expectedTargetRevision !== undefined &&
      params.expectedTargetRevision !== execution.targetRevision
    ) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
      );
    }
    const namespace = this.authorizeNamespace(params.namespace);
    const slug = safeName(params.slug, "skill slug", SKILL_KEY_PATTERN);
    const version = validVersion(params.version);
    const detail = await this.adapterCall(() => this.options.adapter.getSkill(namespace, slug));
    this.validateSkillIdentity(detail.namespace, detail.slug, namespace, slug);
    await this.authorizeSkillAccess(
      actor.user,
      namespace,
      slug,
      detail.visibility,
      version,
      actor.roomBinding ? "room" : "employee",
    );
    await this.authorizeVersionInstallation(
      actor.user,
      namespace,
      slug,
      version,
      detail.visibility,
      actor.roomBinding ? "room" : "employee",
    );
    const status = await this.gatewayCall<{
      skills?: Array<{ skillKey?: string; source?: string; version?: string; revision?: string }>;
    }>("skills.status", {
      agentId: actor.agentId,
      refresh: true,
      ...(actor.roomBinding ? {} : { backendTarget: params.destination }),
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
    await this.authorizeSkillAccess(
      actor.user,
      namespace,
      slug,
      currentDetail.visibility,
      version,
      actor.roomBinding ? "room" : "employee",
    );
    await this.authorizeVersionInstallation(
      actor.user,
      namespace,
      slug,
      version,
      currentDetail.visibility,
      actor.roomBinding ? "room" : "employee",
    );
    await assertSkillHubWorkspace(this.options.store, actor);
    const result = await this.gatewayCall<Record<string, unknown>>("skills.install", {
      agentId: actor.agentId,
      source: "upload",
      uploadId: begin.uploadId,
      slug,
      force: replacing,
      sha256,
      destination: "sandbox-backend",
      ...(actor.roomBinding ? {} : { backendTarget: params.destination }),
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

  private async authorizeVersionInstallation(
    user: PlatformUser,
    namespace: string,
    slug: string,
    version: string,
    visibility: SkillHubVisibility,
    audience: SkillHubAudience,
  ) {
    const ownership = await this.options.store.getSkillHubOwnership(namespace, slug);
    // Personal preview rights cannot authorize an unpublished release for a room.
    if (
      audience === "employee" &&
      (visibility === "PRIVATE" ||
        user.globalRole === "admin" ||
        ownership?.ownerUserId === user.id)
    ) {
      return;
    }
    const state = await this.adapterCall(() =>
      this.options.adapter.getVersionState(namespace, slug, version),
    );
    if (state.version !== version || state.status !== "PUBLISHED") {
      throw new SkillHubServiceError(
        "This version is awaiting publication; choose a published version or retry after approval.",
        409,
        { code: "version-not-published" },
      );
    }
  }
}
