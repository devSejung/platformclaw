/** Pure mount and path helpers for the remote sandbox filesystem bridge. */
import path from "node:path";
import { isPathInside } from "../../infra/path-guards.js";
import { isPathInsideContainerRoot, relativePathEscapesContainerRoot } from "./path-utils.js";
import { normalizeContainerPath as normalizeSandboxContainerPath } from "./path-utils.js";
import type { RemoteMountSource, ResolvedRemotePath } from "./remote-fs-bridge.types.js";
import {
  isExistingWorkspaceSkillMountSource,
  resolveMaterializedSandboxSkillsWorkspaceDir,
} from "./workspace-mounts.js";

export type RemoteMountInfo = {
  localRoot: string | null;
  containerRoot: string;
  writable: boolean;
  source: RemoteMountSource;
};

export function buildRemoteProtectedSkillMounts(params: {
  localRoot: string;
  skillsWorkspaceDir?: string;
  workspaceContainerRoot: string;
  agentContainerRoot: string;
  includeAgentMount: boolean;
}): RemoteMountInfo[] {
  const materializedSkillsWorkspaceDir = path.resolve(
    params.skillsWorkspaceDir ?? resolveMaterializedSandboxSkillsWorkspaceDir(params.localRoot),
  );
  const mounts: Array<RemoteMountInfo & { localRoot: string; allowedRoot: string }> = [
    {
      localRoot: path.join(params.localRoot, "skills"),
      containerRoot: path.posix.join(params.workspaceContainerRoot, "skills"),
      writable: false,
      source: "protectedSkill",
      allowedRoot: params.localRoot,
    },
    {
      localRoot: path.join(params.localRoot, ".agents", "skills"),
      containerRoot: path.posix.join(params.workspaceContainerRoot, ".agents", "skills"),
      writable: false,
      source: "protectedSkill",
      allowedRoot: params.localRoot,
    },
    {
      localRoot: path.join(materializedSkillsWorkspaceDir, "skills"),
      containerRoot: path.posix.join(
        params.workspaceContainerRoot,
        ".openclaw",
        "sandbox-skills",
        "skills",
      ),
      writable: false,
      source: "protectedSkill",
      allowedRoot: materializedSkillsWorkspaceDir,
    },
  ];
  if (params.includeAgentMount) {
    mounts.push(
      {
        localRoot: path.join(params.localRoot, "skills"),
        containerRoot: path.posix.join(params.agentContainerRoot, "skills"),
        writable: false,
        source: "protectedSkill",
        allowedRoot: params.localRoot,
      },
      {
        localRoot: path.join(params.localRoot, ".agents", "skills"),
        containerRoot: path.posix.join(params.agentContainerRoot, ".agents", "skills"),
        writable: false,
        source: "protectedSkill",
        allowedRoot: params.localRoot,
      },
      {
        localRoot: path.join(materializedSkillsWorkspaceDir, "skills"),
        containerRoot: path.posix.join(
          params.agentContainerRoot,
          ".openclaw",
          "sandbox-skills",
          "skills",
        ),
        writable: false,
        source: "protectedSkill",
        allowedRoot: materializedSkillsWorkspaceDir,
      },
    );
  }
  return mounts
    .filter((mount) =>
      isExistingWorkspaceSkillMountSource({
        rootDir: mount.allowedRoot,
        hostPath: mount.localRoot,
      }),
    )
    .map(({ allowedRoot: _allowedRoot, ...mount }) => mount);
}

function compareRemoteMountsByContainerPath(a: RemoteMountInfo, b: RemoteMountInfo): number {
  return b.containerRoot.length - a.containerRoot.length || mountPriority(b) - mountPriority(a);
}

function compareRemoteMountsByLocalPath(a: RemoteMountInfo, b: RemoteMountInfo): number {
  return (
    (b.localRoot?.length ?? 0) - (a.localRoot?.length ?? 0) || mountPriority(b) - mountPriority(a)
  );
}

export function buildRemoteProtectedSkillRoots(params: {
  workspaceContainerRoot: string;
  agentContainerRoot: string;
  includeAgentMount: boolean;
}): string[] {
  const roots = [
    path.posix.join(params.workspaceContainerRoot, "skills"),
    path.posix.join(params.workspaceContainerRoot, ".agents", "skills"),
    path.posix.join(params.workspaceContainerRoot, ".openclaw", "sandbox-skills", "skills"),
  ];
  if (params.includeAgentMount) {
    roots.push(
      path.posix.join(params.agentContainerRoot, "skills"),
      path.posix.join(params.agentContainerRoot, ".agents", "skills"),
      path.posix.join(params.agentContainerRoot, ".openclaw", "sandbox-skills", "skills"),
    );
  }
  return roots;
}

function mountPriority(mount: RemoteMountInfo): number {
  if (mount.source === "protectedSkill") {
    return 2;
  }
  if (mount.source === "agent") {
    return 1;
  }
  return 0;
}

export function normalizeContainerPath(value: string): string {
  const normalized = normalizeSandboxContainerPath(value || "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

/** Expands only the current-user home aliases understood by remote file tools. */
export function expandRemoteHomeAlias(filePath: string, remoteHomeDir?: string): string {
  if (!remoteHomeDir || (filePath !== "~" && !filePath.startsWith("~/"))) {
    return filePath;
  }
  return filePath === "~" ? remoteHomeDir : path.posix.join(remoteHomeDir, filePath.slice(2));
}

export function toPosixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).filter(Boolean).join(path.posix.sep);
}

export function resolveRemoteMountedPath(params: {
  workspaceRoot: string;
  mount: RemoteMountInfo;
  containerPath: string;
}): ResolvedRemotePath {
  const relative = path.posix.relative(params.mount.containerRoot, params.containerPath);
  if (relativePathEscapesContainerRoot(relative)) {
    throw new Error(`Sandbox path escapes allowed mounts; cannot access: ${params.containerPath}`);
  }
  return {
    relativePath:
      params.mount.source === "workspace" || params.mount.source === "protectedSkill"
        ? relative === "."
          ? ""
          : path.posix.relative(params.workspaceRoot, params.containerPath)
        : relative === "."
          ? params.mount.containerRoot
          : `${params.mount.containerRoot}/${relative}`,
    containerPath: params.containerPath,
    writable: params.mount.writable,
    mountRootPath: params.mount.containerRoot,
    source: params.mount.source,
  };
}

export function resolveRemoteMountByContainerPath(
  mounts: RemoteMountInfo[],
  containerPath: string,
): RemoteMountInfo | null {
  const ordered = [...mounts].toSorted(compareRemoteMountsByContainerPath);
  for (const mount of ordered) {
    if (isPathInsideContainerRoot(mount.containerRoot, containerPath)) {
      return mount;
    }
  }
  return null;
}

export function resolveRemoteMountByLocalPath(
  mounts: RemoteMountInfo[],
  localPath: string,
): (RemoteMountInfo & { localRoot: string }) | null {
  const ordered = [...mounts].toSorted(compareRemoteMountsByLocalPath);
  for (const mount of ordered) {
    if (mount.localRoot && isPathInside(mount.localRoot, localPath)) {
      return { ...mount, localRoot: mount.localRoot };
    }
  }
  return null;
}
