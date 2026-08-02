/**
 * Sandbox context resolver.
 *
 * Prepares workspace layout, backend handle, filesystem bridge, browser bridge, and registry state for one run.
 */
import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
} from "../../plugin-sdk/browser-control-auth.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  resolveBrowserConfig,
} from "../../plugin-sdk/browser-profiles.js";
import { defaultRuntime } from "../../runtime.js";
import type { SkillEligibilityContext, SkillUsagePath } from "../../skills/types.js";
import type { ExecPolicyOverrides } from "../exec-defaults.js";
import {
  getSandboxBackendSkillMaterializationMode,
  getSandboxBackendWorkdirResolver,
  requireSandboxBackendFactory,
} from "./backend.js";
import { ensureSandboxBrowser } from "./browser.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { createSandboxFsBridge } from "./fs-bridge.js";
import { toSandboxProvisioningError } from "./provisioning-error.js";
import { readRegisteredSandboxRuntimeIds, updateRegistry } from "./registry.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { assertSshSandboxSecretOwnerAvailable } from "./secret-owner.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";
import type { SandboxContext, SandboxWorkspaceInfo } from "./types.js";
import { ensureSandboxWorkspace } from "./workspace.js";

async function syncSandboxSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: OpenClawConfig;
  agentId: string;
  rawSessionKey: string;
  execOverrides?: ExecPolicyOverrides;
}): Promise<{ eligibility?: SkillEligibilityContext; skillUsagePaths?: SkillUsagePath[] }> {
  try {
    const [
      { syncSkillsToWorkspace },
      { getRemoteSkillEligibility },
      { resolveNodeExecEligibility },
    ] = await Promise.all([
      import("../../skills/loading/workspace.js"),
      import("../../skills/runtime/remote.js"),
      import("../exec-defaults.js"),
    ]);
    const nodeSkills = resolveNodeExecEligibility({
      cfg: params.config,
      sessionKey: params.rawSessionKey,
      agentId: params.agentId,
      execOverrides: params.execOverrides,
    });
    const eligibility: SkillEligibilityContext = {
      nodeSkills,
      remote: getRemoteSkillEligibility({
        advertiseExecNode: nodeSkills.canExec,
      }),
    };
    const skillUsagePaths = await syncSkillsToWorkspace({
      sourceWorkspaceDir: params.sourceWorkspaceDir,
      targetWorkspaceDir: params.targetWorkspaceDir,
      config: params.config,
      agentId: params.agentId,
      eligibility,
    });
    return { eligibility, skillUsagePaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    defaultRuntime.error?.(`Sandbox skill sync failed: ${message}`);
    return {};
  }
}

type PreparedSandboxWorkspaceLayout = {
  agentWorkspaceDir: string;
  scopeKey: string;
  sandboxWorkspaceDir: string;
  skillsTargetWorkspaceDir: string;
  skillsWorkspaceDir: string;
  workspaceDir: string;
};

async function prepareSandboxWorkspaceLayout(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  rawSessionKey: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): Promise<PreparedSandboxWorkspaceLayout> {
  const { cfg, rawSessionKey } = params;
  const { agentWorkspaceDir, sandboxWorkspaceDir, scopeKey, skillsWorkspaceDir, workspaceDir } =
    resolveSandboxWorkspaceLayoutPaths({
      cfg,
      rawSessionKey,
      workspaceDir: params.workspaceDir,
    });

  if (cfg.workspaceAccess !== "rw") {
    await ensureSandboxWorkspace(
      sandboxWorkspaceDir,
      agentWorkspaceDir,
      params.config?.agents?.defaults?.skipBootstrap,
      params.config?.agents?.defaults?.skipOptionalBootstrapFiles,
    );
  } else {
    await fs.mkdir(workspaceDir, { recursive: true });
  }

  return {
    agentWorkspaceDir,
    scopeKey,
    sandboxWorkspaceDir,
    skillsTargetWorkspaceDir:
      cfg.workspaceAccess === "rw" ? skillsWorkspaceDir : sandboxWorkspaceDir,
    skillsWorkspaceDir,
    workspaceDir,
  };
}

async function materializeSandboxSkills(params: {
  layout: PreparedSandboxWorkspaceLayout;
  config?: OpenClawConfig;
  agentId: string;
  rawSessionKey: string;
  execOverrides?: ExecPolicyOverrides;
}) {
  return await syncSandboxSkillsToWorkspace({
    sourceWorkspaceDir: params.layout.agentWorkspaceDir,
    targetWorkspaceDir: params.layout.skillsTargetWorkspaceDir,
    config: params.config,
    agentId: params.agentId,
    rawSessionKey: params.rawSessionKey,
    execOverrides: params.execOverrides,
  });
}

function resolveSandboxSession(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: rawSessionKey,
  });
  if (!runtime.sandboxed) {
    return null;
  }

  const cfg = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  if (cfg.backend === "ssh") {
    // Never let an unresolved inline SSH credential silently fall through to
    // ambient host SSH identities for this agent.
    assertSshSandboxSecretOwnerAvailable({
      config: params.config,
      scope: cfg.scope,
      agentId: runtime.agentId,
    });
  }
  return { rawSessionKey, runtime, cfg };
}

