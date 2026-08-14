import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import JSZip, { type JSZipObject } from "jszip";
import { isMap, parseDocument } from "yaml";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type { ControlPlaneAuditWriter, ControlPlaneStore, PlatformUser } from "./contracts.js";
import { GatewayAdminRpcError, type GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import {
  SkillHubAdapterError,
  type SkillHubAdapter,
  type SkillHubVisibility,
} from "./skill-hub-adapter.js";

const SKILL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_MD_BYTES = 256 * 1024;
const UPLOAD_CHUNK_BYTES = 512 * 1024;

type SkillHubStore = ControlPlaneStore & ControlPlaneAuditWriter;

export class SkillHubServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "SkillHubServiceError";
  }
}

type SkillHubServiceOptions = {
  authService: BrowserAuthService;
  store: SkillHubStore;
  adapter: SkillHubAdapter;
  adminRpc: GatewayAdminRpc;
  workspaceRoot: string;
  allowedNamespaces: readonly string[];
  namespaceAccessGroups?: Readonly<Record<string, string>>;
  maxPackageBytes: number;
  now?: () => number;
};

type AuthenticatedWorkspace = { user: PlatformUser; agentId: string; workspaceDir: string };
type SkillInstallTarget = "platform_server" | "assigned_vm";

function safeName(raw: string, label: string, pattern: RegExp): string {
  const value = raw.trim().toLowerCase();
  if (!pattern.test(value) || value.includes("..")) {
    throw new SkillHubServiceError(`invalid ${label}`, 400);
  }
  return value;
}

function validVersion(raw: string): string {
  const value = raw.trim();
  if (!VERSION_PATTERN.test(value)) {
    throw new SkillHubServiceError("version must be valid SemVer", 400);
  }
  return value;
}

function validVisibility(raw: string): SkillHubVisibility {
  const value = raw.trim().toUpperCase();
  if (value !== "PUBLIC" && value !== "NAMESPACE_ONLY" && value !== "PRIVATE") {
    throw new SkillHubServiceError("invalid visibility", 400);
  }
  return value;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseSkillMarkdown(
  source: string,
  expectedName: string,
  version?: string,
): { source: string; version?: string } {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u.exec(source);
  if (!match) {
    throw new SkillHubServiceError("SKILL.md must contain YAML frontmatter", 400);
  }
  const document = parseDocument(match[1]!);
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new SkillHubServiceError("SKILL.md contains invalid YAML frontmatter", 400);
  }
  const name = document.get("name");
  const description = document.get("description");
  if (typeof name !== "string" || name.trim().toLowerCase() !== expectedName) {
    throw new SkillHubServiceError("SKILL.md name must match the workspace skill directory", 400);
  }
  if (typeof description !== "string" || !description.trim()) {
    throw new SkillHubServiceError("SKILL.md description is required", 400);
  }
  const declaredVersion = document.get("version");
  if (declaredVersion !== undefined && typeof declaredVersion !== "string") {
    throw new SkillHubServiceError("SKILL.md version must be a string", 400);
  }
  if (version) {
    document.set("version", version);
  }
  return {
    source: `---\n${document.toString().trimEnd()}\n---\n${match[2]}`,
    ...(version === undefined && declaredVersion !== undefined
      ? { version: declaredVersion.trim() }
      : {}),
  };
}

function zipEntryPath(entry: JSZipObject): string {
  const original = entry.unsafeOriginalName ?? entry.name;
  const normalized = entry.dir && original.endsWith("/") ? original.slice(0, -1) : original;
  if (
    original !== entry.name ||
    !normalized ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.includes(":") ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new SkillHubServiceError("Skill Hub archive contains an unsafe path", 400);
  }
  return original;
}

function isZipSymlink(entry: JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  return typeof permissions === "number" && (permissions & 0o170000) === 0o120000;
}

async function readZipEntryBounded(
  entry: JSZipObject,
  extracted: { bytes: number },
  maxPackageBytes: number,
): Promise<Buffer | undefined> {
  const retain = entry.name === "SKILL.md";
  return await new Promise<Buffer | undefined>((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & {
      destroy(): void;
    };
    const chunks: Buffer[] = [];
    let entryBytes = 0;
    let settled = false;
    const fail = (error: SkillHubServiceError): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.pause();
      stream.destroy();
      reject(error);
    };
    stream.on("data", (rawChunk: Buffer | string) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      entryBytes += chunk.byteLength;
      extracted.bytes += chunk.byteLength;
      if (extracted.bytes > maxPackageBytes || (retain && entryBytes > MAX_SKILL_MD_BYTES)) {
        fail(
          new SkillHubServiceError(
            retain
              ? "Skill Hub archive is missing a valid SKILL.md"
              : "Skill Hub archive expands past the configured size limit",
            400,
          ),
        );
        return;
      }
      if (retain) {
        chunks.push(chunk);
      }
    });
    stream.once("error", () => {
      fail(new SkillHubServiceError("Skill Hub returned an invalid ZIP archive", 400));
    });
    stream.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(retain ? Buffer.concat(chunks, entryBytes) : undefined);
    });
  });
}

