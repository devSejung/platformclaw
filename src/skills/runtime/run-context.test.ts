import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeCliSkillsPlugin } from "../../agents/cli-runner/claude-skills-plugin.js";
import { resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import * as globalHooks from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeSkillContextEvent } from "../../plugins/hook-types.js";
import { createHookRunner } from "../../plugins/hooks.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createSyntheticSourceInfo } from "../loading/skill-contract.js";
import {
  buildWorkspaceSkillSnapshot,
  loadWorkspaceSkillEntries,
  syncSkillsToWorkspace,
} from "../loading/workspace.js";
import type { SkillEntry } from "../types.js";
import { prepareRunSkillContext } from "./run-context.js";
import { prepareSandboxBackendSkillEntries } from "./sandbox-backend-skills.js";

afterEach(() => vi.restoreAllMocks());

function entry(name: string, hidden = false): SkillEntry {
  const filePath = `/workspace/skills/${name}/SKILL.md`;
  return {
    skill: {
      name,
      description: `${name} description`,
      filePath,
      baseDir: `/workspace/skills/${name}`,
      source: "openclaw-workspace",
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "openclaw-workspace" }),
      disableModelInvocation: hidden,
    },
    frontmatter: { name, description: `${name} description` },
    metadata: { primaryEnv: `${name.toUpperCase()}_TOKEN` },
    invocation: { disableModelInvocation: hidden, userInvocable: true },
  };
}