function resolveSandboxWorkspaceInfoWorkdir(params: {
  cfg: ReturnType<typeof resolveSandboxConfigForAgent>;
  agentId: string;
  rawSessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir: string;
}): string | undefined {
  return getSandboxBackendWorkdirResolver(params.cfg.backend)?.({
    agentId: params.agentId,
    sessionKey: params.rawSessionKey,
    scopeKey: params.scopeKey,
    workspaceDir: params.workspaceDir,
    agentWorkspaceDir: params.agentWorkspaceDir,
    skillsWorkspaceDir: params.skillsWorkspaceDir,
    cfg: params.cfg,
  });
}

type ResolveSandboxContextParams = {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  requireCurrentConfig?: boolean;
  sessionKey?: string;
  workspaceDir?: string;
};

type ResolvedSandboxSession = NonNullable<ReturnType<typeof resolveSandboxSession>>;

async function resolveProvisionedSandboxContext(
  params: ResolveSandboxContextParams,
  resolved: ResolvedSandboxSession,
): Promise<SandboxContext> {
  const { rawSessionKey, cfg, runtime } = resolved;

  if (cfg.prune.idleHours !== 0 || cfg.prune.maxAgeDays !== 0) {
    await (await import("./prune.js")).maybePruneSandboxes(cfg);
  }

  const layout = await prepareSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const { agentWorkspaceDir, scopeKey, skillsWorkspaceDir, workspaceDir } = layout;

  let syncedSkills: Awaited<ReturnType<typeof materializeSandboxSkills>> = {};
  let materializationPromise: Promise<typeof syncedSkills> | undefined;
  let skillsMaterialized = false;
  const materializeSkills = async (): Promise<void> => {
    materializationPromise ??= materializeSandboxSkills({
      layout,
      config: params.config,
      agentId: runtime.agentId,
      rawSessionKey,
      execOverrides: params.execOverrides,
    });
    syncedSkills = await materializationPromise;
    skillsMaterialized = true;
  };

  const docker = await resolveSandboxDockerUser({
    backend: cfg.backend,
    docker: cfg.docker,
    workspaceDir,
  });
  const resolvedCfg = docker === cfg.docker ? cfg : { ...cfg, docker };

  const backendFactory = requireSandboxBackendFactory(resolvedCfg.backend);
  const backendDeferredSkills =
    getSandboxBackendSkillMaterializationMode(resolvedCfg.backend) === "backend-deferred";
  if (!backendDeferredSkills) {
    await materializeSkills();
  }
  const registeredRuntimeIds = await readRegisteredSandboxRuntimeIds({
    backendId: resolvedCfg.backend,
    scopeKey,
  });
  const backend = await backendFactory({
    agentId: runtime.agentId,
    sessionKey: rawSessionKey,
    scopeKey,
    ...(registeredRuntimeIds.length > 0 ? { registeredRuntimeIds } : {}),
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    ...(backendDeferredSkills ? { materializeSkills } : {}),
    cfg: resolvedCfg,
    ...(params.requireCurrentConfig !== undefined
      ? { requireCurrentConfig: params.requireCurrentConfig }
      : {}),
  });
  if (backendDeferredSkills && !backend.skillCatalog && !skillsMaterialized) {
    throw new Error(
      `Sandbox backend "${resolvedCfg.backend}" must materialize Gateway skills before returning a handle without skillCatalog.`,
    );
  }
  await updateRegistry({
    containerName: backend.runtimeId,
    backendId: backend.id,
    runtimeLabel: backend.runtimeLabel,
    sessionKey: scopeKey,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
    image: backend.configLabel ?? resolvedCfg.docker.image,
    configLabelKind: backend.configLabelKind ?? "Image",
  });

  const resolvedBrowserConfig = resolvedCfg.browser.enabled
    ? resolveBrowserConfig(params.config?.browser, params.config)
    : undefined;
  const evaluateEnabled =
    resolvedBrowserConfig?.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;

  const bridgeAuth = cfg.browser.enabled
    ? await (async () => {
        // Sandbox browser bridge server runs on a loopback TCP port; always wire up
        // the same auth that loopback browser clients will send (token/password).
        const cfgForAuth =
          params.config ?? (await import("../../config/config.js")).getRuntimeConfig();
        let browserAuth = resolveBrowserControlAuth(cfgForAuth);
        try {
          const ensured = await ensureBrowserControlAuth({ cfg: cfgForAuth });
          browserAuth = ensured.auth;
        } catch (error) {
          const message = error instanceof Error ? error.message : JSON.stringify(error);
          defaultRuntime.error?.(`Sandbox browser auth ensure failed: ${message}`);
        }
        return browserAuth;
      })()
    : undefined;
  if (resolvedCfg.browser.enabled && backend.capabilities?.browser !== true) {
    throw new Error(`Sandbox backend "${backend.id}" does not support browser sandboxes yet.`);
  }
  const browser =
    resolvedCfg.browser.enabled && backend.capabilities?.browser === true
      ? await ensureSandboxBrowser({
          scopeKey,
          workspaceDir,
          agentWorkspaceDir,
          skillsWorkspaceDir,
          cfg: resolvedCfg,
          evaluateEnabled,
          bridgeAuth,
          ssrfPolicy: resolvedBrowserConfig?.ssrfPolicy,
        })
      : null;

  const sandboxContext: SandboxContext = {
    enabled: true,
    backendId: backend.id,
    sessionKey: rawSessionKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
    ...(syncedSkills.eligibility ? { skillsEligibility: syncedSkills.eligibility } : {}),
    ...(syncedSkills.skillUsagePaths ? { skillUsagePaths: syncedSkills.skillUsagePaths } : {}),
    workspaceAccess: resolvedCfg.workspaceAccess,
    runtimeId: backend.runtimeId,
    runtimeLabel: backend.runtimeLabel,
    containerName: backend.runtimeId,
    containerWorkdir: backend.workdir,
    docker: resolvedCfg.docker,
    tools: resolvedCfg.tools,
    browserAllowHostControl: resolvedCfg.browser.allowHostControl,
    browser: browser ?? undefined,
    backend,
  };

  sandboxContext.fsBridge =
    backend.createFsBridge?.({ sandbox: sandboxContext }) ??
    createSandboxFsBridge({ sandbox: sandboxContext });

  return sandboxContext;
}

