/**
 * Sandbox workspace mount argument builder.
 *
 * Creates Docker bind specs for writable workspaces and read-only skill source mounts.
 */
import fs from "node:fs";
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import type { SandboxBackendReadOnlySkillMount } from "./backend.types.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import { resolveSandboxHostPathViaExistingAncestor } from "./host-paths.js";
import { normalizeContainerPath } from "./path-utils.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 4;
const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS = [".openclaw", "sandbox-skills"] as const;

/** Read-only skill directory mounted from the agent workspace into the sandbox workspace. */
export type ReadOnlyWorkspaceSkillMount = SandboxBackendReadOnlySkillMount;

function formatManagedWorkspaceBind(params: {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}): string {
  return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
}

function containerJoin(root: string, ...parts: string[]): string {
  const normalizedRoot = root.endsWith("/") && root !== "/" ? root.slice(0, -1) : root;
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot;
}

function normalizeMountContainerPath(containerPath: string): string {
  return normalizeContainerPath(containerPath).replace(/\/+$/, "") || "/";
}

/** Hidden workspace used to materialize non-workspace skills for rw sandboxes. */
export function resolveMaterializedSandboxSkillsWorkspaceDir(rootDir: string): string {
  return path.join(rootDir, ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS);
}

/** Returns true when a skill mount source exists inside the canonical mount root. */
export function isExistingWorkspaceSkillMountSource(params: {
  rootDir: string;
  hostPath: string;
}): boolean {
  try {
    if (!fs.lstatSync(params.hostPath).isDirectory()) {
      return false;
    }
  } catch {
    return false;
  }

  const agentRoot = resolveSandboxHostPathViaExistingAncestor(path.resolve(params.rootDir));
  const canonicalSource = resolveSandboxHostPathViaExistingAncestor(path.resolve(params.hostPath));
  return isPathInside(agentRoot, canonicalSource);
}