async function validateDownloadedArchive(
  archive: Buffer,
  expectedSlug: string,
  expectedVersion: string,
  maxPackageBytes: number,
): Promise<void> {
  if (archive.byteLength === 0 || archive.byteLength > maxPackageBytes) {
    throw new SkillHubServiceError("Skill Hub archive exceeds the configured size limit", 400);
  }
  let zip: JSZip;
  try {
    // Read central-directory metadata first. CRC verification would inflate every entry before
    // the expansion limit is checked, turning a validation step into a zip-bomb allocation.
    zip = await JSZip.loadAsync(archive, { createFolders: false });
  } catch {
    throw new SkillHubServiceError("Skill Hub returned an invalid ZIP archive", 400);
  }
  const entries = Object.values(zip.files);
  if (entries.length === 0 || entries.length > MAX_SKILL_FILES) {
    throw new SkillHubServiceError("Skill Hub archive contains too many files", 400);
  }
  const extracted = { bytes: 0 };
  let skillMarkdown: Buffer | undefined;
  for (const entry of entries) {
    zipEntryPath(entry);
    if (isZipSymlink(entry)) {
      throw new SkillHubServiceError("Skill Hub archive contains a symbolic link", 400);
    }
    if (entry.dir) {
      continue;
    }
    const content = await readZipEntryBounded(entry, extracted, maxPackageBytes);
    if (content) {
      skillMarkdown = content;
    }
  }
  if (!skillMarkdown) {
    throw new SkillHubServiceError("Skill Hub archive is missing a valid SKILL.md", 400);
  }
  const metadata = parseSkillMarkdown(skillMarkdown.toString("utf8"), expectedSlug);
  if (metadata.version !== expectedVersion) {
    throw new SkillHubServiceError("SKILL.md version does not match the requested version", 400);
  }
}

export class SkillHubService {
  private readonly workspaceRoot: string;
  private readonly namespaces: ReadonlySet<string>;
  private readonly namespaceAccessGroups: ReadonlyMap<string, string>;