export async function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  agentId?: string;
  execOverrides?: ExecPolicyOverrides;
  requireCurrentConfig?: boolean;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  // Once a sandbox session is selected, every remaining step is local
  // provisioning. Preserve that owner boundary across backend, browser,
  // registry, and filesystem-bridge setup so model fallback never retries it.
  try {
    return await resolveProvisionedSandboxContext(params, resolved);
  } catch (error) {
    throw toSandboxProvisioningError(error, resolved.cfg.backend);
  }
}

export async function ensureSandboxWorkspaceForSession(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null> {
  const resolved = resolveSandboxSession(params);
  if (!resolved) {
    return null;
  }
  const { rawSessionKey, cfg, runtime } = resolved;

  const layout = await prepareSandboxWorkspaceLayout({
    cfg,
    rawSessionKey,
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const { agentWorkspaceDir, scopeKey, skillsWorkspaceDir, workspaceDir } = layout;
  const syncedSkills = await materializeSandboxSkills({
    layout,
    config: params.config,
    agentId: runtime.agentId,
    rawSessionKey,
  });

  const containerWorkdir = resolveSandboxWorkspaceInfoWorkdir({
    cfg,
    agentId: runtime.agentId,
    rawSessionKey,
    scopeKey,
    workspaceDir,
    agentWorkspaceDir,
    skillsWorkspaceDir,
  });
  return {
    workspaceDir,
    ...(containerWorkdir ? { containerWorkdir } : {}),
    skillsWorkspaceDir,
    ...(syncedSkills.eligibility ? { skillsEligibility: syncedSkills.eligibility } : {}),
    ...(syncedSkills.skillUsagePaths ? { skillUsagePaths: syncedSkills.skillUsagePaths } : {}),
    workspaceAccess: cfg.workspaceAccess,
  };
}
