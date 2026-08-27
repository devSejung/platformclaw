import path from "node:path";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type {
  SkillProposalRecord,
  SkillWorkshopTargetAccess,
  SkillWorkshopTargetFile,
} from "./types.js";

const MAX_TARGET_FILES = 2_000;
const MAX_TARGET_FILE_BYTES = 1024 * 1024;
const MAX_TARGET_TREE_BYTES = 8 * 1024 * 1024;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

export function skillWorkshopTargetBinding(access: SkillWorkshopTargetAccess) {
  return {
    backendId: access.backendId,
    targetId: access.targetId,
    targetLabel: access.targetLabel,
  };
}

export function assertSkillWorkshopTargetAccess(
  record: SkillProposalRecord,
  access: SkillWorkshopTargetAccess | undefined,
): void {
  const binding = record.target.binding;
  if (!binding) {
    if (access) {
      throw new Error(
        "This proposal belongs to the Basic workspace. Switch work location and retry.",
      );
    }
    return;
  }
  if (!access) {
    throw new Error(
      `This proposal belongs to ${binding.targetLabel}. Switch work location and retry.`,
    );
  }
  if (access.backendId !== binding.backendId || access.targetId !== binding.targetId) {
    throw new Error(
      `This proposal belongs to ${binding.targetLabel}, not the current execution target. Switch work location and retry.`,
    );
  }
}

export function resolveExternalSkillTarget(params: {
  access: SkillWorkshopTargetAccess;
  skillKey: string;
}): { skillDir: string; skillFile: string } {
  const skillDir = path.posix.join(params.access.skillsDir, params.skillKey);
  return { skillDir, skillFile: path.posix.join(skillDir, "SKILL.md") };
}

export async function readExternalSkillFile(
  access: SkillWorkshopTargetAccess,
  filePath: string,
  maxBytes = 1024 * 1024,
): Promise<string | null> {
  const stat = await access.fsBridge.stat({ filePath });
  if (!stat) {
    return null;
  }
  if (stat.type !== "file") {
    throw new Error(`Skill target is not a regular file: ${filePath}`);
  }
  const content = await access.fsBridge.readFile({
    filePath,
    maxBytes,
  });
  const decoded = content.toString("utf8");
  if (decoded.includes("\0") || !Buffer.from(decoded, "utf8").equals(content)) {
    throw new Error(`Skill Workshop can only read UTF-8 text files: ${filePath}`);
  }
  return decoded;
}

export async function readExternalSkillTree(
  access: SkillWorkshopTargetAccess,
  skillDir: string,
): Promise<SkillWorkshopTargetFile[]> {
  const files = await access.readSkillTree(skillDir);
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (
      !file.path ||
      file.path.includes("\\") ||
      path.posix.isAbsolute(file.path) ||
      file.path.split("/").some((part) => !part || part === "." || part === "..") ||
      hasControlCharacter(file.path) ||
      paths.has(file.path) ||
      !Buffer.isBuffer(file.content)
    ) {
      throw new Error("Skill Workshop target returned an invalid file path.");
    }
    paths.add(file.path);
    totalBytes += file.content.byteLength;
    if (
      paths.size > MAX_TARGET_FILES ||
      file.content.byteLength > MAX_TARGET_FILE_BYTES ||
      totalBytes > MAX_TARGET_TREE_BYTES
    ) {
      throw new Error("Skill Workshop target tree exceeded the limit.");
    }
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function hashExternalSkillTree(files: readonly SkillWorkshopTargetFile[]): string {
  return sha256Hex(
    JSON.stringify(
      files
        .toSorted((left, right) => left.path.localeCompare(right.path))
        .map((file) => {
          const content = file.content;
          return { path: file.path, sha256: sha256Hex(content), sizeBytes: content.byteLength };
        }),
    ),
  );
}
