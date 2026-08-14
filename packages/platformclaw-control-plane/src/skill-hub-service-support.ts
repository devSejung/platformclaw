import path from "node:path";
import JSZip, { type JSZipObject } from "jszip";
import { isMap, parseDocument } from "yaml";
import type { BrowserAuthService } from "./browser-auth-service.js";
import type {
  ControlPlaneAuditWriter,
  ControlPlaneManagementStore,
  ControlPlaneStore,
  PlatformUser,
} from "./contracts.js";
import type { ControlPlaneExecutionManagementStore } from "./execution-contracts.js";
import type { GatewayAdminRpc } from "./gateway-admin-rpc-client.js";
import type { SkillHubAdapter, SkillHubVisibility } from "./skill-hub-adapter.js";
import type { SkillHubGovernanceClient } from "./skill-hub-governance-client.js";
import type { SkillHubStateStore } from "./skill-hub-state.js";

export const SKILL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
export const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
export const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
export const MAX_SKILL_FILES = 256;
export const MAX_SKILL_MD_BYTES = 256 * 1024;
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export const SKILL_HUB_UPLOAD_ARCHIVE_BYTES = 500 * 1024 * 1024;
export const SKILL_HUB_UPLOAD_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const SKILL_HUB_UPLOAD_ENTRY_BYTES = 250 * 1024 * 1024;
export const SKILL_HUB_UPLOAD_FILES = 100;

export type SkillHubStore = ControlPlaneStore &
  ControlPlaneAuditWriter &
  SkillHubStateStore &
  Pick<ControlPlaneManagementStore, "listManagedScopes"> &
  Pick<ControlPlaneExecutionManagementStore, "getVmAllocationForAgent">;

export class SkillHubServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "SkillHubServiceError";
  }
}

export function isValidSemVer(value: string): boolean {
  if (!VERSION_PATTERN.test(value)) {
    return false;
  }
  const withoutBuild = value.split("+", 1)[0]!;
  const prereleaseOffset = withoutBuild.indexOf("-");
  if (prereleaseOffset === -1) {
    return true;
  }
  return withoutBuild
    .slice(prereleaseOffset + 1)
    .split(".")
    .every((identifier) => !/^0\d+$/u.test(identifier));
}

export function compareSemVer(left: string, right: string): number {
  const parse = (value: string) => {
    const match = VERSION_PATTERN.exec(value);
    if (!match || !isValidSemVer(value)) {
      return undefined;
    }
    const core = [Number(match[1]), Number(match[2]), Number(match[3])];
    const withoutBuild = value.split("+", 1)[0]!;
    const prereleaseOffset = withoutBuild.indexOf("-");
    const prerelease =
      prereleaseOffset === -1 ? [] : withoutBuild.slice(prereleaseOffset + 1).split(".");
    return { core, prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    throw new SkillHubServiceError("installed skill version is not valid SemVer", 409, {
      code: "installed-version-unavailable",
    });
  }
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index]! < b.core[index]! ? -1 : 1;
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === bv) {
      continue;
    }
    if (av === undefined) {
      return -1;
    }
    if (bv === undefined) {
      return 1;
    }
    const an = /^\d+$/u.test(av) ? Number(av) : undefined;
    const bn = /^\d+$/u.test(bv) ? Number(bv) : undefined;
    if (an !== undefined && bn !== undefined) {
      return an < bn ? -1 : 1;
    }
    if (an !== undefined) {
      return -1;
    }
    if (bn !== undefined) {
      return 1;
    }
    return av < bv ? -1 : 1;
  }
  return 0;
}

export type SkillHubServiceOptions = {
  authService: BrowserAuthService;
  store: SkillHubStore;
  adapter: SkillHubAdapter;
  governance?: SkillHubGovernanceClient;
  adminRpc: GatewayAdminRpc;
  workspaceRoot: string;
  allowedNamespaces: readonly string[];
  namespaceAccessGroups?: Readonly<Record<string, string>>;
  maxPackageBytes: number;
  primaryAdminUserId?: string;
  now?: () => number;
};

export type AuthenticatedWorkspace = { user: PlatformUser; agentId: string; workspaceDir: string };
export type SkillInstallTarget = "platform_server" | "assigned_vm";

export function safeName(raw: string, label: string, pattern: RegExp): string {
  const value = raw.trim().toLowerCase();
  if (!pattern.test(value) || value.includes("..")) {
    throw new SkillHubServiceError(`invalid ${label}`, 400);
  }
  return value;
}

export function validVersion(raw: string): string {
  const value = raw.trim();
  if (!isValidSemVer(value)) {
    throw new SkillHubServiceError("version must be valid SemVer", 400);
  }
  return value;
}

export function validVisibility(raw: string): SkillHubVisibility {
  const value = raw.trim().toUpperCase();
  if (value !== "PUBLIC" && value !== "NAMESPACE_ONLY" && value !== "PRIVATE") {
    throw new SkillHubServiceError("invalid visibility", 400);
  }
  return value;
}

export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseSkillMarkdown(
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

export function zipEntryPath(entry: JSZipObject): string {
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

export function isZipSymlink(entry: JSZipObject): boolean {
  const permissions = entry.unixPermissions;
  return typeof permissions === "number" && (permissions & 0o170000) === 0o120000;
}

export async function readZipEntryBounded(
  entry: JSZipObject,
  extracted: { bytes: number },
  limits: { expandedBytes: number; entryBytes: number },
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
      if (
        extracted.bytes > limits.expandedBytes ||
        entryBytes > limits.entryBytes ||
        (retain && entryBytes > MAX_SKILL_MD_BYTES)
      ) {
        fail(
          new SkillHubServiceError(
            retain
              ? "Skill Hub archive is missing a valid SKILL.md"
              : entryBytes > limits.entryBytes
                ? "Skill Hub archive contains an oversized entry"
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

export async function validateDownloadedArchive(
  archive: Buffer,
  expectedSlug: string,
  expectedVersion: string,
  limits: { archiveBytes: number; expandedBytes: number; entryBytes: number; files: number },
): Promise<void> {
  if (archive.byteLength === 0 || archive.byteLength > limits.archiveBytes) {
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
  if (entries.length === 0 || entries.length > limits.files) {
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
    const content = await readZipEntryBounded(entry, extracted, limits);
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
