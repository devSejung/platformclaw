import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { SkillHubPublishArchive } from "./skill-hub-adapter.js";
import type { SkillHubCatalogEntry, SkillHubSharing } from "./skill-hub-catalog-state.js";
import { assertSkillHubWorkspace } from "./skill-hub-command-workspace.js";
import { SkillHubInstallationService } from "./skill-hub-service-installation.js";
import {
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
  validVersion,
  type AuthenticatedWorkspace,
  type SkillInstallTarget,
  type SkillHubTargetSnapshot,
} from "./skill-hub-service-support.js";
import { downloadVmWorkspaceArchive } from "./skill-hub-workspace-export.js";
import { validateZipArchiveFile, ZipArchiveValidationError } from "./zip-archive-validator.js";

type SkillHubPublicationRequest = {
  operationId: string;
  slug: string;
  version: string;
  id?: string;
  expectedRevision?: number;
  sharing?: SkillHubSharing;
  reason?: string;
};
type SkillHubPublicationSource =
  | { kind: "zip" }
  | { kind: SkillInstallTarget; target: SkillHubTargetSnapshot };

export abstract class SkillHubPublicationService extends SkillHubInstallationService {
  /** Caller holds the coordinate lock; persist identity before archive or deletion I/O. */
  protected async ensureArtifactIdentity(
    entry: SkillHubCatalogEntry,
    revalidateAuthority: () => Promise<void>,
  ) {
    if (entry.registryId !== null) {
      try {
        return await this.artifactSkill(entry);
      } catch (error) {
        if (error instanceof SkillHubServiceError && error.statusCode === 404) {
          throw new SkillHubServiceError(
            "Registry skill identity changed; publication stopped",
            409,
          );
        }
        throw error;
      }
    }
    const governance = this.options.governance;
    if (!governance?.createNamespace) {
      throw new SkillHubServiceError("Managed registry publication is unavailable", 503);
    }
    await revalidateAuthority();
    await this.adapterCall(() =>
      governance.createNamespace!({ namespace: entry.namespace, operationId: entry.id }),
    );
    const native = await this.adapterCall(() =>
      governance.reserveArtifactIdentity({
        namespace: entry.namespace,
        slug: entry.slug,
        publicationId: entry.id,
        revalidateAuthority,
      }),
    );
    this.validateSkillIdentity(native.namespace, native.slug, entry.namespace, entry.slug);
    // Await the SQLite transaction's commit. A lost archive response must never
    // leave package bytes whose immutable cleanup identity exists only in memory.
    await this.options.store.skillHubCatalog.bindRegistryIdentity({
      skillId: entry.id,
      registryId: native.id,
      expectedNamespace: entry.namespace,
      expectedSlug: entry.slug,
    });
    return native;
  }

