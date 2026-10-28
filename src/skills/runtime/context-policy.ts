import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeSkillContextEvent,
} from "../../plugins/hook-types.js";

export class SkillContextPolicyError extends Error {
  constructor(cause: unknown) {
    super(
      "Skill permissions could not be verified. Retry to refresh the current skill selection.",
      {
        cause,
      },
    );
    this.name = "SkillContextPolicyError";
  }
}

/** Policy admission failures stay terminal through cleanup and transport wrappers. */
export function isSkillContextPolicyError(error: unknown, seen = new Set<object>()): boolean {
  if (error instanceof SkillContextPolicyError) {
    return true;
  }
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  return [
    "cause" in error ? error.cause : undefined,
    "error" in error ? error.error : undefined,
    ...("errors" in error && Array.isArray(error.errors) ? error.errors : []),
  ].some((nested) => isSkillContextPolicyError(nested, seen));
}

/** One fail-closed authority boundary for prompt selection and filesystem materialization. */
export async function resolveSkillContextExclusions(
  candidates: PluginHookBeforeSkillContextEvent["candidates"],
  context: PluginHookAgentContext,
): Promise<{
  excludedPaths: ReadonlySet<string>;
  excludedSourceDirectories: ReadonlySet<string>;
  policyApplied: boolean;
}> {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("before_skill_context", context)) {
    return { excludedPaths: new Set(), excludedSourceDirectories: new Set(), policyApplied: false };
  }
  try {
    const result = await runner.runBeforeSkillContext({ candidates }, context);
    return {
      excludedPaths: new Set(result?.excludedPaths ?? []),
      excludedSourceDirectories: new Set(result?.excludedSourceDirectories ?? []),
      policyApplied: true,
    };
  } catch (error) {
    throw new SkillContextPolicyError(error);
  }
}
