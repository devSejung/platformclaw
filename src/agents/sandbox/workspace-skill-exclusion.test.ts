import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as globalHooks from "../../plugins/hook-runner-global.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { prepareRunSkillContext } from "../../skills/runtime/run-context.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import {
  prepareExcludedWorkspaceSkillMounts,
  resolveReadOnlyWorkspaceSkillMounts,
} from "./workspace-mounts.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-skill-exclusion-")),
  );
  directories.push(root);
  const agentWorkspaceDir = path.join(root, "room");
  const excludedFile = path.join(agentWorkspaceDir, "skills", "physical-folder", "SKILL.md");
  const localFile = path.join(
    agentWorkspaceDir,
    ".agents",
    "skills",
    "physical-folder",
    "SKILL.md",
  );
  for (const file of [excludedFile, localFile]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
  }
  await fs.writeFile(
    excludedFile,
    "---\nname: different-display-name\ndescription: Hub\n---\nprivate source",
  );
  await fs.writeFile(localFile, "local source");
  await fs.writeFile(path.join(agentWorkspaceDir, "skills", "README.md"), "unmanaged readme");
  const materializationDir = path.join(root, "materialization");
  return { root, agentWorkspaceDir, excludedFile, localFile, materializationDir };
}

describe("explicit skill source exclusions", () => {
  it.each(["rw", "ro", "none"] as const)(
    "masks only the excluded physical directory for %s access",
    async (workspaceAccess) => {
      const f = await fixture();
      const workspaceDir =
        workspaceAccess === "rw" ? f.agentWorkspaceDir : path.join(f.root, "sandbox");
      await fs.mkdir(workspaceDir, { recursive: true });
      const params = {
        ...f,
        workspaceDir,
        workspaceAccess,
        workdir: "/workspace",
        excludedSkillFiles: [f.excludedFile],
      };
      const { mounts: masks } = await prepareExcludedWorkspaceSkillMounts(params);
      expect(masks.map((mount) => mount.containerPath)).toEqual(
        workspaceAccess === "none"
          ? []
          : [
              workspaceAccess === "rw"
                ? "/workspace/skills/physical-folder"
                : "/agent/skills/physical-folder",
            ],
      );
      if (masks[0]) {
        const before = await fs.stat(masks[0].hostPath);
        expect((await prepareExcludedWorkspaceSkillMounts(params)).mounts).toEqual(masks);
        const after = await fs.stat(masks[0].hostPath);
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
        expect(await fs.readdir(masks[0].hostPath)).toEqual([]);
      }
      expect(await fs.readFile(f.excludedFile, "utf8")).toContain("private source");
      expect(await fs.readFile(f.localFile, "utf8")).toBe("local source");
      expect(await fs.readFile(path.join(f.agentWorkspaceDir, "skills", "README.md"), "utf8")).toBe(
        "unmanaged readme",
      );
    },
  );

  it("makes container, relative, and host aliases read the same empty overlay", async () => {
    const f = await fixture();
    const alias = path.join(f.agentWorkspaceDir, "hub-alias");
    await fs.symlink(
      process.platform === "win32" ? path.dirname(f.excludedFile) : "skills/physical-folder",
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const { mounts: masks } = await prepareExcludedWorkspaceSkillMounts({
      ...f,
      workspaceDir: f.agentWorkspaceDir,
      workspaceAccess: "rw",
      workdir: "/workspace",
      excludedSkillFiles: [f.excludedFile],
    });
    const sandbox = createSandboxTestContext({
      overrides: {
        workspaceDir: f.agentWorkspaceDir,
        agentWorkspaceDir: f.agentWorkspaceDir,
        readOnlySkillMounts: masks,
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const canonical = resolveReadOnlyWorkspaceSkillMounts({
      ...sandbox,
      workdir: sandbox.containerWorkdir,
    });
    expect(
      mounts
        .filter((mount) => mount.source === "protectedSkill")
        .map((mount) => [mount.hostRoot, mount.containerRoot]),
    ).toEqual(canonical.map((mount) => [mount.hostPath, mount.containerPath]));
    const bridge = createSandboxFsBridge({ sandbox });
    for (const filePath of [
      "/workspace/skills/physical-folder/SKILL.md",
      "skills/physical-folder/SKILL.md",
      f.excludedFile,
    ]) {
      const resolved = resolveSandboxFsPathWithMounts({
        filePath,
        cwd: f.agentWorkspaceDir,
        defaultWorkspaceRoot: f.agentWorkspaceDir,
        defaultContainerRoot: "/workspace",
        mounts,
      });
      expect(resolved.hostPath).toBe(path.join(masks[0]!.hostPath, "SKILL.md"));
      await expect(bridge.readFile({ filePath })).rejects.toThrow(/ENOENT|no such file/i);
    }
    for (const filePath of ["/workspace/hub-alias/SKILL.md", path.join(alias, "SKILL.md")]) {
      await expect(bridge.readFile({ filePath })).rejects.toThrow(/ENOENT|no such file/i);
    }
    await expect(
      bridge.readFile({ filePath: "/workspace/.agents/skills/physical-folder/SKILL.md" }),
    ).resolves.toEqual(Buffer.from("local source"));
    await expect(bridge.readFile({ filePath: "/workspace/skills/README.md" })).resolves.toEqual(
      Buffer.from("unmanaged readme"),
    );
    expect(
      resolveSandboxFsPathWithMounts({
        filePath: "result.txt",
        cwd: f.agentWorkspaceDir,
        defaultWorkspaceRoot: f.agentWorkspaceDir,
        defaultContainerRoot: "/workspace",
        mounts,
      }).writable,
    ).toBe(true);
  });

  it("rejects raw-source bind aliases and nested writable targets", async () => {
    const f = await fixture();
    for (const bind of [
      `${path.dirname(f.excludedFile)}:/raw:ro`,
      `${f.agentWorkspaceDir}:/raw:rw`,
      `${f.excludedFile}:/one-file:ro`,
      `${f.root}:/workspace/skills/physical-folder/scripts:rw`,
    ]) {
      await expect(
        prepareExcludedWorkspaceSkillMounts({
          ...f,
          workspaceDir: f.agentWorkspaceDir,
          workspaceAccess: "rw",
          workdir: "/workspace",
          excludedSkillFiles: [f.excludedFile],
          binds: [bind],
        }),
      ).rejects.toThrow(/custom sandbox bind exposes an excluded skill/);
    }
  });

  it("records an absent installed source without creating it or blocking other skills", async () => {
    const f = await fixture();
    await fs.rm(path.dirname(f.excludedFile), { recursive: true });
    const result = await prepareExcludedWorkspaceSkillMounts({
      ...f,
      workspaceDir: f.agentWorkspaceDir,
      workspaceAccess: "rw",
      workdir: "/workspace",
      excludedSkillFiles: [],
      excludedSourceDirectories: [path.dirname(f.excludedFile)],
    });
    expect(result).toEqual({
      mounts: [],
      excludedSourceDirectories: [path.dirname(f.excludedFile)],
      missingSourceDirectories: [path.dirname(f.excludedFile)],
    });
    await expect(fs.lstat(path.dirname(f.excludedFile))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(f.localFile, "utf8")).toBe("local source");
  });

  it.each(["workspace", "skill-root"] as const)(
    "shares canonical mask and bind policy through a %s ancestor alias",
    async (aliasKind) => {
      const f = await fixture();
      let workspaceDir = f.agentWorkspaceDir;
      let physicalDirectory = path.dirname(f.excludedFile);
      if (aliasKind === "workspace") {
        workspaceDir = path.join(f.root, "room-alias");
        await fs.symlink(
          f.agentWorkspaceDir,
          workspaceDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      } else {
        const physicalRoot = path.join(f.agentWorkspaceDir, "real-skills");
        await fs.rename(path.join(f.agentWorkspaceDir, "skills"), physicalRoot);
        await fs.symlink(
          process.platform === "win32" ? physicalRoot : "real-skills",
          path.join(f.agentWorkspaceDir, "skills"),
          process.platform === "win32" ? "junction" : "dir",
        );
        physicalDirectory = path.join(physicalRoot, "physical-folder");
      }
      const sourceDirectory = path.join(workspaceDir, "skills", "physical-folder");
      const params = {
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        materializationDir: f.materializationDir,
        workspaceAccess: "rw" as const,
        workdir: "/workspace",
        excludedSkillFiles: [],
        excludedSourceDirectories: [sourceDirectory],
      };
      const { mounts } = await prepareExcludedWorkspaceSkillMounts(params);
      const containerSource = `/workspace/${aliasKind === "skill-root" ? "real-skills" : "skills"}/physical-folder`;
      expect(mounts.map((mount) => mount.containerPath)).toEqual([containerSource]);
      const bridge = createSandboxFsBridge({
        sandbox: createSandboxTestContext({
          overrides: {
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
            readOnlySkillMounts: mounts,
          },
        }),
      });
      for (const filePath of [
        "/workspace/skills/physical-folder/SKILL.md",
        `${containerSource}/SKILL.md`,
        path.join(sourceDirectory, "SKILL.md"),
        path.join(physicalDirectory, "SKILL.md"),
      ]) {
        await expect(bridge.readFile({ filePath })).rejects.toThrow(/ENOENT|no such file/i);
      }
      await expect(
        bridge.readFile({ filePath: "/workspace/.agents/skills/physical-folder/SKILL.md" }),
      ).resolves.toEqual(Buffer.from("local source"));
      await expect(
        bridge.readFile({ filePath: path.join(workspaceDir, "skills", "README.md") }),
      ).resolves.toEqual(Buffer.from("unmanaged readme"));
      expect(await fs.readFile(path.join(physicalDirectory, "SKILL.md"), "utf8")).toContain(
        "private source",
      );
      for (const bind of [
        `${physicalDirectory}:/raw:ro`,
        `${path.join(physicalDirectory, "SKILL.md")}:/raw-file:ro`,
        `${f.root}:/workspace/skills/physical-folder/scripts:rw`,
      ]) {
        await expect(
          prepareExcludedWorkspaceSkillMounts({ ...params, binds: [bind] }),
        ).rejects.toThrow(/custom sandbox bind exposes an excluded skill/);
      }
    },
  );

  it("aligns default read-only roots with a canonical workspace-contained parent alias", async () => {
    const f = await fixture();
    const realAgents = path.join(f.agentWorkspaceDir, "real-agents");
    await fs.rename(path.join(f.agentWorkspaceDir, ".agents"), realAgents);
    await fs.symlink(
      process.platform === "win32" ? realAgents : "real-agents",
      path.join(f.agentWorkspaceDir, ".agents"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const prepared = await prepareExcludedWorkspaceSkillMounts({
      ...f,
      workspaceDir: f.agentWorkspaceDir,
      workspaceAccess: "rw",
      workdir: "/workspace",
      excludedSkillFiles: [f.localFile],
    });
    expect(prepared.mounts[0]?.containerPath).toBe("/workspace/real-agents/skills/physical-folder");
    const sandbox = createSandboxTestContext({
      overrides: {
        workspaceDir: f.agentWorkspaceDir,
        agentWorkspaceDir: f.agentWorkspaceDir,
        readOnlySkillMounts: prepared.mounts,
      },
    });
    expect(buildSandboxFsMounts(sandbox)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hostRoot: path.join(realAgents, "skills"),
          containerRoot: "/workspace/real-agents/skills",
          writable: false,
        }),
      ]),
    );
    const bridge = createSandboxFsBridge({ sandbox });
    for (const filePath of [
      "/workspace/.agents/skills/physical-folder/SKILL.md",
      "/workspace/real-agents/skills/physical-folder/SKILL.md",
      f.localFile,
      path.join(realAgents, "skills", "physical-folder", "SKILL.md"),
    ]) {
      await expect(bridge.readFile({ filePath })).rejects.toThrow(/ENOENT|no such file/i);
    }
    await expect(bridge.readFile({ filePath: "/workspace/skills/README.md" })).resolves.toEqual(
      Buffer.from("unmanaged readme"),
    );
  });

  it("rejects an ancestor retarget between materialization and actual run preflight", async () => {
    const f = await fixture();
    const first = path.join(f.agentWorkspaceDir, "first-skills");
    const second = path.join(f.agentWorkspaceDir, "second-skills");
    await fs.rename(path.join(f.agentWorkspaceDir, "skills"), first);
    await fs.mkdir(path.join(second, "physical-folder"), { recursive: true });
    await fs.writeFile(path.join(second, "physical-folder", "SKILL.md"), "second private source");
    const alias = path.join(f.agentWorkspaceDir, "skills");
    const link = async (target: string) =>
      await fs.symlink(
        process.platform === "win32" ? target : path.basename(target),
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
    await link(first);
    const denied = path.join(alias, "physical-folder");
    vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(
      createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_skill_context",
            handler: () => ({ excludedPaths: [], excludedSourceDirectories: [denied] }),
          },
        ]),
      ),
    );
    const materialized = await prepareExcludedWorkspaceSkillMounts({
      ...f,
      workspaceDir: f.agentWorkspaceDir,
      workspaceAccess: "rw",
      workdir: "/workspace",
      excludedSkillFiles: [],
      excludedSourceDirectories: [denied],
    });
    const params = {
      workspaceDir: f.agentWorkspaceDir,
      context: { agentId: "room-agent", workspaceDir: f.agentWorkspaceDir },
      skillEntries: [],
      excludedSkillFiles: [],
      excludedSourceDirectories: materialized.excludedSourceDirectories,
      missingSourceDirectories: materialized.missingSourceDirectories,
    };
    const initial = await prepareRunSkillContext(params);
    await fs.unlink(alias);
    await link(second);
    expect(materialized.excludedSourceDirectories).toEqual([path.join(first, "physical-folder")]);
    expect(materialized.mounts[0]?.containerPath).toBe("/workspace/first-skills/physical-folder");
    await expect(prepareRunSkillContext(params)).rejects.toMatchObject({
      name: "SkillContextPolicyError",
    });
    await expect(initial.revalidate?.()).rejects.toMatchObject({ name: "SkillContextPolicyError" });
    expect(await fs.readFile(path.join(first, "physical-folder", "SKILL.md"), "utf8")).toContain(
      "private source",
    );
    expect(await fs.readFile(path.join(second, "physical-folder", "SKILL.md"), "utf8")).toBe(
      "second private source",
    );
  });
});
