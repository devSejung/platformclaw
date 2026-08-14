import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { PlatformUser } from "./contracts.js";
import { GatewayAdminRpcError } from "./gateway-admin-rpc-client.js";
import {
  SkillHubAdapterError,
  type SkillHubAdapter,
  type SkillHubVisibility,
} from "./skill-hub-adapter.js";
import {
  isInside,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  NAMESPACE_PATTERN,
  parseSkillMarkdown,
  safeName,
  SKILL_KEY_PATTERN,
  SkillHubServiceError,
  type SkillHubServiceOptions,
  type SkillInstallTarget,
} from "./skill-hub-service-support.js";
import type { SkillHubGovernanceJob } from "./skill-hub-state.js";

export abstract class SkillHubServiceBase {
  protected readonly workspaceRoot: string;
  protected readonly namespaces: ReadonlySet<string>;
  protected readonly namespaceAccessGroups: ReadonlyMap<string, string>;
  protected governanceProcessing = false;
  protected governanceTimer?: NodeJS.Timeout;
  protected governanceClosed = false;

  protected abstract processGovernanceQueue(): Promise<{ processed: number }>;

  constructor(protected readonly options: SkillHubServiceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.namespaces = new Set(
      options.allowedNamespaces.map((value) => safeName(value, "namespace", NAMESPACE_PATTERN)),
    );
    this.namespaceAccessGroups = new Map(
      [...this.namespaces].map((namespace) => {
        const configuredGroup = options.namespaceAccessGroups?.[namespace]?.trim().toLowerCase();
        return [namespace, configuredGroup || namespace] as const;
      }),
    );
    if (this.namespaces.size === 0) {
      throw new Error("Skill Hub requires at least one allowed namespace");
    }
    if (!Number.isSafeInteger(options.maxPackageBytes) || options.maxPackageBytes <= 0) {
      throw new Error("Skill Hub package limit must be a positive integer");
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
  ): Promise<{ targetRevision: number }> {
    const profile = await this.options.store.getPersonalExecutionProfile(agentId);
    if (!profile) {
      if (destination === "platform_server") {
        return { targetRevision: 0 };
      }
      throw new SkillHubServiceError("My VM workspace is not assigned.", 409);
    }
    if (destination === "assigned_vm") {
      const allocation = await this.options.store.getVmAllocationForAgent(agentId);
      if (allocation?.status !== "ready" || !allocation.remoteWorkspaceDir) {
        throw new SkillHubServiceError("My VM workspace is not ready.", 409);
      }
    }
    return { targetRevision: profile.targetRevision };
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
      throw new SkillHubServiceError("Assigned VM target is unavailable; reload and retry.", 409);
    }
    return { activeTarget: profile.activeTarget, targetRevision: profile.targetRevision };
  }

  protected authorizeNamespace(raw: string): string {
    const namespace = safeName(raw, "namespace", NAMESPACE_PATTERN);
    if (!this.namespaces.has(namespace)) {
      throw new SkillHubServiceError(
        "publishing or installing from this namespace is not allowed",
        403,
      );
    }
    return namespace;
  }

  protected async authorizePublishNamespace(user: PlatformUser, raw: string): Promise<string> {
    const namespace = this.authorizeNamespace(raw);
    if (!(await this.canPublish(user, namespace))) {
      throw new SkillHubServiceError("publishing to this namespace is not allowed", 403);
    }
    return namespace;
  }

  protected async canPublish(user: PlatformUser, namespace: string): Promise<boolean> {
    if (user.globalRole === "admin") {
      return true;
    }
    const binding = await this.options.store.getSkillHubNamespaceBinding(namespace);
    if (binding) {
      return await this.options.store.hasSkillHubNamespaceAccess(user.id, binding);
    }
    const requiredGroup = this.namespaceAccessGroups.get(namespace);
    const allowed =
      requiredGroup === "*" ||
      (requiredGroup !== undefined &&
        user.groups.some((group) => group.trim().toLowerCase() === requiredGroup));
    return allowed;
  }

  protected async canAccessSkill(
    user: PlatformUser,
    namespace: string,
    slug: string,
    visibility: SkillHubVisibility,
    version?: string,
  ): Promise<boolean> {
    if (visibility === "PUBLIC" || user.globalRole === "admin") {
      return true;
    }
    const ownership = await this.options.store.getSkillHubOwnership(namespace, slug);
    if (ownership?.ownerUserId === user.id) {
      return true;
    }
    if (visibility === "NAMESPACE_ONLY" && (await this.canPublish(user, namespace))) {
      return true;
    }
    return await this.options.store.hasSkillHubAccess({
      namespace,
      slug,
      userId: user.id,
      ...(version ? { version } : {}),
      now: this.now(),
    });
  }