  constructor(private readonly options: SkillHubServiceOptions) {
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

  async authenticate(token: string): Promise<AuthenticatedWorkspace | null> {
    const auth = await this.options.authService.authenticateToken(token);
    if (auth.status !== "active") {
      return null;
    }
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

  config(user: PlatformUser) {
    return {
      namespaces: [...this.namespaces]
        .filter((namespace) => this.canPublish(user, namespace))
        .toSorted(),
      maxPackageBytes: this.options.maxPackageBytes,
    };
  }

  async search(user: PlatformUser, query: string, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new SkillHubServiceError("limit must be between 1 and 50", 400);
    }
    const result = await this.adapterCall(() => this.options.adapter.search(query.trim(), limit));
    const items = result.items.filter(
      (item) =>
        this.namespaces.has(item.namespace.toLowerCase()) &&
        this.canAccessVisibility(user, item.namespace.toLowerCase(), item.visibility),
    );
    return { items, total: items.length };
  }

  async detail(user: PlatformUser, namespaceRaw: string, slugRaw: string) {
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const skill = await this.adapterCall(() => this.options.adapter.getSkill(namespace, slug));
    this.validateSkillIdentity(skill.namespace, skill.slug, namespace, slug);
    this.authorizeVisibility(user, namespace, skill.visibility);
    const versions = await this.adapterCall(() =>
      this.options.adapter.listVersions(namespace, slug),
    );
    return { skill, versions };
  }

  async publish(
    actor: AuthenticatedWorkspace,
    params: { skill: string; namespace: string; version: string; visibility: string },
  ) {
    const execution = await this.resolveExecutionTarget(actor.agentId);
    if (execution.activeTarget !== "platform_server") {
      throw new SkillHubServiceError(
        "Switch to the Basic workspace before publishing a workspace skill.",
        409,
      );
    }
    const skill = safeName(params.skill, "skill", SKILL_KEY_PATTERN);
    const namespace = this.authorizePublishNamespace(actor.user, params.namespace);
    const version = validVersion(params.version);
    const visibility = validVisibility(params.visibility);
    const archive = await this.packageWorkspaceSkill(actor.workspaceDir, skill, version);
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
    await this.audit(actor.user.id, "skill-hub.publish", `${namespace}/${skill}@${version}`, {
      visibility,
      archiveBytes: archive.byteLength,
    });
    return result;
  }

  async install(
    actor: AuthenticatedWorkspace,
    params: {
      namespace: string;
      slug: string;
      version: string;
      expectedTarget: SkillInstallTarget;
    },
  ) {
    const execution = await this.resolveExecutionTarget(actor.agentId);
    if (params.expectedTarget !== execution.activeTarget) {
      throw new SkillHubServiceError("Execution target changed; reload and retry.", 409);
    }
    const namespace = this.authorizeNamespace(params.namespace);
    const slug = safeName(params.slug, "skill slug", SKILL_KEY_PATTERN);
    const version = validVersion(params.version);
    const detail = await this.adapterCall(() => this.options.adapter.getSkill(namespace, slug));
    this.validateSkillIdentity(detail.namespace, detail.slug, namespace, slug);
    this.authorizeVisibility(actor.user, namespace, detail.visibility);
    const archive = await this.adapterCall(() =>
      this.options.adapter.download(namespace, slug, version),
    );
    await validateDownloadedArchive(archive, slug, version, this.options.maxPackageBytes);
    const sha256 = createHash("sha256").update(archive).digest("hex");
    const begin = await this.gatewayCall<{ uploadId: string }>("skills.upload.begin", {
      kind: "skill-archive",
      slug,
      sizeBytes: archive.byteLength,
      sha256,
      force: false,
      idempotencyKey: `skill-hub:${namespace}/${slug}@${version}:${sha256}`,
    });
    if (!begin?.uploadId) {
      throw new SkillHubServiceError("Gateway returned an invalid upload session", 503);
    }
    for (let offset = 0; offset < archive.byteLength; offset += UPLOAD_CHUNK_BYTES) {
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
    const result = await this.gatewayCall<Record<string, unknown>>("skills.install", {
      agentId: actor.agentId,
      source: "upload",
      uploadId: begin.uploadId,
      slug,
      force: false,
      sha256,
      destination: "sandbox-backend",
      expectedTargetRevision: execution.targetRevision,
    });
    if (result.ok !== true || result.slug !== slug) {
      throw new SkillHubServiceError("Gateway returned an invalid install result", 503);
    }
    await this.audit(actor.user.id, "skill-hub.install", `${namespace}/${slug}@${version}`, {
      agentId: actor.agentId,
      sha256,
    });
    return {
      ok: true,
      slug,
      version,
      target: execution.activeTarget,
    };
  }

  private async resolveExecutionTarget(agentId: string): Promise<{
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

  private authorizeNamespace(raw: string): string {
    const namespace = safeName(raw, "namespace", NAMESPACE_PATTERN);
    if (!this.namespaces.has(namespace)) {
      throw new SkillHubServiceError(
        "publishing or installing from this namespace is not allowed",
        403,
      );
    }
    return namespace;
  }

  private authorizePublishNamespace(user: PlatformUser, raw: string): string {
    const namespace = this.authorizeNamespace(raw);
    if (!this.canPublish(user, namespace)) {
      throw new SkillHubServiceError("publishing to this namespace is not allowed", 403);
    }
    return namespace;
  }

  private canPublish(user: PlatformUser, namespace: string): boolean {
    if (user.globalRole === "admin") {
      return true;
    }
    const requiredGroup = this.namespaceAccessGroups.get(namespace);
    return (
      requiredGroup === "*" ||
      (requiredGroup !== undefined &&
        user.groups.some((group) => group.trim().toLowerCase() === requiredGroup))
    );
  }

  private canAccessVisibility(
    user: PlatformUser,
    namespace: string,
    visibility: SkillHubVisibility,
  ): boolean {
    return visibility === "PUBLIC" || this.canPublish(user, namespace);
  }

  private authorizeVisibility(
    user: PlatformUser,
    namespace: string,
    visibility: SkillHubVisibility,
  ): void {
    if (!this.canAccessVisibility(user, namespace, visibility)) {
      throw new SkillHubServiceError("this Skill Hub skill is not available to this user", 403);
    }
  }

  private validateSkillIdentity(
    actualNamespace: string,
    actualSlug: string,
    expectedNamespace: string,
    expectedSlug: string,
  ): void {
    if (actualNamespace !== expectedNamespace || actualSlug !== expectedSlug) {
      throw new SkillHubServiceError("Skill Hub returned mismatched skill details", 502);
    }
  }

  private async packageWorkspaceSkill(
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
        if (!stat.isFile()) {
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
          if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino) {
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

  private async adapterCall<T>(operation: () => Promise<T>): Promise<T> {
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

  private async gatewayCall<T>(method: string, params: unknown): Promise<T> {
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

  private async audit(
    actorUserId: string,
    eventType: string,
    targetId: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.options.store.recordAuditEvent({
      actorUserId,
      eventType,
      targetType: "skill-hub-skill",
      targetId,
      details,
      createdAt: (this.options.now ?? Date.now)(),
    });
  }
}
