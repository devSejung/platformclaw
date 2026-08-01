import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { applySkillProposal, proposeCreateSkill, proposeUpdateSkill } from "./service.js";
import type { SkillWorkshopTargetAccess, SkillWorkshopTargetFile } from "./types.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-remote-skill-workshop-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

function createMemoryTargetAccess() {
  const skillsDir = "/home/person/.platformclaw/workspace/skills";
  const trees = new Map<string, Map<string, Buffer>>();
  const notifyChanged = vi.fn(async () => undefined);
  const locate = (filePath: string): { skillDir: string; relativePath: string } | null => {
    if (!filePath.startsWith(`${skillsDir}/`)) {
      return null;
    }
    const suffix = filePath.slice(skillsDir.length + 1);
    const [skillKey, ...parts] = suffix.split("/");
    return skillKey && parts.length > 0
      ? { skillDir: `${skillsDir}/${skillKey}`, relativePath: parts.join("/") }
      : null;
  };
  const snapshot = (skillDir: string): SkillWorkshopTargetFile[] =>
    [...(trees.get(skillDir) ?? new Map())].map(([filePath, content]) => ({
      path: filePath,
      content: Buffer.from(content),
    }));
  const access: SkillWorkshopTargetAccess = {
    backendId: "platformclaw-execution",
    targetId: "allocation-one",
    targetLabel: "Development VM",
    workspaceDir: "/home/person/.platformclaw/workspace",
    skillsDir,
    source: "platformclaw-vm-workspace",
    fsBridge: {
      resolvePath: ({ filePath }) => ({
        relativePath: filePath,
        containerPath: filePath,
      }),
      readFile: async ({ filePath }) => {
        const located = locate(filePath);
        const content = located
          ? trees.get(located.skillDir)?.get(located.relativePath)
          : undefined;
        if (!content) {
          throw new Error(`missing file: ${filePath}`);
        }
        return Buffer.from(content);
      },
      writeFile: async () => {
        throw new Error("direct write is unavailable");
      },
      mkdirp: async () => {
        throw new Error("direct mkdir is unavailable");
      },
      remove: async () => {
        throw new Error("direct remove is unavailable");
      },
      rename: async () => {
        throw new Error("direct rename is unavailable");
      },
      stat: async ({ filePath }) => {
        const located = locate(filePath);
        const content = located
          ? trees.get(located.skillDir)?.get(located.relativePath)
          : undefined;
        return content ? { type: "file" as const, size: content.byteLength, mtimeMs: 0 } : null;
      },
    },
    listSkills: async () =>
      [...trees].flatMap(([skillDir, files]) => {
        const skill = files.get("SKILL.md");
        if (!skill) {
          return [];
        }
        const skillKey = skillDir.slice(skillDir.lastIndexOf("/") + 1);
        return [
          {
            name: skillKey,
            skillKey,
            description: `Skill ${skillKey}`,
            source: "platformclaw-vm-workspace",
            skillDir,
            skillFile: `${skillDir}/SKILL.md`,
          },
        ];
      }),
    readSkillTree: async (skillDir) => snapshot(skillDir),
    mutateSkill: async ({ mode, skillDir, expectedTree, files }) => {
      const actual = snapshot(skillDir).toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      const expected = [...expectedTree].toSorted((left, right) =>
        left.path.localeCompare(right.path),
      );
      expect(actual.map((file) => [file.path, file.content.toString("base64")])).toEqual(
        expected.map((file) => [file.path, file.content.toString("base64")]),
      );
      const next = new Map(trees.get(skillDir) ?? []);
      if (mode === "create" && next.has("SKILL.md")) {
        throw new Error("skill already exists");
      }
      if (mode === "update" && !next.has("SKILL.md")) {
        throw new Error("skill is missing");
      }
      for (const file of files) {
        if (file.content === null) {
          next.delete(file.path);
        } else {
          next.set(file.path, Buffer.from(file.content));
        }
      }
      trees.set(skillDir, next);
    },
    notifyChanged,
  };
  return { access, notifyChanged, trees };
}

describe("Skill Workshop remote target", () => {
  it("creates and updates a VM-bound skill only after explicit apply", async () => {
    const workspaceDir = await tempDirs.make("openclaw-remote-skill-workshop-");
    const { access, notifyChanged, trees } = createMemoryTargetAccess();
    const created = await proposeCreateSkill({
      workspaceDir,
      agentId: "person_one",
      name: "VM Helper",
      description: "Create a reusable VM workflow",
      content: "# VM Helper\n\nRun the VM workflow.\n",
      supportFiles: [{ path: "references/guide.md", content: "# Guide\n" }],
      createdBy: "gateway",
      targetAccess: access,
    });

    expect(created.record.target).toMatchObject({
      skillDir: `${access.skillsDir}/vm-helper`,
      source: "platformclaw-vm-workspace",
      binding: {
        backendId: "platformclaw-execution",
        targetId: "allocation-one",
        targetLabel: "Development VM",
      },
    });
    expect(trees.size).toBe(0);

    await applySkillProposal({
      workspaceDir,
      agentId: "person_one",
      proposalId: created.record.id,
      expectedRevisionHash: created.revisionHash,
      targetAccess: access,
    });
    expect(trees.get(`${access.skillsDir}/vm-helper`)?.size).toBe(2);
    expect(trees.get(`${access.skillsDir}/vm-helper`)?.get("SKILL.md")?.toString("utf8")).toContain(
      "Run the VM workflow.",
    );

    const updated = await proposeUpdateSkill({
      workspaceDir,
      agentId: "person_one",
      skillName: "vm-helper",
      description: "Update the reusable VM workflow",
      content: "# VM Helper\n\nRun the safer VM workflow.\n",
      createdBy: "gateway",
      targetAccess: access,
    });
    await applySkillProposal({
      workspaceDir,
      agentId: "person_one",
      proposalId: updated.record.id,
      expectedRevisionHash: updated.revisionHash,
      targetAccess: access,
    });
    expect(trees.get(`${access.skillsDir}/vm-helper`)?.get("SKILL.md")?.toString("utf8")).toContain(
      "safer VM workflow",
    );
    expect(notifyChanged).toHaveBeenCalledTimes(2);
  });

  it("refuses to apply a proposal through a different VM allocation", async () => {
    const workspaceDir = await tempDirs.make("openclaw-remote-skill-workshop-");
    const { access } = createMemoryTargetAccess();
    const proposal = await proposeCreateSkill({
      workspaceDir,
      agentId: "person_one",
      name: "Bound Helper",
      description: "Stay on the selected VM allocation",
      content: "# Bound Helper\n",
      createdBy: "gateway",
      targetAccess: access,
    });

    await expect(
      applySkillProposal({
        workspaceDir,
        agentId: "person_one",
        proposalId: proposal.record.id,
        expectedRevisionHash: proposal.revisionHash,
        targetAccess: { ...access, targetId: "allocation-two", targetLabel: "Other VM" },
      }),
    ).rejects.toThrow("not the current execution target");
  });
});
