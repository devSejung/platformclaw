import { tryAcquireAgentWorkMutation } from "../agent-work-admission.js";
import { listRunningSessions } from "../bash-process-registry.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import { SandboxSkillRefreshBusyError } from "./provisioning-error.js";
import { resolveSandboxAgentId } from "./shared.js";
import type { SandboxConfig } from "./types.js";
import {
  appendReadOnlyWorkspaceSkillMountArgs,
  appendWorkspaceMountArgs,
  filterBindsConflictingWithProtectedMounts,
  resolvePreviousReadOnlyWorkspaceSkillMounts,
  resolveProtectedSkillMountContainerPaths,
  type ReadOnlyWorkspaceSkillMount,
} from "./workspace-mounts.js";

type DockerSkillRefreshLayout = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  readOnlySkillMounts?: readonly ReadOnlyWorkspaceSkillMount[];
  cfg: SandboxConfig;
  requireCurrentConfig?: boolean;
  reconcileSandboxSkillMounts?: true;
};

export type DockerSkillMountRefresh = { containerId: string; release: () => void };

async function findSkillMountReplacementTarget(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  scopeKey: string;
  currentHash: string;
  createParams: DockerSkillRefreshLayout;
  hashConfig: (mounts: readonly ReadOnlyWorkspaceSkillMount[]) => string;
}): Promise<string | undefined> {
  const result = await execContainer(
    params.engine,
    [
      "inspect",
      "--type=container",
      "-f",
      [
        "{{.Id}}",
        '{{index .Config.Labels "openclaw.sandbox"}}',
        '{{index .Config.Labels "openclaw.sessionKey"}}',
        '{{index .Config.Labels "openclaw.configHash"}}',
        "{{json .HostConfig.Binds}}",
      ].join("\n"),
      params.containerName,
    ],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return undefined;
  }
  const [id, managed, scope, hash, rawBinds] = result.stdout.trim().split(/\r?\n/u);
  if (
    !id ||
    !/^[a-f0-9]{64}$/u.test(id) ||
    managed !== "1" ||
    scope !== params.scopeKey ||
    hash !== params.currentHash ||
    !rawBinds
  ) {
    return undefined;
  }
  let binds: unknown;
  try {
    binds = JSON.parse(rawBinds);
  } catch {
    return undefined;
  }
  if (!Array.isArray(binds) || !binds.every((bind): bind is string => typeof bind === "string")) {
    return undefined;
  }
  const { cfg, workspaceDir, agentWorkspaceDir, skillsWorkspaceDir, readOnlySkillMounts } =
    params.createParams;
  const layout = {
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    readOnlySkillMounts,
    workdir: cfg.docker.workdir,
    workspaceAccess: cfg.workspaceAccess,
  };
  const previousMounts = resolvePreviousReadOnlyWorkspaceSkillMounts(layout, binds);
  if (params.hashConfig(previousMounts) !== hash) {
    return undefined;
  }
  const bindArgs: string[] = [];
  appendWorkspaceMountArgs({
    args: bindArgs,
    ...layout,
    includeReadOnlyWorkspaceSkillMounts: false,
  });
  for (const bind of filterBindsConflictingWithProtectedMounts(
    cfg.docker.binds,
    resolveProtectedSkillMountContainerPaths(previousMounts),
  )) {
    bindArgs.push("-v", bind);
  }
  appendReadOnlyWorkspaceSkillMountArgs({
    args: bindArgs,
    readOnlyWorkspaceSkillMounts: previousMounts,
  });
  const expectedBinds = bindArgs.filter((_, index) => index % 2 === 1);
  const previousBinds = new Set(binds);
  if (
    previousBinds.size !== binds.length ||
    new Set(expectedBinds).size !== expectedBinds.length ||
    expectedBinds.length !== binds.length ||
    !expectedBinds.every((bind) => previousBinds.has(bind))
  ) {
    return undefined;
  }
  return id;
}

export async function prepareDockerSkillMountRefresh(
  params: Parameters<typeof findSkillMountReplacementTarget>[0],
): Promise<DockerSkillMountRefresh | undefined> {
  const { cfg, requireCurrentConfig, reconcileSandboxSkillMounts } = params.createParams;
  // Browser containers have their own mount lifecycle. A primary-only refresh
  // cannot prove that a browser-enabled runtime's skill view is current.
  if (
    !requireCurrentConfig ||
    !reconcileSandboxSkillMounts ||
    params.engine.id !== "docker" ||
    cfg.browser.enabled ||
    cfg.workspaceAccess !== "rw" ||
    cfg.scope === "shared"
  ) {
    return undefined;
  }
  const agentId = resolveSandboxAgentId(params.scopeKey);
  if (!agentId) {
    return undefined;
  }
  const containerId = await findSkillMountReplacementTarget(params);
  if (!containerId) {
    return undefined;
  }
  const release = tryAcquireAgentWorkMutation(agentId, {
    allowCurrent: true,
    createBusyError: () => new SandboxSkillRefreshBusyError(),
  });
  if (!release) {
    throw new SandboxSkillRefreshBusyError();
  }
  // A detached shell can outlive the model turn that admitted it.
  if (
    listRunningSessions().some((session) => {
      const key = session.sessionKey ?? session.scopeKey;
      return key?.startsWith("agent:") && resolveSandboxAgentId(key) === agentId;
    })
  ) {
    release();
    throw new SandboxSkillRefreshBusyError();
  }
  return { containerId, release };
}
