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
  publishNamespaceGroups?: Readonly<Record<string, string>>;
  maxPackageBytes: number;
  now?: () => number;
};

type AuthenticatedWorkspace = { user: PlatformUser; agentId: string; workspaceDir: string };

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

function parseSkillMarkdown(source: string, expectedName: string, version?: string): string {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/u.exec(source);
  if (!match) {
    throw new SkillHubServiceError("SKILL.md must contain YAML frontmatter", 400);
  }
  const document = parseDocument(match[1]);
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
  if (version) {
    document.set("version", version);
  }
  return `---\n${document.toString().trimEnd()}\n---\n${match[2]}`;
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

function zipEntrySize(entry: JSZipObject): number {
  const internal = entry as JSZipObject & { _data?: { uncompressedSize?: unknown } };
  const value = internal._data?.uncompressedSize;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SkillHubServiceError("Skill Hub archive contains invalid size metadata", 400);
  }
  return value;
}

function isZipSymlink(entry: JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  return typeof permissions === "number" && (permissions & 0o170000) === 0o120000;
}

async function validateDownloadedArchive(
  archive: Buffer,
  expectedSlug: string,
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
  let extractedBytes = 0;
  for (const entry of entries) {
    zipEntryPath(entry);
    if (isZipSymlink(entry)) {
      throw new SkillHubServiceError("Skill Hub archive contains a symbolic link", 400);
    }
    if (!entry.dir) {
      extractedBytes += zipEntrySize(entry);
      if (extractedBytes > maxPackageBytes) {
        throw new SkillHubServiceError(
          "Skill Hub archive expands past the configured size limit",
          400,
        );
      }
    }
  }
  const skillMarkdown = zip.file("SKILL.md");
  if (!skillMarkdown || zipEntrySize(skillMarkdown) > MAX_SKILL_MD_BYTES) {
    throw new SkillHubServiceError("Skill Hub archive is missing a valid SKILL.md", 400);
  }
  parseSkillMarkdown(await skillMarkdown.async("string"), expectedSlug);
}

export class SkillHubService {
  private readonly workspaceRoot: string;
  private readonly namespaces: ReadonlySet<string>;
  private readonly publishNamespaceGroups: ReadonlyMap<string, string>;

  constructor(private readonly options: SkillHubServiceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.namespaces = new Set(
      options.allowedNamespaces.map((value) => safeName(value, "namespace", NAMESPACE_PATTERN)),
    );
    this.publishNamespaceGroups = new Map(
      [...this.namespaces].map((namespace) => {
        const configuredGroup = options.publishNamespaceGroups?.[namespace]?.trim().toLowerCase();
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

  async search(query: string, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new SkillHubServiceError("limit must be between 1 and 50", 400);
    }
    const result = await this.adapterCall(() => this.options.adapter.search(query.trim(), limit));
    const items = result.items.filter((item) => this.namespaces.has(item.namespace.toLowerCase()));
    return { items, total: items.length };
  }

  async detail(namespaceRaw: string, slugRaw: string) {
    const namespace = this.authorizeNamespace(namespaceRaw);
    const slug = safeName(slugRaw, "skill slug", SKILL_KEY_PATTERN);
    const [skill, versions] = await Promise.all([
      this.adapterCall(() => this.options.adapter.getSkill(namespace, slug)),
      this.adapterCall(() => this.options.adapter.listVersions(namespace, slug)),
    ]);
    return { skill, versions };
  }

  async publish(
    actor: AuthenticatedWorkspace,
    params: { skill: string; namespace: string; version: string; visibility: string },
  ) {
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
    await this.audit(actor.user.id, "skill-hub.publish", `${namespace}/${skill}@${version}`, {
      visibility,
      archiveBytes: archive.byteLength,
    });
    return result;
  }

  async install(
    actor: AuthenticatedWorkspace,
    params: { namespace: string; slug: string; version: string },
  ) {
    const namespace = this.authorizeNamespace(params.namespace);
    const slug = safeName(params.slug, "skill slug", SKILL_KEY_PATTERN);
    const version = validVersion(params.version);
    const archive = await this.adapterCall(() =>
      this.options.adapter.download(namespace, slug, version),
    );
    await validateDownloadedArchive(archive, slug, this.options.maxPackageBytes);
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
    });
    await this.audit(actor.user.id, "skill-hub.install", `${namespace}/${slug}@${version}`, {
      agentId: actor.agentId,
      sha256,
    });
    return result;
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
    const requiredGroup = this.publishNamespaceGroups.get(namespace);
    return (
      requiredGroup === "*" ||
      (requiredGroup !== undefined &&
        user.groups.some((group) => group.trim().toLowerCase() === requiredGroup))
    );
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
          bytes = Buffer.from(parseSkillMarkdown(bytes.toString("utf8"), skill, version), "utf8");
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
