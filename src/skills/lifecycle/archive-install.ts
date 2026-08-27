// Archive install helpers extract and validate skill archives during installation.
import { lstat, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ArchiveExtractLimits, ArchiveLogger } from "../../infra/archive.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withExtractedArchiveRoot } from "../../infra/install-flow.js";
import { installPackageDir } from "../../infra/install-package-dir.js";
import { resolveSafeInstallDir } from "../../infra/install-safe-path.js";
import {
  evaluateSkillInstallPolicy,
  type InstallSecurityScanResult,
} from "../../plugins/install-security-scan.js";
import type { InstallPolicyOrigin, InstallPolicySource } from "../../security/install-policy.js";
import { computeSkillPromptVersion } from "../loading/skill-version.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  resolveCommittedSkillChangeSource,
  snapshotCommittedSkillArtifactBestEffort,
} from "./skill-change-hook.js";

const VALID_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
const DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS = ["SKILL.md"] as const;
/** Accepted root marker names for ClawHub skill archive uploads. */
export const CLAWHUB_SKILL_ARCHIVE_ROOT_MARKERS = [
  "SKILL.md",
  "skill.md",
  "skills.md",
  "SKILL.MD",
] as const;

function hasNonAscii(value: string): boolean {
  for (const char of value) {
    if (char.charCodeAt(0) > 0x7f) {
      return true;
    }
  }
  return false;
}

type SkillArchiveInstallPolicy = {
  config?: OpenClawConfig;
  installId?: string;
  origin: InstallPolicyOrigin;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
};

/** Backend-owned destination for an already extracted and policy-approved skill tree. */
export type SkillArchiveInstallTargetAccess = {
  install(params: {
    sourceDir: string;
    slug: string;
    mode: "install" | "update";
    timeoutMs: number;
    expectedSkillRevision?: string;
  }): Promise<{ targetDir: string }>;
  remove?(params: {
    slug: string;
    timeoutMs: number;
    expectedSkillRevision: string;
  }): Promise<{ targetDir: string }>;
};

/** Result shape for installing a skill archive into a workspace skills dir. */
type SkillArchiveInstallResult =
  | { ok: true; targetDir: string }
  | { ok: false; error: string; failureKind: SkillArchiveInstallFailureKind };

export type SkillArchiveInstallFailureKind = "invalid-request" | "unavailable";

