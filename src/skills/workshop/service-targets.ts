import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SkillStatusEntry } from "../discovery/status.js";
import {
  assertInsideWorkspace,
  readWorkspaceSupportFile,
} from "../lifecycle/workspace-skill-write.js";
import { hashSkillProposalContent, type PreparedSkillProposalSupportFile } from "./store.js";
import { readExternalSkillFile } from "./target-access.js";
import type {
  SkillProposalRecord,
  SkillProposalSupportFile,
  SkillWorkshopTargetAccess,
  SkillWorkshopTargetSkill,
} from "./types.js";

const WRITABLE_WORKSPACE_SOURCES = new Set(["openclaw-workspace", "agents-skills-project"]);

export function isWritableWorkspaceSkillSource(source: string): boolean {
  return WRITABLE_WORKSPACE_SOURCES.has(source);
}

export async function buildSupportFileMetadata(
  files: readonly PreparedSkillProposalSupportFile[],
  targetSkillDir?: string,
  targetAccess?: SkillWorkshopTargetAccess,
): Promise<SkillProposalSupportFile[]> {
  const out: SkillProposalSupportFile[] = [];
  for (const file of files) {
    const metadata: SkillProposalSupportFile = {
      path: file.path,
      sizeBytes: file.sizeBytes,
      hash: file.hash,
    };
    if (targetSkillDir) {
      const targetContent = targetAccess
        ? await readExternalSkillFile(
            targetAccess,
            path.posix.join(targetSkillDir, file.path),
            256 * 1024,
          )
        : await readWorkspaceSupportFile({
            skillDir: targetSkillDir,
            relativePath: file.path,
          });
      metadata.targetExisted = targetContent !== null;
      if (targetContent !== null) {
        metadata.targetContentHash = hashSkillProposalContent(targetContent);
      }
    }
    out.push(metadata);
  }
  return out;
}

export function resolveExternalSkill(
  access: SkillWorkshopTargetAccess,
  skills: readonly SkillWorkshopTargetSkill[],
  skillName: string,
): SkillWorkshopTargetSkill | undefined {
  const normalized = skillName.trim().toLowerCase();
  const matches = skills.filter(
    (skill) =>
      skill.skillKey.toLowerCase() === normalized || skill.name.toLowerCase() === normalized,
  );
  if (matches.length > 1) {
    throw new Error(`Skill name is ambiguous on ${access.targetLabel}: ${skillName}`);
  }
  return matches[0];
}

export function assertWritableSkillTarget(workspaceDir: string, skill: SkillStatusEntry): void {
  if (!isWritableWorkspaceSkillSource(skill.source)) {
    throw new Error(`Skill source is not writable by Skill Workshop: ${skill.source}`);
  }
  assertInsideWorkspace(workspaceDir, skill.filePath, "skill file");
  assertInsideWorkspace(workspaceDir, skill.baseDir, "skill directory");
  if (path.basename(skill.filePath) !== "SKILL.md") {
    throw new Error("Skill Workshop can only update SKILL.md targets.");
  }
}

export function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

export async function assertSupportTargetsUnchanged(params: {
  record: SkillProposalRecord;
  targetAccess?: SkillWorkshopTargetAccess;
  assertUnchanged: (file: SkillProposalSupportFile, currentContent: string | null) => Promise<void>;
}): Promise<void> {
  const { record, targetAccess, assertUnchanged } = params;
  if (record.kind !== "update" || !record.supportFiles) {
    return;
  }
  for (const file of record.supportFiles) {
    if (file.targetExisted === undefined) {
      continue;
    }
    const currentContent = targetAccess
      ? await readExternalSkillFile(
          targetAccess,
          path.posix.join(record.target.skillDir, file.path),
          256 * 1024,
        )
      : await readWorkspaceSupportFile({
          skillDir: record.target.skillDir,
          relativePath: file.path,
        });
    await assertUnchanged(file, currentContent);
  }
}
