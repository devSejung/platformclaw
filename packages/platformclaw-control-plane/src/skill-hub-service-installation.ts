import { createHash } from "node:crypto";
import type { PlatformUser } from "./contracts.js";
import { SkillHubCatalogService } from "./skill-hub-catalog-service.js";
import { assertSkillHubWorkspace } from "./skill-hub-command-workspace.js";
import {
  compareSemVer,
  isValidSkillHubVersion,
  MAX_SKILL_FILES,
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SKILL_HUB_UPLOAD_ENTRY_BYTES,
  SKILL_HUB_UPLOAD_EXPANDED_BYTES,
  SKILL_HUB_UPLOAD_ENTRIES,
  SkillHubServiceError,
  UPLOAD_CHUNK_BYTES,
  validVersion,
  validateDownloadedArchive,
  type AuthenticatedWorkspace,
  type SkillHubAudience,
  type SkillInstallTarget,
  type SkillHubTargetSnapshot,
} from "./skill-hub-service-support.js";

type SkillHubInstallResult = {
  ok: true;
  noOp: false;
  slug: string;
  version: string;
  target: SkillInstallTarget;
};

export abstract class SkillHubInstallationService extends SkillHubCatalogService {
  private readonly installsInFlight = new Map<string, Promise<SkillHubInstallResult>>();