/** Normalizes a tracked slug without accepting traversal or path separators. */
export function normalizeTrackedSkillSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug || slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function validateRequestedSkillSlug(raw: string): string {
  const slug = normalizeTrackedSkillSlug(raw);
  if (hasNonAscii(slug) || !VALID_SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid skill slug: ${raw}`);
  }
  return slug;
}

export function resolveWorkspaceSkillInstallDir(workspaceDir: string, slug: string): string {
  const skillsDir = path.join(path.resolve(workspaceDir), "skills");
  const target = resolveSafeInstallDir({
    baseDir: skillsDir,
    id: slug,
    invalidNameMessage: "invalid skill target path",
  });
  if (!target.ok) {
    throw new Error(target.error);
  }
  return target.path;
}

/** Removes one revision-pinned workspace skill without following links or deleting a changed tree. */
export async function removeWorkspaceSkill(params: {
  workspaceDir: string;
  slug: string;
  expectedSkillRevision: string;
  logger?: ArchiveLogger;
}): Promise<SkillArchiveInstallResult> {
  let targetDir: string;
  try {
    targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
    const stat = await lstat(targetDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return installFailure("skill is missing or invalid", "invalid-request");
    }
    const currentRevision = computeSkillPromptVersion(
      await readFile(path.join(targetDir, "SKILL.md"), "utf8"),
    );
    if (currentRevision !== params.expectedSkillRevision) {
      return installFailure("skill changed; reload and retry", "invalid-request");
    }
    const shouldDispatchChange = hasCommittedSkillChangeHooks();
    const before = shouldDispatchChange
      ? await snapshotCommittedSkillArtifactBestEffort({
          skillDir: targetDir,
          skillKey: params.slug,
          source: "upload",
          logger: params.logger,
        })
      : undefined;
    const stagedDir = path.join(
      path.dirname(targetDir),
      `.platformclaw-skill-remove-${params.slug}-${process.pid}-${Date.now()}`,
    );
    await rename(targetDir, stagedDir);
    try {
      const stagedRevision = computeSkillPromptVersion(
        await readFile(path.join(stagedDir, "SKILL.md"), "utf8"),
      );
      if (stagedRevision !== params.expectedSkillRevision) {
        await rename(stagedDir, targetDir);
        return installFailure("skill changed; reload and retry", "invalid-request");
      }
      await rm(stagedDir, { recursive: true, force: false });
    } catch (error) {
      await rename(stagedDir, targetDir).catch(() => undefined);
      throw error;
    }
    if (shouldDispatchChange) {
      await dispatchCommittedSkillChangeBestEffort({
        action: "removed",
        source: "upload",
        workspaceDir: params.workspaceDir,
        before,
        logger: params.logger,
      });
    }
    return { ok: true, targetDir };
  } catch (error) {
    return installFailure(formatErrorMessage(error), "unavailable");
  }
}

function installFailure(
  error: string,
  failureKind: SkillArchiveInstallFailureKind,
): SkillArchiveInstallResult {
  return { ok: false, error, failureKind };
}

async function hasSkillArchiveRoot(
  rootDir: string,
  rootMarkers: readonly string[],
): Promise<boolean> {
  for (const candidate of rootMarkers) {
    if (await pathExists(path.join(rootDir, candidate))) {
      return true;
    }
  }
  return false;
}

function scanBlockedFailureKind(
  blocked: NonNullable<InstallSecurityScanResult["blocked"]>,
): SkillArchiveInstallFailureKind {
  return blocked.code === "security_scan_failed" ? "unavailable" : "invalid-request";
}

const TRANSIENT_ARCHIVE_ERROR_PATTERNS = [
  "enoent",
  "enospc",
  "eio",
  "eacces",
  "eperm",
  "ebusy",
  "emfile",
  "enfile",
  "timeout",
  "timed out",
] as const;

function archiveFailureKind(error: string): SkillArchiveInstallFailureKind {
  const lower = error.toLowerCase();
  if (lower.startsWith("failed to install skill:")) {
    return "unavailable";
  }
  for (const pattern of TRANSIENT_ARCHIVE_ERROR_PATTERNS) {
    if (lower.includes(pattern)) {
      return "unavailable";
    }
  }
  return "invalid-request";
}

export async function installExtractedSkillRoot(params: {
  workspaceDir: string;
  slug: string;
  extractedRoot: string;
  mode: "install" | "update";
  timeoutMs?: number;
  logger?: ArchiveLogger;
  policy?: SkillArchiveInstallPolicy;
  rootMarkers?: readonly string[];
  targetAccess?: SkillArchiveInstallTargetAccess;
  expectedSkillRevision?: string;
}): Promise<SkillArchiveInstallResult> {
  try {
    if (
      !(await hasSkillArchiveRoot(
        params.extractedRoot,
        params.rootMarkers ?? DEFAULT_SKILL_ARCHIVE_ROOT_MARKERS,
      ))
    ) {
      return installFailure("archive is missing SKILL.md", "invalid-request");
    }
    let targetDir: string | undefined;
    let effectiveMode = params.mode;
    if (!params.targetAccess) {
      try {
        targetDir = resolveWorkspaceSkillInstallDir(params.workspaceDir, params.slug);
      } catch (err) {
        return installFailure(formatErrorMessage(err), "invalid-request");
      }
      const targetExists = await pathExists(targetDir);
      effectiveMode = params.mode === "update" && targetExists ? "update" : "install";
      if (params.mode === "install" && targetExists) {
        return installFailure(
          `Skill already exists at ${targetDir}. Re-run with force/update.`,
          "invalid-request",
        );
      }
    }
    const changeSource = resolveCommittedSkillChangeSource(params.policy?.origin.type);
    const sourceVersionValue =
      params.policy?.origin.version ?? params.policy?.origin.commit ?? undefined;
    const sourceVersion =
      typeof sourceVersionValue === "string" || typeof sourceVersionValue === "number"
        ? String(sourceVersionValue)
        : undefined;
    const shouldDispatchChange = hasCommittedSkillChangeHooks();
    const before =
      targetDir && shouldDispatchChange && effectiveMode === "update"
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: targetDir,
            skillKey: params.slug,
            source: changeSource,
            logger: params.logger,
          })
        : undefined;

    if (params.policy) {
      const scanResult = await evaluateSkillInstallPolicy({
        config: params.policy.config,
        installId: params.policy.installId ?? "archive",
        logger: params.logger ?? {},
        origin: params.policy.origin,
        requestedSpecifier: params.policy.requestedSpecifier,
        source: params.policy.source,
        mode: effectiveMode,
        skillName: params.slug,
        sourceDir: params.extractedRoot,
      });
      if (scanResult?.blocked) {
        return installFailure(
          scanResult.blocked.reason,
          scanBlockedFailureKind(scanResult.blocked),
        );
      }
    }

    if (params.targetAccess) {
      // The backend owns remote commit/catalog refresh; local artifact hooks cannot snapshot it.
      return {
        ok: true,
        ...(await params.targetAccess.install({
          sourceDir: params.extractedRoot,
          slug: params.slug,
          mode: effectiveMode,
          timeoutMs: params.timeoutMs ?? 120_000,
          ...(params.expectedSkillRevision
            ? { expectedSkillRevision: params.expectedSkillRevision }
            : {}),
        })),
      };
    }
    if (!targetDir) {
      return installFailure("skill install target is unavailable", "unavailable");
    }
    if (effectiveMode === "update" && params.expectedSkillRevision) {
      const currentRevision = computeSkillPromptVersion(
        await readFile(path.join(targetDir, "SKILL.md"), "utf8"),
      );
      if (currentRevision !== params.expectedSkillRevision) {
        return installFailure("skill changed; reload and retry", "invalid-request");
      }
    }

    const install = await installPackageDir({
      sourceDir: params.extractedRoot,
      targetDir,
      mode: effectiveMode,
      timeoutMs: params.timeoutMs ?? 120_000,
      logger: params.logger,
      copyErrorPrefix: "failed to install skill",
      hasDeps: false,
      depsLogMessage: "",
    });
    if (!install.ok) {
      return installFailure(install.error, "unavailable");
    }
    if (shouldDispatchChange) {
      const after = await snapshotCommittedSkillArtifactBestEffort({
        skillDir: targetDir,
        skillKey: params.slug,
        source: changeSource,
        sourceVersion,
        logger: params.logger,
      });
      await dispatchCommittedSkillChangeBestEffort({
        action: effectiveMode === "update" ? "updated" : "created",
        source: changeSource,
        workspaceDir: params.workspaceDir,
        before,
        after,
        logger: params.logger,
      });
    }
    return { ok: true, targetDir };
  } catch (err) {
    return installFailure(formatErrorMessage(err), "unavailable");
  }
}

export async function installSkillArchiveFromPath(params: {
  archivePath: string;
  workspaceDir: string;
  slug: string;
  force?: boolean;
  timeoutMs?: number;
  logger?: ArchiveLogger;
  archiveLimits?: ArchiveExtractLimits;
  policy?: SkillArchiveInstallPolicy;
  targetAccess?: SkillArchiveInstallTargetAccess;
  expectedSkillRevision?: string;
}): Promise<SkillArchiveInstallResult> {
  const result = await withExtractedArchiveRoot({
    archivePath: params.archivePath,
    tempDirPrefix: "openclaw-skill-archive-",
    timeoutMs: params.timeoutMs ?? 120_000,
    logger: params.logger,
    limits: params.archiveLimits,
    rootMarkers: ["SKILL.md"],
    onExtracted: async (rootDir) =>
      await installExtractedSkillRoot({
        workspaceDir: params.workspaceDir,
        slug: params.slug,
        extractedRoot: rootDir,
        mode: params.force ? "update" : "install",
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        policy: params.policy,
        targetAccess: params.targetAccess,
        ...(params.expectedSkillRevision
          ? { expectedSkillRevision: params.expectedSkillRevision }
          : {}),
      }),
  });
  if (!result.ok) {
    const error = result.error.includes("unexpected archive layout")
      ? "archive is missing SKILL.md"
      : result.error;
    const failureKind =
      "failureKind" in result &&
      (result.failureKind === "invalid-request" || result.failureKind === "unavailable")
        ? result.failureKind
        : archiveFailureKind(error);
    return installFailure(error, failureKind);
  }
  return result;
}