  protected async authorizeSkillAccess(
    user: PlatformUser,
    namespace: string,
    slug: string,
    visibility: SkillHubVisibility,
    version?: string,
  ): Promise<void> {
    if (!(await this.canAccessSkill(user, namespace, slug, visibility, version))) {
      throw new SkillHubServiceError("this Skill Hub skill is not available to this user", 403);
    }
  }

  protected async authorizeExistingSkillMutation(
    user: PlatformUser,
    namespace: string,
    slug: string,
  ): Promise<void> {
    await this.reconcileOwners();
    const ownership = await this.options.store.getSkillHubOwnership(namespace, slug);
    if (ownership && user.globalRole !== "admin" && ownership.ownerUserId !== user.id) {
      throw new SkillHubServiceError("Skill Hub skill owner or administrator required", 403);
    }
  }

  protected async authorizeVisibilityCeiling(
    namespace: string,
    visibility: SkillHubVisibility,
  ): Promise<void> {
    const binding = await this.options.store.getSkillHubNamespaceBinding(namespace);
    if (!binding) {
      return;
    }
    const rank: Record<SkillHubVisibility, number> = {
      PRIVATE: 0,
      NAMESPACE_ONLY: 1,
      PUBLIC: 2,
    };
    if (rank[visibility] > rank[binding.visibilityCeiling]) {
      throw new SkillHubServiceError(
        `visibility exceeds the ${binding.visibilityCeiling} namespace ceiling`,
        403,
      );
    }
  }

  protected async auditLegacyNamespaceAuthorization(
    user: PlatformUser,
    namespace: string,
  ): Promise<void> {
    if (
      user.globalRole === "admin" ||
      (await this.options.store.getSkillHubNamespaceBinding(namespace))
    ) {
      return;
    }
    await this.audit(user.id, "skill-hub.namespace.legacy-authorized", namespace, {
      directoryGroup: this.namespaceAccessGroups.get(namespace),
      migrationRequired: true,
    });
  }

  protected async requireManagedSkill(actor: PlatformUser, namespaceRaw: string, slugRaw: string) {
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    await this.reconcileOwners();
    const ownership = await this.options.store.getSkillHubOwnership(namespace, slug);
    if (!ownership) {
      throw new SkillHubServiceError("Skill Hub ownership is not registered", 404);
    }
    if (actor.globalRole !== "admin" && ownership.ownerUserId !== actor.id) {
      throw new SkillHubServiceError("Skill Hub skill owner or administrator required", 403);
    }
    return { namespace, slug, ownership };
  }

  protected async reconcileOwners(): Promise<void> {
    await this.options.store.reconcileInactiveSkillHubOwners(
      this.now(),
      this.options.primaryAdminUserId?.trim() || undefined,
    );
  }

  protected async enqueueGovernance(
    ownerUserId: string,
    namespace: string,
    slug: string,
    version: string,
    visibility: SkillHubVisibility,
  ): Promise<void> {
    if (!this.options.governance || visibility === "PRIVATE") {
      return;
    }
    await this.options.store.enqueueSkillHubGovernanceJob({
      namespace,
      slug,
      version,
      ownerUserId,
      createdAt: this.now(),
    });
    this.triggerGovernanceProcessing();
  }

  protected triggerGovernanceProcessing(delayMs = 1_000): void {
    if (!this.options.governance || this.governanceClosed || this.governanceTimer) {
      return;
    }
    this.governanceTimer = setTimeout(() => {
      this.governanceTimer = undefined;
      void this.processGovernanceQueue().catch(() => undefined);
    }, delayMs);
    this.governanceTimer.unref();
  }