/** Hide only explicitly excluded source directories; preserve every other workspace byte. */
export async function prepareExcludedWorkspaceSkillMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  materializationDir: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  excludedSkillFiles: readonly string[];
  excludedSourceDirectories?: readonly string[];
  binds?: readonly string[];
}): Promise<{
  mounts: ReadOnlyWorkspaceSkillMount[];
  excludedSourceDirectories: string[];
  missingSourceDirectories: string[];
}> {
  const agentRoot = path.resolve(params.agentWorkspaceDir);
  const sourceRoots = [path.join(agentRoot, "skills"), path.join(agentRoot, ".agents", "skills")];
  const directories = [
    ...new Set([
      ...params.excludedSkillFiles.flatMap((file) => {
        if (!path.isAbsolute(file) || path.basename(file) !== "SKILL.md") {
          return [];
        }
        const directory = path.dirname(path.resolve(file));
        if (!sourceRoots.some((root) => isPathInside(root, directory))) {
          return [];
        }
        return [directory];
      }),
      ...(params.excludedSourceDirectories ?? []).map((directory) => {
        const resolved = path.resolve(directory);
        if (
          !path.isAbsolute(directory) ||
          !sourceRoots.some((root) => isPathInside(root, resolved))
        ) {
          throw new Error("Excluded skill directory is outside the prepared agent's skill roots.");
        }
        return resolved;
      }),
    ]),
  ].toSorted();
  const missingSourceDirectories: string[] = [];
  const canonicalAgentRoot = resolveSandboxHostPathViaExistingAncestor(agentRoot);
  const sources = directories.map((directory) => ({
    directory,
    canonical: resolveSandboxHostPathViaExistingAncestor(directory),
  }));
  // Capture these identities with the mount targets, before any awaited work.
  // Re-resolving this receipt later would follow a retargeted ancestor alias.
  const excludedSourceDirectories = [...new Set(sources.map((source) => source.canonical))];
  const existingDirectories = sources.filter(({ directory, canonical }) => {
    if (!isPathInside(canonicalAgentRoot, canonical)) {
      throw new Error("Excluded skill directory escapes the prepared agent workspace.");
    }
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Excluded skill directory is not a regular source directory.");
      }
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        missingSourceDirectories.push(canonical);
        return false;
      }
      throw error;
    }
  });
  const aliases = [
    {
      hostPath: resolveSandboxHostPathViaExistingAncestor(path.resolve(params.workspaceDir)),
      containerPath: params.workdir,
    },
  ];
  if (params.workspaceAccess !== "none" && path.resolve(params.workspaceDir) !== agentRoot) {
    aliases.push({ hostPath: canonicalAgentRoot, containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT });
  }
  const targets = [
    ...new Set(
      existingDirectories.flatMap(({ canonical: directory }) =>
        aliases.flatMap((alias) =>
          isPathInside(alias.hostPath, directory)
            ? [
                containerJoin(
                  alias.containerPath,
                  ...path.relative(alias.hostPath, directory).split(path.sep),
                ),
              ]
            : [],
        ),
      ),
    ),
  ].toSorted();
  if (directories.length === 0) {
    return { mounts: [], excludedSourceDirectories, missingSourceDirectories };
  }

  for (const bind of params.binds ?? []) {
    const parsed = splitSandboxBindSpec(bind);
    if (!parsed) {
      throw new Error("Invalid sandbox bind while preparing skill permissions.");
    }
    const hostPath = resolveSandboxHostPathViaExistingAncestor(path.resolve(parsed.host));
    const containerPath = normalizeMountContainerPath(parsed.container);
    if (
      sources.some(
        ({ canonical: directory }) =>
          isPathInside(hostPath, directory) || isPathInside(directory, hostPath),
      ) ||
      aliases.some((alias) => {
        if (!isPathInsideContainerPath(alias.containerPath, containerPath)) {
          return false;
        }
        const relative = path.posix.relative(alias.containerPath, containerPath);
        const destination = resolveSandboxHostPathViaExistingAncestor(
          path.join(alias.hostPath, ...relative.split("/")),
        );
        return sources.some(({ canonical }) => isPathInside(canonical, destination));
      })
    ) {
      throw new Error(
        "A custom sandbox bind exposes an excluded skill directory; remove that bind before retrying.",
      );
    }
  }
  if (targets.length === 0) {
    return { mounts: [], excludedSourceDirectories, missingSourceDirectories };
  }
  // This sibling is never part of the refreshed skills/.source-mounts trees.
  // Keep its inode stable so an existing read-only bind can never reveal old bytes.
  const emptyDirectory = path.join(params.materializationDir, ".excluded-skill-empty");
  await fs.promises.mkdir(emptyDirectory, { recursive: true, mode: 0o700 });
  const stat = await fs.promises.lstat(emptyDirectory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.promises.readdir(emptyDirectory)).length > 0
  ) {
    throw new Error(
      "The excluded skill materialization directory is not an empty owned directory.",
    );
  }
  return {
    mounts: targets.map((containerPath) => ({ hostPath: emptyDirectory, containerPath })),
    excludedSourceDirectories,
    missingSourceDirectories,
  };
}

function isPathInsideContainerPath(root: string, target: string): boolean {
  const relative = path.posix.relative(
    normalizeMountContainerPath(root),
    normalizeMountContainerPath(target),
  );
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))
  );
}

/** Finds agent-workspace skill directories that should be mounted read-only in rw workspaces. */
export function resolveReadOnlyWorkspaceSkillMounts(params: {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  readOnlySkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
}): ReadOnlyWorkspaceSkillMount[] {
  // RW workspaces mount the project as writable, but skill sources remain read-only so agent
  // instructions are visible without letting sandbox commands mutate them.
  const materializedSkillsWorkspaceDir =
    params.skillsWorkspaceDir ??
    resolveMaterializedSandboxSkillsWorkspaceDir(params.agentWorkspaceDir);
  const mounts =
    params.workspaceAccess === "rw"
      ? [
          {
            hostPath: path.join(params.agentWorkspaceDir, "skills"),
            containerPath: containerJoin(params.workdir, "skills"),
            rootDir: params.agentWorkspaceDir,
            workspaceSource: true,
          },
          {
            hostPath: path.join(params.agentWorkspaceDir, ".agents", "skills"),
            containerPath: containerJoin(params.workdir, ".agents", "skills"),
            rootDir: params.agentWorkspaceDir,
            workspaceSource: true,
          },
          {
            hostPath: path.join(materializedSkillsWorkspaceDir, "skills"),
            containerPath: containerJoin(
              params.workdir,
              ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS,
              "skills",
            ),
            rootDir: materializedSkillsWorkspaceDir,
            workspaceSource: false,
          },
        ]
      : [];

  const defaults = mounts
    .filter((mount) =>
      isExistingWorkspaceSkillMountSource({
        rootDir: mount.rootDir,
        hostPath: mount.hostPath,
      }),
    )
    .map(({ hostPath, containerPath, rootDir, workspaceSource }) => {
      const canonicalHost = resolveSandboxHostPathViaExistingAncestor(hostPath);
      // Docker resolves workspace source aliases in the mounted tree. Use that
      // same destination for its hash, nested masks, and host filesystem reads.
      const canonicalTarget = workspaceSource
        ? containerJoin(
            params.workdir,
            ...path
              .relative(
                resolveSandboxHostPathViaExistingAncestor(path.resolve(rootDir)),
                canonicalHost,
              )
              .split(path.sep),
          )
        : containerPath;
      return { hostPath: canonicalHost, containerPath: canonicalTarget };
    });
  // One authoritative plan is shared by Docker and the filesystem bridge.
  const byTarget = new Map(
    defaults.map((mount) => [normalizeMountContainerPath(mount.containerPath), mount]),
  );
  for (const mount of params.readOnlySkillMounts ?? []) {
    byTarget.set(normalizeMountContainerPath(mount.containerPath), mount);
  }
  return [...byTarget.values()];
}