  async publish(
    actor: AuthenticatedWorkspace,
    params: {
      operationId: string;
      skill: string;
      source?: SkillInstallTarget;
      expectedTargetId?: string;
      version: string;
      id?: string;
      expectedRevision?: number;
      sharing?: SkillHubSharing;
      reason?: string;
    },
  ) {
    const slug = safeName(params.skill, "skill", SKILL_KEY_PATTERN);
    const version = validVersion(params.version);
    if (params.id) {
      await this.requireManager(actor.user, params.id);
    }
    const source = params.source ?? (await this.resolveExecutionTarget(actor.agentId)).activeTarget;
    const execution = await this.authorizeInstallTarget(actor.agentId, source);
    if (params.expectedTargetId !== undefined && params.expectedTargetId !== execution.targetId) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
        {
          code: "skill-hub-changed",
        },
      );
    }
    await assertSkillHubWorkspace(this.options.store, actor);
    if (source === "assigned_vm") {
      const archive = await downloadVmWorkspaceArchive(this.gatewayCall.bind(this), {
        agentId: actor.agentId,
        slug,
        version,
        expectedTargetRevision: execution.targetRevision,
        expectedAllocationId: execution.allocationId!,
      });
      try {
        return await this.publishArchiveFromSource(actor, { ...params, slug }, archive, {
          kind: source,
          target: execution,
        });
      } finally {
        await archive.cleanup();
      }
    }
    const archive = await this.packageWorkspaceSkill(actor.workspaceDir, slug, version);
    try {
      return await this.publishValidated(
        actor,
        { ...params, slug, version },
        archive,
        archive.summary,
        { kind: source, target: execution },
      );
    } finally {
      await archive.cleanup();
    }
  }

  async publishArchive(
    actor: AuthenticatedWorkspace,
    params: SkillHubPublicationRequest,
    archive: { path: string; size: number },
  ) {
    return await this.publishArchiveFromSource(actor, params, archive, { kind: "zip" });
  }

  private async publishArchiveFromSource(
    actor: AuthenticatedWorkspace,
    params: SkillHubPublicationRequest,
    archive: { path: string; size: number },
    source: SkillHubPublicationSource,
  ) {
    const slug = safeName(params.slug, "skill slug", SKILL_KEY_PATTERN);
    const version = validVersion(params.version);
    let summary: string;
    try {
      const { skillMarkdown } = await validateZipArchiveFile(archive.path, archive.size, {
        archiveBytes: SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
        expandedBytes: SKILL_HUB_UPLOAD_EXPANDED_BYTES,
        entryBytes: SKILL_HUB_UPLOAD_ENTRY_BYTES,
        files: MAX_SKILL_FILES,
        entries: SKILL_HUB_UPLOAD_ENTRIES,
        retainedEntryBytes: MAX_SKILL_MD_BYTES,
      });
      const metadata = parseSkillMarkdown(skillMarkdown.toString("utf8"), slug);
      summary = metadata.description;
      if (metadata.version !== version) {
        throw new SkillHubServiceError(
          "SKILL.md version does not match the requested version",
          400,
          { code: "skill-hub-version-mismatch" },
        );
      }
    } catch (error) {
      if (error instanceof ZipArchiveValidationError) {
        throw new SkillHubServiceError(error.message, 400, { code: "skill-hub-invalid-archive" });
      }
      throw error;
    }
    return await this.publishValidated(
      actor,
      { ...params, slug, version },
      archive,
      summary,
      source,
    );
  }

  private async publishValidated(
    actor: AuthenticatedWorkspace,
    params: SkillHubPublicationRequest,
    archive: SkillHubPublishArchive,
    summary: string,
    source: SkillHubPublicationSource,
  ) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(params.operationId)) {
      throw new SkillHubServiceError("Publication operation ID is required", 400);
    }
    const governance = this.options.governance;
    if (!governance?.createNamespace) {
      throw new SkillHubServiceError("Managed registry publication is unavailable", 503);
    }
    const catalog = this.options.store.skillHubCatalog;
    if (params.id) {
      const entry = await this.requireManager(actor.user, params.id);
      if (params.sharing !== undefined) {
        throw new SkillHubServiceError(
          "Change sharing in the skill details before publishing a new version",
          400,
        );
      }
      if (!(await catalog.getPublication(params.operationId))) {
        const versions = await this.artifactVersions(await this.artifactSkill(entry));
        if (versions.some((version) => version.version === params.version)) {
          throw new SkillHubServiceError(
            "This version already exists. Increase the version before publishing changed files.",
            409,
            { code: "skill-hub-version-exists" },
          );
        }
      }
    }
    const hash = createHash("sha256");
    if (Buffer.isBuffer(archive)) {
      hash.update(archive);
    } else {
      for await (const chunk of createReadStream(archive.path)) {
        hash.update(chunk);
      }
    }
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          archive: hash.digest("hex"),
          source:
            source.kind === "zip"
              ? source
              : { kind: source.kind, targetId: source.target.targetId },
          slug: params.slug,
          version: params.version,
          id: params.id ?? null,
          expectedRevision: params.expectedRevision ?? null,
          sharing: params.sharing ?? null,
          reason: params.reason ?? null,
        }),
      )
      .digest("hex");
    await assertSkillHubWorkspace(this.options.store, actor);
    if (source.kind !== "zip") {
      await this.revalidateInstallTarget(actor.agentId, source.kind, source.target);
    }
    // The reservation transaction owns reuse: concurrent identical requests can
    // both observe no receipt before one of them commits the first reservation.
    const { entry, reused: recovering } = await catalog.reservePublication({
      operationId: params.operationId,
      ...(params.id ? { skillId: params.id } : {}),
      actorUserId: actor.user.id,
      slug: params.slug,
      version: params.version,
      fingerprint,
      expectedRevision: params.expectedRevision,
      sharing: params.sharing,
      summary,
      reason: params.reason,
      now: this.now(),
    });
    return await this.withRegistryMutationLock(entry.namespace, entry.slug, async () => {
      const receipt = await catalog.getPublication(params.operationId);
      if (receipt?.state === "completed") {
        await this.requireManager(actor.user, entry.id);
        return { id: entry.id, slug: entry.slug, version: params.version };
      }
      await catalog.validatePublication(params.operationId);
      await assertSkillHubWorkspace(this.options.store, actor);
      await catalog.validatePublication(params.operationId);
      const revalidateAuthority = async () => {
        await assertSkillHubWorkspace(this.options.store, actor);
        await catalog.validatePublication(params.operationId);
        if (source.kind !== "zip") {
          await this.revalidateInstallTarget(actor.agentId, source.kind, source.target);
        }
      };
      let native = await this.ensureArtifactIdentity(entry, revalidateAuthority);
      const registryId = native.id;
      const exists = (await this.artifactVersions(native)).some(
        (version) => version.version === params.version,
      );
      if (exists && !recovering) {
        await catalog.cancelPublication({
          operationId: params.operationId,
          actorUserId: actor.user.id,
          reason: params.reason,
          now: this.now(),
        });
        throw new SkillHubServiceError(
          "This version already exists. Increase the version before publishing changed files.",
          409,
          { code: "skill-hub-version-exists" },
        );
      }
      if (!exists) {
        await assertSkillHubWorkspace(this.options.store, actor);
        await catalog.validatePublication(params.operationId);
        // Registry identity is a private artifact publisher. Employee audience is
        // authoritative in the catalog, independent of native review/namespace policy.
        const result = await this.adapterCall(() =>
          governance.publishArtifact({
            namespace: entry.namespace,
            expectedSkillId: registryId,
            archive,
            filename: `${entry.slug}-${params.version}.zip`,
            revalidateAuthority,
          }),
        );
        if (
          result.namespace !== entry.namespace ||
          result.slug !== entry.slug ||
          result.version !== params.version ||
          result.skillId !== registryId
        ) {
          throw new SkillHubServiceError("Registry returned a mismatched publication", 502);
        }
        try {
          native = await this.artifactSkill({ ...entry, registryId: result.skillId });
        } catch (error) {
          if (error instanceof SkillHubServiceError && error.statusCode === 409) {
            // After native success, this contradicts the returned immutable ID;
            // it is an invalid upstream result, not a caller revision conflict.
            throw new SkillHubServiceError(
              "Registry returned a mismatched publication identity",
              502,
            );
          }
          throw error;
        }
        if (native.id !== result.skillId) {
          throw new SkillHubServiceError(
            "Registry returned a mismatched publication identity",
            502,
          );
        }
      }
      this.validateSkillIdentity(native.namespace, native.slug, entry.namespace, entry.slug);
      const recorded = await catalog.completePublication({
        operationId: params.operationId,
        registryId: native.id,
        now: this.now(),
      });
      this.triggerGovernanceProcessing();
      return { id: recorded.id, slug: recorded.slug, version: params.version };
    });
  }

  /** Caller holds the native coordinate mutation lock through reconciliation. */
  protected async reconcilePublication(operationId: string): Promise<boolean> {
    const catalog = this.options.store.skillHubCatalog;
    const receipt = await catalog.getPublication(operationId);
    if (!receipt || receipt.state !== "pending") {
      return receipt?.state === "completed";
    }
    const entry = await catalog.get(receipt.skillId);
    if (!entry) {
      throw new SkillHubServiceError("Publication skill is unavailable", 409);
    }
    let native;
    try {
      native = await this.artifactSkill(entry);
    } catch (error) {
      if (error instanceof SkillHubServiceError && error.statusCode === 404) {
        return false;
      }
      throw error;
    }
    await catalog.bindRegistryIdentity({
      skillId: entry.id,
      registryId: native.id,
      expectedNamespace: entry.namespace,
      expectedSlug: entry.slug,
    });
    if (
      !(await this.artifactVersions(native)).some((version) => version.version === receipt.version)
    ) {
      return false;
    }
    await catalog.completePublication({ operationId, registryId: native.id, now: this.now() });
    return true;
  }
}