  async install(
    actor: AuthenticatedWorkspace,
    params: {
      id: string;
      version: string;
      destination: SkillInstallTarget;
      expectedTargetId?: string;
      acknowledgedReplacement?: boolean;
      currentRevision?: string;
      expectedTargetRevision?: number;
    },
  ) {
    const execution = await this.authorizeInstallTarget(actor.agentId, params.destination);
    const requestKey = JSON.stringify([
      actor.agentId,
      actor.user.id,
      params.destination,
      params.expectedTargetId ?? null,
      execution.targetId,
      execution.targetRevision,
      execution.allocationId ?? null,
      params.id,
      params.version,
      params.acknowledgedReplacement === true,
      params.currentRevision ?? null,
      params.expectedTargetRevision ?? null,
    ]);
    const existing = this.installsInFlight.get(requestKey);
    if (existing) {
      return await existing;
    }
    const operation = this.withWorkspaceMutationLock(actor.agentId, params.destination, async () =>
      this.withRegistryMutationLock("catalog", params.id, () =>
        this.installUnlocked(actor, params, execution),
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
      id: string;
      version: string;
      destination: SkillInstallTarget;
      expectedTargetId?: string;
      acknowledgedReplacement?: boolean;
      currentRevision?: string;
      expectedTargetRevision?: number;
    },
    execution: SkillHubTargetSnapshot,
  ): Promise<SkillHubInstallResult> {
    await this.revalidateInstallTarget(actor.agentId, params.destination, execution);
    if (params.expectedTargetId !== undefined && params.expectedTargetId !== execution.targetId) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
        {
          code: "skill-hub-changed",
        },
      );
    }
    if (
      params.expectedTargetRevision !== undefined &&
      params.expectedTargetRevision !== execution.targetRevision
    ) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
      );
    }
    const entry = await this.requireEntry(
      actor.user,
      params.id,
      actor.roomBinding ? "room" : "employee",
    );
    const { namespace, slug } = entry;
    const version = validVersion(params.version);
    const selected = await this.authorizeVersionInstallation(
      actor.user,
      entry.id,
      version,
      actor.roomBinding ? "room" : "employee",
    );
    const status = await this.gatewayCall<{
      skills?: Array<{ baseDir?: string; source?: string; version?: string; revision?: string }>;
    }>("skills.status", {
      agentId: actor.agentId,
      refresh: true,
      ...(actor.roomBinding ? {} : { backendTarget: params.destination }),
    });
    const installed = status?.skills?.find(
      (candidate) => this.workspaceSkillSlug(candidate, params.destination) === slug,
    );
    await this.revalidateInstallTarget(actor.agentId, params.destination, execution);
    const origin = (
      await this.options.store.skillHubCatalog.listInstallations(actor.agentId, execution.targetId)
    ).find((item) => item.destination === params.destination && item.slug === slug);
    const installedVersion = installed?.version;
    const installedRevision = installed?.revision;
    if (installed && (!installedVersion || !isValidSkillHubVersion(installedVersion))) {
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
        origin?.state === "pending"
          ? "The previous installation result is unconfirmed. Review the current workspace and confirm replacement to retry."
          : `confirm replacement of installed ${slug}@${installedVersion}`,
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
    if (!this.options.governance || entry.registryId === null) {
      throw new SkillHubServiceError("Managed artifact access is unavailable", 503);
    }
    const archive = await this.options.governance.downloadArtifact({
      skillId: entry.registryId,
      versionId: selected.id,
      namespace,
      slug,
    });
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
          execution.targetId,
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
    await this.authorizeVersionInstallation(
      actor.user,
      entry.id,
      version,
      actor.roomBinding ? "room" : "employee",
    );
    await assertSkillHubWorkspace(this.options.store, actor);
    await this.revalidateInstallTarget(actor.agentId, params.destination, execution);
    const installation = await this.options.store.skillHubCatalog.recordInstallation({
      agentId: actor.agentId,
      destination: params.destination,
      targetId: execution.targetId,
      slug,
      skillId: entry.id,
      version,
      archiveSha256: sha256,
      operationId: begin.uploadId,
      installedAt: this.now(),
      state: "pending",
    });
    await this.authorizeVersionInstallation(
      actor.user,
      entry.id,
      version,
      actor.roomBinding ? "room" : "employee",
    );
    await assertSkillHubWorkspace(this.options.store, actor);
    await this.revalidateInstallTarget(actor.agentId, params.destination, execution);
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
    const installedStatus = await this.workspaceSkills(actor, params.destination, execution);
    const installedSkill = installedStatus.items.find((item) => item.skillKey === slug);
    if (
      !installedSkill?.revision ||
      !/^sha256:[a-f0-9]{16}$/u.test(installedSkill.revision) ||
      installedSkill.version !== version
    ) {
      throw new SkillHubServiceError(
        "Installation completed but its revision is not verified; refresh the workspace before retrying",
        503,
      );
    }
    await this.options.store.skillHubCatalog.completeInstallation({
      operationId: installation.operationId,
      agentId: actor.agentId,
      destination: params.destination,
      targetId: execution.targetId,
      slug,
      skillId: entry.id,
      version,
      archiveSha256: sha256,
      installedRevision: installedSkill.revision,
      now: this.now(),
    });
    return {
      ok: true,
      noOp: false,
      slug,
      version,
      target: params.destination,
    };
  }

  protected async authorizeVersionInstallation(
    user: PlatformUser,
    id: string,
    version: string,
    audience: SkillHubAudience,
  ) {
    const entry = await this.requireEntry(user, id, audience);
    const versions = await this.versionScans(entry);
    const selected = versions.find((candidate) => candidate.version === version);
    if (!selected?.downloadAvailable) {
      throw new SkillHubServiceError(
        selected?.scanner.blocked
          ? "This version is blocked as confirmed malware"
          : "This version is not ready to download",
        409,
        {
          code: selected?.scanner.blocked
            ? "skill-hub-version-blocked"
            : "skill-hub-version-unavailable",
        },
      );
    }
    await this.requireEntry(user, id, audience);
    return selected;
  }

  async download(
    user: PlatformUser,
    id: string,
    versionRaw: string,
    audience: SkillHubAudience = "employee",
  ) {
    const version = validVersion(versionRaw);
    const entry = await this.requireEntry(user, id, audience);
    const selected = await this.authorizeVersionInstallation(user, id, version, audience);
    if (!this.options.governance || entry.registryId === null) {
      throw new SkillHubServiceError("Managed artifact access is unavailable", 503);
    }
    const archive = await this.options.governance.downloadArtifact({
      skillId: entry.registryId,
      versionId: selected.id,
      namespace: entry.namespace,
      slug: entry.slug,
    });
    await validateDownloadedArchive(archive, entry.slug, version, {
      archiveBytes: SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
      expandedBytes: SKILL_HUB_UPLOAD_EXPANDED_BYTES,
      entryBytes: SKILL_HUB_UPLOAD_ENTRY_BYTES,
      files: MAX_SKILL_FILES,
      entries: SKILL_HUB_UPLOAD_ENTRIES,
    });
    await this.authorizeVersionInstallation(user, id, version, audience);
    return { archive, filename: `${entry.slug}-${version}.zip` };
  }
}