/** Returns stable mount state for sandbox config hashes. */
export function formatReadOnlyWorkspaceSkillMountHashState(
  mounts: readonly ReadOnlyWorkspaceSkillMount[],
): string[] {
  return mounts.map((mount) => `${mount.hostPath}:${mount.containerPath}:ro`);
}

/**
 * Returns the set of container paths that are protected by read-only skill mounts.
 *
 * User-defined binds that target any path in this set must be skipped so the
 * container engine sees one authoritative read-only mount for each destination.
 */
export function resolveProtectedSkillMountContainerPaths(
  mounts: readonly ReadOnlyWorkspaceSkillMount[],
): Set<string> {
  return new Set(mounts.map((mount) => normalizeMountContainerPath(mount.containerPath)));
}

/**
 * Returns a filtered copy of `binds` with entries whose container path conflicts with a
 * protected skill mount removed. Protected skill mounts always take precedence so checked-in
 * skills cannot be made writable by a user bind.
 */
export function filterBindsConflictingWithProtectedMounts(
  binds: readonly string[] | undefined,
  protectedContainerPaths: ReadonlySet<string>,
): string[] {
  if (!binds?.length) {
    return [];
  }
  if (protectedContainerPaths.size === 0) {
    return [...binds];
  }
  const filtered: string[] = [];
  for (const bind of binds) {
    const spec = splitSandboxBindSpec(bind);
    if (!spec) {
      filtered.push(bind);
      continue;
    }
    const containerPath = normalizeMountContainerPath(spec.container);
    if (!protectedContainerPaths.has(containerPath)) {
      filtered.push(bind);
    }
  }
  return filtered;
}

/** Appends Docker `-v` args for read-only skill mounts. */
export function appendReadOnlyWorkspaceSkillMountArgs(params: {
  args: string[];
  readOnlyWorkspaceSkillMounts: readonly ReadOnlyWorkspaceSkillMount[];
}): void {
  for (const mount of params.readOnlyWorkspaceSkillMounts) {
    params.args.push(
      "-v",
      formatManagedWorkspaceBind({
        hostPath: mount.hostPath,
        containerPath: mount.containerPath,
        readOnly: true,
      }),
    );
  }
}

/** Appends Docker workspace mount args for the project, agent workspace, and skill overlays. */
export function appendWorkspaceMountArgs(params: {
  args: string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  readOnlyWorkspaceSkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
  includeReadOnlyWorkspaceSkillMounts?: boolean;
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  args.push(
    "-v",
    formatManagedWorkspaceBind({
      hostPath: workspaceDir,
      containerPath: workdir,
      readOnly: workspaceAccess !== "rw",
    }),
  );

  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    args.push(
      "-v",
      formatManagedWorkspaceBind({
        hostPath: agentWorkspaceDir,
        containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
        readOnly: workspaceAccess === "ro",
      }),
    );
  }

  if (params.includeReadOnlyWorkspaceSkillMounts !== false) {
    appendReadOnlyWorkspaceSkillMountArgs({
      args,
      readOnlyWorkspaceSkillMounts:
        params.readOnlyWorkspaceSkillMounts ??
        resolveReadOnlyWorkspaceSkillMounts({
          workspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir: params.skillsWorkspaceDir,
          workdir,
          workspaceAccess,
        }),
    });
  }
}
