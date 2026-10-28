import { lstat } from "node:fs/promises";
import { resolveSandboxHostPathViaExistingAncestor } from "../../agents/sandbox/host-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import { buildWorkspaceSkillSnapshot, excludeSkillSnapshotPaths } from "../loading/workspace.js";
import type {
  SkillEligibilityContext,
  SkillEntry,
  SkillSnapshot,
  SkillUsagePath,
} from "../types.js";
import { resolveSkillContextExclusions, SkillContextPolicyError } from "./context-policy.js";

/** Revalidate selected skills even when a session or backend reuses its immutable snapshot. */
export async function prepareRunSkillContext(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  context: PluginHookAgentContext;
  eligibility?: SkillEligibilityContext;
  skillsSnapshot?: SkillSnapshot;
  skillEntries: SkillEntry[];
  skillUsagePaths?: readonly Pick<SkillUsagePath, "readPath" | "skillFile">[];
  /** Exclusions enforced by the already-prepared sandbox filesystem. */
  excludedSkillFiles?: readonly string[];
  excludedSourceDirectories?: readonly string[];
  missingSourceDirectories?: readonly string[];
}): Promise<{
  skillsSnapshot?: SkillSnapshot;
  skillEntries: SkillEntry[];
  /** Reject changes that the already-prepared prompt or native skill projection cannot enforce. */
  revalidate?: () => Promise<void>;
}> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("before_skill_context", params.context)) {
    return { skillsSnapshot: params.skillsSnapshot, skillEntries: params.skillEntries };
  }
  const snapshot =
    params.skillsSnapshot &&
    (!params.skillsSnapshot.resolvedSkills ||
      params.skillsSnapshot.skills.some((skill) => !skill.filePath || !skill.sourceFilePath))
      ? buildWorkspaceSkillSnapshot(params.workspaceDir, {
          config: params.config,
          agentId: params.context.agentId,
          entries: params.skillEntries,
          skillFilter: params.skillsSnapshot.skillFilter,
          skillOverrides: params.skillsSnapshot.skillOverrides,
          eligibility: params.eligibility,
          snapshotVersion: params.skillsSnapshot.version,
        })
      : params.skillsSnapshot;
  const candidates = snapshot
    ? snapshot.skills.flatMap(({ name, filePath, sourceFilePath }) =>
        filePath ? [{ name, filePath, sourceFilePath }] : [],
      )
    : params.skillEntries.map((entry) => entry.skill);
  const sourcePaths = new Map(
    params.skillUsagePaths?.map(({ readPath, skillFile }) => [readPath, skillFile]),
  );
  const preparedCandidates = candidates.map(({ name, filePath, sourceFilePath }) => ({
    name,
    filePath,
    sourceFilePath: sourcePaths.get(filePath) ?? sourceFilePath ?? filePath,
  }));
  const { excludedPaths, excludedSourceDirectories } = await resolveSkillContextExclusions(
    preparedCandidates,
    params.context,
  );
  const canonicalSourceDirectories = canonicalizeCurrentDirectories(excludedSourceDirectories);
  if (params.excludedSkillFiles !== undefined) {
    const applied = new Set(params.excludedSkillFiles);
    if (
      preparedCandidates.some(
        (candidate) =>
          excludedPaths.has(candidate.filePath) && !applied.has(candidate.sourceFilePath),
      )
    ) {
      throw new SkillContextPolicyError(
        new Error(
          "Skill permissions changed after filesystem preparation; retry with the current permissions.",
        ),
      );
    }
  }
  if (params.excludedSourceDirectories !== undefined) {
    const applied = new Set(params.excludedSourceDirectories);
    if ([...canonicalSourceDirectories].some((directory) => !applied.has(directory))) {
      throw new SkillContextPolicyError(
        new Error(
          "Skill source permissions changed after filesystem preparation; retry with the current permissions.",
        ),
      );
    }
  }
  await assertMissingExcludedSourcesAbsent(
    params.missingSourceDirectories,
    canonicalSourceDirectories,
  );
  return {
    revalidate: async () => {
      const current = await resolveSkillContextExclusions(
        preparedCandidates.filter((candidate) => !excludedPaths.has(candidate.filePath)),
        params.context,
      );
      const currentSourceDirectories = canonicalizeCurrentDirectories(
        current.excludedSourceDirectories,
      );
      if (
        !current.policyApplied ||
        current.excludedPaths.size > 0 ||
        [...currentSourceDirectories].some(
          (directory) => !canonicalSourceDirectories.has(directory),
        )
      ) {
        throw new SkillContextPolicyError(
          new Error(
            "Skill permissions changed after runtime preparation; retry to prepare the current skill selection.",
          ),
        );
      }
      await assertMissingExcludedSourcesAbsent(
        params.missingSourceDirectories,
        currentSourceDirectories,
      );
    },
    skillsSnapshot:
      snapshot && excludedPaths.size > 0
        ? excludeSkillSnapshotPaths(snapshot, excludedPaths, {
            config: params.config,
            agentId: params.context.agentId,
            eligibility: params.eligibility,
          })
        : snapshot,
    skillEntries: params.skillEntries.filter((entry) => !excludedPaths.has(entry.skill.filePath)),
  };
}

// Missing sources have no filesystem mask. Async setup can create them without
// changing policy, so both preparation and final admission must check existence.
async function assertMissingExcludedSourcesAbsent(
  missingSourceDirectories: readonly string[] | undefined,
  excludedSourceDirectories: ReadonlySet<string>,
): Promise<void> {
  for (const directory of missingSourceDirectories ?? []) {
    if (!excludedSourceDirectories.has(directory)) {
      continue;
    }
    try {
      await lstat(directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw new SkillContextPolicyError(error);
    }
    throw new SkillContextPolicyError(
      new Error(
        "An excluded skill source appeared after filesystem preparation; retry to apply its mask.",
      ),
    );
  }
}

function canonicalizeCurrentDirectories(directories: ReadonlySet<string>): ReadonlySet<string> {
  try {
    return new Set([...directories].map(resolveSandboxHostPathViaExistingAncestor));
  } catch (error) {
    throw new SkillContextPolicyError(error);
  }
}
