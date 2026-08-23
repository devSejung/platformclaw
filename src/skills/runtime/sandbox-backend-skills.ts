import type { SandboxBackendSkillCatalog } from "../../agents/sandbox/backend-handle.types.js";
import { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  parseFrontmatter,
  resolveOpenClawMetadata,
  resolveSkillInvocationPolicy,
} from "../loading/frontmatter.js";
import { computeSkillPromptVersion } from "../loading/skill-version.js";
import type { OpenClawSkillMetadata, SkillEligibilityContext, SkillEntry } from "../types.js";

const log = createSubsystemLogger("skills/sandbox-backend");

function suppressGatewayInstallActions(
  metadata: OpenClawSkillMetadata | undefined,
): OpenClawSkillMetadata | undefined {
  if (!metadata?.install) {
    return metadata;
  }
  const safeMetadata = { ...metadata };
  // Backend-owned requirements describe the remote target, but the existing installer is local.
  delete safeMetadata.install;
  return safeMetadata;
}

export function resolveSandboxBackendSkillEligibility(
  catalog: SandboxBackendSkillCatalog,
): SkillEligibilityContext["remote"] | undefined {
  if (!catalog.eligibility) {
    return undefined;
  }
  const bins = new Set(catalog.eligibility.bins);
  return {
    platforms: [...catalog.eligibility.platforms],
    hasBin: (bin) => bins.has(bin),
    hasAnyBin: (required) => required.some((bin) => bins.has(bin)),
  };
}

/** Converts a backend-owned immutable catalog into normal runtime skill entries. */
export function prepareSandboxBackendSkillEntries(
  catalog: SandboxBackendSkillCatalog,
): SkillEntry[] {
  const gatewayOwned = catalog.owner === "gateway";
  const entries: SkillEntry[] = [];
  const usedNames = new Set<string>();
  for (const file of catalog.files) {
    try {
      const frontmatter = parseFrontmatter(file.content);
      const name = frontmatter.name?.trim();
      const description = frontmatter.description?.trim();
      if (!name || !description || usedNames.has(name)) {
        continue;
      }
      usedNames.add(name);
      const baseDir = file.filePath.replace(/[/\\]SKILL\.md$/u, "");
      const invocation = resolveSkillInvocationPolicy(frontmatter);
      entries.push({
        skill: {
          name,
          description,
          ...(file.locationNote ? { locationNote: file.locationNote } : {}),
          readContent: file.content,
          filePath: file.filePath,
          baseDir,
          promptVersion: computeSkillPromptVersion(file.content),
          source: file.source,
          sourceInfo: createSyntheticSourceInfo(file.filePath, {
            source: file.source,
            scope: "temporary",
            origin: "top-level",
            baseDir,
          }),
          disableModelInvocation: invocation.disableModelInvocation,
        },
        frontmatter,
        metadata: gatewayOwned
          ? resolveOpenClawMetadata(frontmatter)
          : suppressGatewayInstallActions(resolveOpenClawMetadata(frontmatter)),
        invocation,
        // Backend-owned skills execute on that backend; gateway-local direct dispatch is unsafe.
        disableCommandDispatch: !gatewayOwned,
        exposure: {
          includeInRuntimeRegistry: true,
          includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
          userInvocable: invocation.userInvocable,
        },
      });
    } catch (error) {
      log.warn(`dropped invalid backend skill (${file.filePath}): ${String(error)}`);
    }
  }
  return entries;
}
