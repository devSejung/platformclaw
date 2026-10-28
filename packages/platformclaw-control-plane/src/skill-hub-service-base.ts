import { constants as fsConstants, createWriteStream, type Stats } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import JSZip from "jszip";
import { ControlPlaneStateError, type PlatformUser } from "./contracts.js";
import { GatewayAdminRpcError } from "./gateway-admin-rpc-client.js";
import { SkillHubAdapterError } from "./skill-hub-adapter.js";
import { isExcludedSkillArchivePath } from "./skill-hub-archive-policy.js";
import type { SkillHubCatalogEntry } from "./skill-hub-catalog-state.js";
import { SkillHubGovernanceError } from "./skill-hub-governance-client.js";
import {
  isInside,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  parseSkillMarkdown,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  SKILL_HUB_UPLOAD_ARCHIVE_BYTES,
  SKILL_HUB_UPLOAD_ENTRY_BYTES,
  SKILL_HUB_UPLOAD_EXPANDED_BYTES,
  type SkillHubServiceOptions,
  type SkillInstallTarget,
  type SkillHubTargetSnapshot,
  type SkillHubAudience,
} from "./skill-hub-service-support.js";

const MAX_SKILL_DIRECTORY_DEPTH = 16;

export abstract class SkillHubServiceBase {
  protected readonly workspaceRoot: string;
  private readonly installLocks = new Map<string, Promise<void>>();
  protected governanceProcessing = false;
  protected governanceTimer?: NodeJS.Timeout;
  protected governanceClosed = false;
  protected maintenanceError: string | null = null;

  protected abstract processGovernanceQueue(): Promise<{ processed: number }>;

  constructor(protected readonly options: SkillHubServiceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    if (!Number.isSafeInteger(options.maxPackageBytes) || options.maxPackageBytes <= 0) {
      throw new Error("Skill Hub package limit must be a positive integer");
    }
  }