  protected async retryGovernanceJob(
    job: SkillHubGovernanceJob,
    attempts: number,
    lastError: string,
  ): Promise<void> {
    const terminal = attempts >= 20;
    await this.options.store.updateSkillHubGovernanceJob({
      namespace: job.namespace,
      slug: job.slug,
      version: job.version,
      state: terminal ? "failed" : "pending",
      attempts,
      nextAttemptAt: this.now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6)),
      lastError,
      updatedAt: this.now(),
    });
  }

  protected async finishGovernanceJob(
    job: SkillHubGovernanceJob,
    state: "approved" | "blocked",
    attempts: number,
    lastError?: string,
  ): Promise<void> {
    await this.options.store.updateSkillHubGovernanceJob({
      namespace: job.namespace,
      slug: job.slug,
      version: job.version,
      state,
      attempts,
      nextAttemptAt: this.now(),
      ...(lastError ? { lastError } : {}),
      updatedAt: this.now(),
    });
  }

  protected now(): number {
    return (this.options.now ?? Date.now)();
  }

  protected projectScanner(
    version: string | undefined,
    audits: Awaited<ReturnType<SkillHubAdapter["listSecurityAudits"]>>,
  ) {
    if (!version) {
      return { status: "not_available", badge: "Not scanned", current: true } as const;
    }
    if (audits.length === 0) {
      return { version, status: "pending", badge: "Scan pending", current: true } as const;
    }
    const pending = audits.some((audit) =>
      ["PENDING", "SCANNING"].includes(audit.verdict.toUpperCase()),
    );
    const unsafe = !pending && audits.some((audit) => audit.isSafe !== true);
    return {
      version,
      status: pending ? "pending" : unsafe ? "failed" : "passed",
      badge: pending ? "Scan pending" : unsafe ? "Issues found" : "Scan passed",
      current: true,
      audits,
    };
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

  protected async packageWorkspaceSkill(
    workspaceDir: string,
    skill: string,
    version: string,
  ): Promise<Buffer> {
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
    const zip = new JSZip();
    const pending = [skillDir];
    let fileCount = 0;
    let totalBytes = 0;
    let sawSkillMarkdown = false;
    while (pending.length > 0) {
      const current = pending.pop()!;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        const stat = await lstat(absolute);
        if (stat.isSymbolicLink()) {
          throw new SkillHubServiceError("workspace skill contains a symbolic link", 400);
        }
        const canonical = await realpath(absolute);
        if (!isInside(realRoot, canonical)) {
          throw new SkillHubServiceError("workspace skill contains an escaping path", 400);
        }
        if (stat.isDirectory()) {
          pending.push(absolute);
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1) {
          throw new SkillHubServiceError("workspace skill contains an unsupported file", 400);
        }
        fileCount += 1;
        if (fileCount > MAX_SKILL_FILES || stat.size > this.options.maxPackageBytes) {
          throw new SkillHubServiceError(
            "workspace skill exceeds the configured package limit",
            400,
          );
        }
        const relative = path.relative(skillDir, absolute).split(path.sep).join("/");
        const flags =
          process.platform === "win32"
            ? fsConstants.O_RDONLY
            : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
        const handle = await open(absolute, flags);
        let bytes: Buffer;
        try {
          const openedStat = await handle.stat();
          if (
            !openedStat.isFile() ||
            openedStat.nlink !== 1 ||
            openedStat.dev !== stat.dev ||
            openedStat.ino !== stat.ino
          ) {
            throw new SkillHubServiceError("workspace skill changed during packaging", 409);
          }
          bytes = await handle.readFile();
        } finally {
          await handle.close();
        }
        if (relative === "SKILL.md") {
          if (bytes.byteLength > MAX_SKILL_MD_BYTES) {
            throw new SkillHubServiceError("SKILL.md exceeds the size limit", 400);
          }
          bytes = Buffer.from(
            parseSkillMarkdown(bytes.toString("utf8"), skill, version).source,
            "utf8",
          );
          sawSkillMarkdown = true;
        }
        totalBytes += bytes.byteLength;
        if (totalBytes > this.options.maxPackageBytes) {
          throw new SkillHubServiceError(
            "workspace skill exceeds the configured package limit",
            400,
          );
        }
        zip.file(relative, bytes, { binary: true, unixPermissions: stat.mode & 0o777 });
      }
    }
    if (!sawSkillMarkdown) {
      throw new SkillHubServiceError("workspace skill is missing SKILL.md", 400);
    }
    const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    if (archive.byteLength > this.options.maxPackageBytes) {
      throw new SkillHubServiceError(
        "workspace skill ZIP exceeds the configured package limit",
        400,
      );
    }
    return archive;
  }

  protected async adapterCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SkillHubServiceError) {
        throw error;
      }
      if (error instanceof SkillHubAdapterError) {
        const status = error.statusCode === 403 ? 403 : error.statusCode === 404 ? 404 : 502;
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