describe("run-local skill authority", () => {
  it("removes revoked candidates from refreshed sandbox and native CLI materialization while preserving source bytes", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "skill-context-")));
    try {
      const sourceWorkspaceDir = path.join(root, "source");
      const targetWorkspaceDir = path.join(root, "cache");
      for (const name of ["retained", "revoked"]) {
        const directory = path.join(sourceWorkspaceDir, "skills", name);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name} guidance\n---\nInstructions for ${name}.\n`,
        );
      }
      const options = {
        config: { plugins: { enabled: false } },
        managedSkillsDir: path.join(root, "managed"),
        bundledSkillsDir: path.join(root, "bundled"),
        pluginSkillsDir: path.join(root, "plugins"),
      };
      const entries = loadWorkspaceSkillEntries(sourceWorkspaceDir, options);
      const revokedPath = entries.find((candidate) => candidate.skill.name === "revoked")!.skill
        .filePath;
      let excludedPaths: string[] = [];
      const runner = createHookRunner(
        createMockPluginRegistry([
          { hookName: "before_skill_context", handler: () => ({ excludedPaths }) },
        ]),
      );
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
      const syncParams = {
        sourceWorkspaceDir,
        targetWorkspaceDir,
        agentId: "room-agent",
        ...options,
      };
      await syncSkillsToWorkspace(syncParams);
      const originalMaterialized = (
        await readdir(path.join(targetWorkspaceDir, "skills"))
      ).toSorted();
      expect(originalMaterialized).toEqual(expect.arrayContaining(["retained", "revoked"]));
      excludedPaths = [revokedPath];
      await syncSkillsToWorkspace(syncParams);
      expect((await readdir(path.join(targetWorkspaceDir, "skills"))).toSorted()).toEqual(
        originalMaterialized.filter((name) => name !== "revoked"),
      );
      const filtered = await prepareRunSkillContext({
        workspaceDir: sourceWorkspaceDir,
        config: options.config,
        context: { agentId: "room-agent" },
        skillEntries: entries,
        skillsSnapshot: buildWorkspaceSkillSnapshot(sourceWorkspaceDir, {
          entries,
          config: options.config,
        }),
      });
      const plugin = await prepareClaudeCliSkillsPlugin({
        backendId: "claude-cli",
        skillsSnapshot: filtered.skillsSnapshot,
      });
      try {
        expect(plugin.pluginDir).toBeDefined();
        const cliSkills = await readdir(path.join(plugin.pluginDir!, "skills"));
        expect(cliSkills).toContain("retained");
        expect(cliSkills).not.toContain("revoked");
        expect(cliSkills).toHaveLength(originalMaterialized.length - 1);
      } finally {
        await plugin.cleanup();
      }
      expect(await readFile(revokedPath, "utf8")).toContain("Instructions for revoked.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["current", "legacy-paths", "unhydrated"])(
    "rechecks a cached snapshot and excludes all projections (%s)",
    async (kind) => {
      const entries = [entry("retained"), entry("revoked"), entry("hidden", true)];
      const original = buildWorkspaceSkillSnapshot("/workspace", { entries });
      const snapshot =
        kind === "unhydrated"
          ? { ...original, resolvedSkills: undefined }
          : kind === "legacy-paths"
            ? {
                ...original,
                skills: original.skills.map((skill) => ({
                  ...skill,
                  filePath: `/legacy-cache/${skill.name}/SKILL.md`,
                  sourceFilePath: undefined,
                })),
              }
            : original;
      let excludedPaths: string[] = [];
      const check = vi.fn(() => ({ excludedPaths }));
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "before_skill_context", handler: check }]),
      );
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
      const params = {
        workspaceDir: "/workspace",
        context: { agentId: "room-agent" },
        skillsSnapshot: snapshot,
        skillEntries: entries,
      };
      const initial = await prepareRunSkillContext(params);
      expect(initial.skillsSnapshot?.prompt).toContain("<name>revoked</name>");
      excludedPaths = [entries[1]!.skill.filePath, entries[2]!.skill.filePath];
      const filtered = await prepareRunSkillContext(params);
      expect(check).toHaveBeenLastCalledWith(
        expect.objectContaining({
          candidates: expect.arrayContaining([
            {
              name: "hidden",
              filePath: entries[2]!.skill.filePath,
              sourceFilePath: entries[2]!.skill.filePath,
            },
          ]),
        }),
        expect.objectContaining({ agentId: "room-agent" }),
      );
      expect(filtered.skillsSnapshot?.prompt).toContain("<name>retained</name>");
      expect(filtered.skillsSnapshot?.prompt).not.toContain("revoked");
      expect(filtered.skillsSnapshot?.skills.map((skill) => skill.name)).toEqual(["retained"]);
      expect(filtered.skillsSnapshot?.resolvedSkills?.map((skill) => skill.name)).toEqual([
        "retained",
      ]);
      expect(filtered.skillEntries.map((candidate) => candidate.skill.name)).toEqual(["retained"]);
      expect(
        resolveCodeModeSkills({
          skillsPrompt: filtered.skillsSnapshot?.prompt ?? "",
          candidates: filtered.skillsSnapshot?.resolvedSkills ?? [],
        }).map((skill) => skill.name),
      ).toEqual(["retained"]);
      expect(original.prompt).toContain("<name>revoked</name>");
      expect(original.skills.map((skill) => skill.name)).toContain("hidden");
    },
  );

  it("stops preparation when current authority cannot be verified", async () => {
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_skill_context",
          handler: () => {
            throw new Error("policy unavailable");
          },
        },
      ]),
    );
    vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
    await expect(
      prepareRunSkillContext({
        workspaceDir: "/workspace",
        context: { agentId: "room-agent" },
        skillEntries: [entry("revoked")],
      }),
    ).rejects.toThrow("Skill permissions could not be verified");
  });

  it("stops a late permission change before using a filesystem prepared with older authority", async () => {
    const entries = [entry("retained"), entry("revoked")];
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_skill_context",
          handler: () => ({ excludedPaths: [entries[1]!.skill.filePath] }),
        },
      ]),
    );
    vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
    const params = {
      workspaceDir: "/workspace",
      context: { agentId: "room-agent" },
      skillEntries: entries,
      skillsSnapshot: buildWorkspaceSkillSnapshot("/workspace", { entries }),
    };
    await expect(prepareRunSkillContext({ ...params, excludedSkillFiles: [] })).rejects.toThrow(
      "Skill permissions could not be verified",
    );
    const current = await prepareRunSkillContext({
      ...params,
      excludedSkillFiles: [entries[1]!.skill.filePath],
    });
    expect(current.skillsSnapshot?.skills.map((skill) => skill.name)).toEqual(["retained"]);
  });

  it("rechecks a missing excluded source before admitting the run", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "skill-missing-source-")));
    const directory = path.join(root, "skills", "private");
    try {
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_skill_context",
            handler: () => ({ excludedPaths: [], excludedSourceDirectories: [directory] }),
          },
        ]),
      );
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
      const params = {
        workspaceDir: root,
        context: { agentId: "room-agent" },
        skillEntries: [],
        excludedSkillFiles: [],
        excludedSourceDirectories: [directory],
        missingSourceDirectories: [directory],
      };
      const prepared = await prepareRunSkillContext(params);
      expect(prepared.skillEntries).toEqual([]);
      if (!prepared.revalidate) {
        throw new Error("Expected final skill-context revalidation");
      }
      await expect(prepared.revalidate()).resolves.toBeUndefined();
      await mkdir(directory, { recursive: true });
      await expect(prepared.revalidate()).rejects.toThrow(
        "Skill permissions could not be verified",
      );
      await expect(prepareRunSkillContext(params)).rejects.toThrow(
        "Skill permissions could not be verified",
      );
      await expect(
        prepareRunSkillContext({ ...params, excludedSourceDirectories: [] }),
      ).rejects.toThrow("Skill permissions could not be verified");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows an appeared source when current authority no longer excludes it", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "skill-source-now-public-")));
    const directory = path.join(root, "skills", "previously-private");
    let excluded = true;
    try {
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_skill_context",
            handler: () => ({
              excludedPaths: [],
              excludedSourceDirectories: excluded ? [directory] : [],
            }),
          },
        ]),
      );
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
      const prepared = await prepareRunSkillContext({
        workspaceDir: root,
        context: { agentId: "room-agent" },
        skillEntries: [],
        excludedSkillFiles: [],
        excludedSourceDirectories: [directory],
        missingSourceDirectories: [directory],
      });
      if (!prepared.revalidate) {
        throw new Error("Expected final skill-context revalidation");
      }
      await mkdir(directory, { recursive: true });
      excluded = false;
      await expect(prepared.revalidate()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves host and sandbox source identity when unrelated skills share a folder basename", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "skill-source-context-")));
    try {
      const sourceWorkspaceDir = path.join(root, "room");
      const targetWorkspaceDir = path.join(root, "cache");
      const bundledSkillsDir = path.join(root, "bundled");
      const original = [
        { name: "demo", directory: path.join(sourceWorkspaceDir, "skills", "demo") },
        {
          name: "aaa-local",
          directory: path.join(sourceWorkspaceDir, ".agents", "skills", "demo"),
        },
        { name: "zzz-bundled", directory: path.join(bundledSkillsDir, "demo") },
      ];
      for (const { name, directory } of original) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${name} guidance\n---\nInstructions.`,
        );
      }
      const hubSource = path.join(original[0]!.directory, "SKILL.md");
      let revoked = false;
      const check = vi.fn((input: unknown) => {
        const event = input as PluginHookBeforeSkillContextEvent;
        return {
          excludedPaths: event.candidates
            .filter((candidate) => revoked && candidate.sourceFilePath === hubSource)
            .map((candidate) => candidate.filePath),
        };
      });
      const runner = createHookRunner(
        createMockPluginRegistry([{ hookName: "before_skill_context", handler: check }]),
      );
      vi.spyOn(globalHooks, "getGlobalHookRunner").mockReturnValue(runner);
      const options = {
        config: { plugins: { enabled: false } },
        managedSkillsDir: path.join(root, "managed"),
        pluginSkillsDir: path.join(root, "plugins"),
        bundledSkillsDir,
        skillFilter: original.map(({ name }) => name),
      };
      const { skillUsagePaths: usagePaths } = await syncSkillsToWorkspace({
        sourceWorkspaceDir,
        targetWorkspaceDir,
        agentId: "room-agent",
        ...options,
      });
      expect(
        usagePaths
          .filter((usage) => original.some(({ name }) => name === usage.skillName))
          .map((usage) => path.basename(path.dirname(usage.readPath))),
      ).toEqual(["demo", "demo-2", "demo-3"]);
      const backendEntries = prepareSandboxBackendSkillEntries({
        revision: "gateway:room",
        owner: "gateway",
        files: await Promise.all(
          usagePaths.map(async (usage) => ({
            source: usage.skillSourceId ?? usage.skillSource,
            filePath: `/sandbox/skills/${path.basename(path.dirname(usage.readPath))}/SKILL.md`,
            sourceFilePath: usage.skillFile,
            content: await readFile(usage.readPath, "utf8"),
          })),
        ),
      });
      const snapshot = buildWorkspaceSkillSnapshot(targetWorkspaceDir, {
        config: options.config,
        entries: backendEntries,
      });
      revoked = true;
      const filtered = await prepareRunSkillContext({
        workspaceDir: targetWorkspaceDir,
        config: options.config,
        context: { agentId: "room-agent" },
        skillsSnapshot: snapshot,
        skillEntries: [],
      });
      expect(filtered.skillsSnapshot?.skills.map((skill) => skill.name)).toEqual([
        "aaa-local",
        "zzz-bundled",
      ]);
      expect(filtered.skillsSnapshot?.prompt).not.toContain("<name>demo</name>");
      const cacheEntries = loadWorkspaceSkillEntries(targetWorkspaceDir, {
        config: options.config,
        workspaceOnly: true,
      });
      const cliFiltered = await prepareRunSkillContext({
        workspaceDir: targetWorkspaceDir,
        config: options.config,
        context: { agentId: "room-agent" },
        skillEntries: cacheEntries,
        skillUsagePaths: usagePaths,
      });
      expect(cliFiltered.skillEntries.map(({ skill }) => skill.name)).toEqual([
        "aaa-local",
        "zzz-bundled",
      ]);
      await syncSkillsToWorkspace({
        sourceWorkspaceDir,
        targetWorkspaceDir,
        agentId: "room-agent",
        ...options,
      });
      expect((await readdir(path.join(targetWorkspaceDir, "skills"))).toSorted()).toEqual([
        "demo",
        "demo-2",
      ]);
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({
          candidates: expect.arrayContaining([
            expect.objectContaining({ name: "demo", sourceFilePath: hubSource }),
          ]),
        }),
        expect.anything(),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