  protected async withWorkspaceMutationLock<T>(
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

  close(): void {
    this.governanceClosed = true;
    if (this.governanceTimer) {
      clearTimeout(this.governanceTimer);
      this.governanceTimer = undefined;
    }
  }

  protected async authorizeInstallTarget(
    agentId: string,
    destination: SkillInstallTarget,
  ): Promise<SkillHubTargetSnapshot> {
    const profile = await this.options.store.getPersonalExecutionProfile(agentId);
    if (!profile) {
      if (destination === "platform_server") {
        return { targetId: "platform-server", targetRevision: 0 };
      }
      throw new SkillHubServiceError("My VM workspace is not assigned.", 409, {
        code: "skill-hub-vm-unassigned",
      });
    }
    if (destination === "assigned_vm") {
      const allocation = await this.options.store.getVmAllocationForAgent(agentId);
      if (allocation?.status !== "ready" || !allocation.remoteWorkspaceDir) {
        throw new SkillHubServiceError("My VM workspace is not ready.", 409, {
          code: "skill-hub-vm-not-ready",
        });
      }
      try {
        const target = await this.options.store.resolvePersonalExecutionTarget(
          agentId,
          destination,
        );
        if (target.kind !== "assigned_vm") {
          throw new ControlPlaneStateError("Assigned VM execution target is unavailable");
        }
        return {
          targetId: target.targetId,
          targetRevision: target.revision,
          allocationId: target.allocationId,
          targetLabel: target.vmLabel,
        };
      } catch (error) {
        if (error instanceof ControlPlaneStateError) {
          throw new SkillHubServiceError(error.message, 409, { code: "skill-hub-vm-unavailable" });
        }
        throw error;
      }
    }
    return { targetId: "platform-server", targetRevision: profile.targetRevision };
  }

  protected async revalidateInstallTarget(
    agentId: string,
    destination: SkillInstallTarget,
    expected: SkillHubTargetSnapshot,
  ): Promise<void> {
    const current = await this.authorizeInstallTarget(agentId, destination);
    if (
      current.targetId !== expected.targetId ||
      current.targetRevision !== expected.targetRevision ||
      current.allocationId !== expected.allocationId
    ) {
      throw new SkillHubServiceError(
        "Skill Hub execution target changed; check status and retry.",
        409,
      );
    }
  }

  protected async resolveExecutionTarget(agentId: string): Promise<{
    activeTarget: SkillInstallTarget;
    targetRevision: number;
  }> {
    const profile = await this.options.store.getPersonalExecutionProfile(agentId);
    if (!profile) {
      return { activeTarget: "platform_server", targetRevision: 0 };
    }
    if (profile.activeTarget === "assigned_vm" && !profile.activeAllocationId) {
      throw new SkillHubServiceError("Assigned VM target is unavailable; reload and retry.", 409, {
        code: "skill-hub-vm-unavailable",
      });
    }
    return { activeTarget: profile.activeTarget, targetRevision: profile.targetRevision };
  }

  protected workspaceSkillSlug(
    skill: { source?: string; baseDir?: string },
    target: SkillInstallTarget,
  ): string | undefined {
    const source = target === "assigned_vm" ? "platformclaw-vm-workspace" : "openclaw-workspace";
    if (skill.source !== source || !skill.baseDir) {
      return undefined;
    }
    // Hub archives mutate a physical directory. Frontmatter can override skillKey,
    // so matching that logical key can miss an installed package or remove another one.
    const slug = path.posix.basename(skill.baseDir.replaceAll("\\", "/"));
    return SKILL_KEY_PATTERN.test(slug) ? slug : undefined;
  }

  protected async activeUser(userId: string): Promise<PlatformUser> {
    const user = await this.options.store.getUserById(userId);
    if (!user || user.status !== "active") {
      throw new SkillHubServiceError("Active employee account required", 401);
    }
    return user;
  }

  protected async requireEntry(
    user: PlatformUser,
    id: string,
    audience: SkillHubAudience = "employee",
  ): Promise<SkillHubCatalogEntry> {
    const entry = await this.options.store.skillHubCatalog.get(id);
    if (
      !entry ||
      !(await this.options.store.skillHubCatalog.canAccess({
        skillId: id,
        userId: user.id,
        audience,
      }))
    ) {
      throw new SkillHubServiceError("Skill Hub skill not found", 404);
    }
    return entry;
  }

  protected async requireManager(user: PlatformUser, id: string): Promise<SkillHubCatalogEntry> {
    const current = await this.activeUser(user.id);
    const entry = await this.options.store.skillHubCatalog.get(id);
    if (!entry || entry.purgedAt !== null || entry.purgePending) {
      throw new SkillHubServiceError("Skill Hub skill not found", 404);
    }
    if (current.globalRole !== "admin" && entry.ownerUserId !== current.id) {
      throw new SkillHubServiceError("Skill owner or administrator required", 403);
    }
    return entry;
  }

  protected triggerGovernanceProcessing(delayMs = 1_000): void {
    if (this.governanceClosed || this.governanceProcessing || this.governanceTimer) {
      return;
    }
    this.governanceTimer = setTimeout(() => {
      this.governanceTimer = undefined;
      void this.processGovernanceQueue().catch(() => undefined);
    }, delayMs);
    this.governanceTimer.unref();
  }

  protected now(): number {
    return (this.options.now ?? Date.now)();
  }

  protected validateSkillIdentity(
    actualNamespace: string,
    actualSlug: string,
    expectedNamespace: string,
    expectedSlug: string,
  ): void {
    if (actualNamespace !== expectedNamespace || actualSlug !== expectedSlug) {
      throw new SkillHubServiceError("Skill Hub returned mismatched skill details", 502);
    }
  }

  protected async artifactSkill(entry: {
    id?: string;
    namespace: string;
    slug: string;
    registryId: number | null;
  }) {
    const governance = this.options.governance;
    if (!governance) {
      throw new SkillHubServiceError("Managed artifact access is unavailable", 503);
    }
    return await this.adapterCall(() =>
      governance.getArtifactSkill({
        namespace: entry.namespace,
        slug: entry.slug,
        ...(entry.registryId === null ? {} : { expectedSkillId: entry.registryId }),
        ...(entry.registryId === null && entry.id ? { expectedPublicationId: entry.id } : {}),
      }),
    );
  }

  protected async artifactVersions(
    identity: { id: number; namespace: string; slug: string },
    currentVersion?: string | null,
  ) {
    const governance = this.options.governance;
    if (!governance) {
      throw new SkillHubServiceError("Managed artifact access is unavailable", 503);
    }
    const versions = await this.adapterCall(() =>
      governance.listArtifactVersions({
        skillId: identity.id,
        namespace: identity.namespace,
        slug: identity.slug,
      }),
    );
    // Registry pagination order is transport data. Catalog publication identity
    // owns the current version; remaining history has a stable newest-ID order.
    return versions.toSorted(
      (left, right) =>
        Number(right.version === currentVersion) - Number(left.version === currentVersion) ||
        right.id - left.id,
    );
  }

  protected async packageWorkspaceSkill(
    workspaceDir: string,
    skill: string,
    version: string,
  ): Promise<{ path: string; size: number; summary: string; cleanup(): Promise<void> }> {
    const skillDir = path.resolve(workspaceDir, "skills", skill);
    const skillsDir = path.resolve(workspaceDir, "skills");
    if (!isInside(skillsDir, skillDir) || skillDir === skillsDir) {
      throw new SkillHubServiceError("invalid workspace skill path", 400);
    }
    const rootStat = await lstat(skillDir).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw new SkillHubServiceError("workspace skill directory is unavailable", 404);
    }
    const realRoot = await realpath(skillDir);
    if (!isInside(await realpath(skillsDir), realRoot)) {
      throw new SkillHubServiceError("workspace skill escapes the skills directory", 400);
    }
    const files: Array<{ absolute: string; relative: string; stat: Stats }> = [];
    const pending = [{ directory: skillDir, depth: 0 }];
    while (pending.length > 0) {
      const { directory: current, depth } = pending.pop()!;
      const entries = (await readdir(current, { withFileTypes: true })).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) {
          throw new SkillHubServiceError("workspace skill contains a symbolic link", 400);
        }
        if (!isInside(realRoot, await realpath(absolute))) {
          throw new SkillHubServiceError("workspace skill contains an escaping path", 400);
        }
        if (isExcludedSkillArchivePath(entry.name, stat.isDirectory())) {
          continue;
        }
        if (stat.isDirectory()) {
          if (depth >= MAX_SKILL_DIRECTORY_DEPTH) {
            throw new SkillHubServiceError(
              "workspace skill exceeds the directory depth limit",
              400,
            );
          }
          pending.push({ directory: absolute, depth: depth + 1 });
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) {
          throw new SkillHubServiceError("workspace skill contains an unsupported file", 400);
        }
        files.push({
          absolute,
          relative: path.relative(skillDir, absolute).split(path.sep).join("/"),
          stat,
        });
        if (files.length > MAX_SKILL_FILES || stat.size > SKILL_HUB_UPLOAD_ENTRY_BYTES) {
          throw new SkillHubServiceError(
            "workspace skill exceeds the configured package limit",
            400,
          );
        }
      }
    }
    if (!files.some((file) => file.relative === "SKILL.md")) {
      throw new SkillHubServiceError("workspace skill is missing SKILL.md", 400);
    }

    let totalBytes = 0;
    let summary: string | undefined;
    const countBytes = (bytes: number) => {
      totalBytes += bytes;
      if (totalBytes > SKILL_HUB_UPLOAD_EXPANDED_BYTES) {
        throw new SkillHubServiceError("workspace skill exceeds the configured package limit", 400);
      }
    };
    const readSource = async function* (file: (typeof files)[number]) {
      const flags =
        process.platform === "win32"
          ? fsConstants.O_RDONLY
          : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
      const handle = await open(file.absolute, flags);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== file.stat.dev ||
          opened.ino !== file.stat.ino ||
          opened.size !== file.stat.size ||
          opened.mtimeMs !== file.stat.mtimeMs
        ) {
          throw new SkillHubServiceError("workspace skill changed during packaging", 409);
        }
        const markdown: Buffer[] = [];
        let fileBytes = 0;
        while (true) {
          const buffer = Buffer.allocUnsafe(64 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) {
            break;
          }
          const chunk = buffer.subarray(0, bytesRead);
          fileBytes += bytesRead;
          if (fileBytes > SKILL_HUB_UPLOAD_ENTRY_BYTES) {
            throw new SkillHubServiceError(
              "workspace skill exceeds the configured package limit",
              400,
            );
          }
          if (file.relative === "SKILL.md") {
            if (fileBytes > MAX_SKILL_MD_BYTES) {
              throw new SkillHubServiceError("SKILL.md exceeds the size limit", 400);
            }
            markdown.push(chunk);
          } else {
            countBytes(bytesRead);
            yield chunk;
          }
        }
        const after = await handle.stat();
        if (
          fileBytes !== opened.size ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.nlink !== 1
        ) {
          throw new SkillHubServiceError("workspace skill changed during packaging", 409);
        }
        if (file.relative === "SKILL.md") {
          const metadata = parseSkillMarkdown(
            Buffer.concat(markdown, fileBytes).toString("utf8"),
            skill,
            version,
          );
          const bytes = Buffer.from(metadata.source, "utf8");
          if (bytes.byteLength > MAX_SKILL_MD_BYTES) {
            throw new SkillHubServiceError("SKILL.md exceeds the size limit", 400);
          }
          summary = metadata.description;
          countBytes(bytes.byteLength);
          yield bytes;
        }
      } finally {
        await handle.close();
      }
    };
    const directory = await mkdtemp(path.join(tmpdir(), `platformclaw-skill-hub-${skill}-`));
    const archivePath = path.join(directory, "archive.zip");
    const sources: Readable[] = [];
    let size = 0;
    try {
      const zip = new JSZip();
      for (const file of files) {
        // JSZip pauses each input until its turn. Lazy generators keep source
        // descriptors and memory bounded, including when output exceeds its cap.
        const source = Readable.from(readSource(file), {
          objectMode: false,
          highWaterMark: 64 * 1024,
        });
        sources.push(source);
        zip.file(file.relative, source, {
          binary: true,
          createFolders: false,
          date: new Date("1980-01-01T00:00:00.000Z"),
          unixPermissions: file.stat.mode & 0o777,
        });
      }
      const archiveLimit = Math.min(this.options.maxPackageBytes, SKILL_HUB_UPLOAD_ARCHIVE_BYTES);
      const limiter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.byteLength;
          callback(
            size > archiveLimit
              ? new SkillHubServiceError(
                  "workspace skill ZIP exceeds the configured package limit",
                  400,
                )
              : null,
            chunk,
          );
        },
      });
      // JSZip's paused input adapter can retain a source error without forwarding
      // it. Destroying the native limiter makes read failures terminate the pipeline.
      for (const source of sources) {
        source.once("error", (error) => limiter.destroy(error));
      }
      await pipeline(
        zip.generateNodeStream({ streamFiles: true, compression: "DEFLATE", platform: "UNIX" }),
        limiter,
        createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
      );
      if (summary === undefined) {
        throw new SkillHubServiceError("workspace skill is missing SKILL.md", 400);
      }
      return {
        path: archivePath,
        size,
        summary,
        cleanup: async () => await rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      // JSZip's legacy output stream does not own its input descriptors.
      await Promise.all(
        sources.map(async (source) => {
          source.destroy();
          await finished(source).catch(() => undefined);
        }),
      );
    }
  }

  protected async adapterCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SkillHubServiceError) {
        throw error;
      }
      if (error instanceof SkillHubAdapterError || error instanceof SkillHubGovernanceError) {
        const status =
          error.statusCode === 403
            ? 403
            : error.statusCode === 404
              ? 404
              : error.statusCode === 409
                ? 409
                : 502;
        throw new SkillHubServiceError(error.message, status);
      }
      throw new SkillHubServiceError("Skill Hub operation failed", 502);
    }
  }

  protected async gatewayCall<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.options.adminRpc.call<T>(method, params);
    } catch (error) {
      if (error instanceof GatewayAdminRpcError) {
        throw new SkillHubServiceError(
          error.message,
          error.code === "INVALID_REQUEST" || error.code === "ALREADY_EXISTS" ? 409 : 503,
        );
      }
      throw new SkillHubServiceError("Gateway skill installation failed", 503);
    }
  }

  protected async audit(
    actorUserId: string | undefined,
    eventType: string,
    targetId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.options.store.recordAuditEvent({
      ...(actorUserId ? { actorUserId } : {}),
      eventType,
      targetType: "skill-hub-skill",
      targetId,
      details,
      createdAt: (this.options.now ?? Date.now)(),
    });
  }
}
