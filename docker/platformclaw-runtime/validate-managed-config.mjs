#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const POLICY_ERROR =
  "Existing OpenClaw config does not match the managed PlatformClaw execution policy; update it before exposing traffic";

export const REQUIRED_MANAGED_PLUGIN_IDS = [
  "admin-http-rpc",
  "knox",
  "memory-core",
  "memory-wiki",
  "platformclaw-execution",
  "platformclaw-user-mcp",
];

function normalizedPluginIds(value) {
  return Array.isArray(value)
    ? value.flatMap((pluginId) =>
        typeof pluginId === "string" ? [pluginId.trim().toLowerCase()] : [],
      )
    : [];
}

function requirePolicy(condition) {
  if (!condition) {
    throw new Error(POLICY_ERROR);
  }
}

function resolveManagedWikiRuntimePath() {
  const home =
    process.env.OPENCLAW_HOME?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    os.homedir();
  return path.resolve(home, ".openclaw", "wiki");
}

function validateDockerPolicy(docker, sandboxImage) {
  requirePolicy(docker?.image === sandboxImage);
  requirePolicy(docker?.network === "bridge");
  requirePolicy(docker?.user === "0:0");
  requirePolicy(docker?.readOnlyRoot !== false);
  requirePolicy(
    docker?.capDrop === undefined ||
      (Array.isArray(docker.capDrop) && docker.capDrop.length === 1 && docker.capDrop[0] === "ALL"),
  );
  requirePolicy(!Array.isArray(docker?.binds) || docker.binds.length === 0);
  requirePolicy(docker?.dangerouslyAllowReservedContainerTargets !== true);
  requirePolicy(docker?.dangerouslyAllowExternalBindSources !== true);
  requirePolicy(docker?.dangerouslyAllowContainerNamespaceJoin !== true);
}

function validateSandboxPolicy(sandbox, sandboxImage, allowedBackends) {
  requirePolicy(sandbox?.mode === "all");
  requirePolicy(allowedBackends.has(sandbox?.backend));
  requirePolicy(sandbox?.scope === "agent");
  requirePolicy(sandbox?.workspaceAccess === "rw");
  validateDockerPolicy(sandbox?.docker, sandboxImage);
  requirePolicy(sandbox?.browser?.allowHostControl !== true);
  requirePolicy(!Array.isArray(sandbox?.browser?.binds) || sandbox.browser.binds.length === 0);
}

function validateToolPolicy(tools) {
  requirePolicy(tools?.elevated?.enabled !== true);
  requirePolicy(
    tools?.exec?.host === undefined || tools.exec.host === "auto" || tools.exec.host === "sandbox",
  );
}

function globMatches(value, rawPattern) {
  const pattern = String(rawPattern).trim().toLowerCase();
  if (!pattern) {
    return false;
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(value);
}

export function sandboxPolicyDeniesBundleMcp(sandboxTools) {
  const deny = Array.isArray(sandboxTools?.deny) ? sandboxTools.deny : [];
  return deny.some(
    (entry) =>
      String(entry).trim().toLowerCase() === "group:plugins" || globMatches("bundle-mcp", entry),
  );
}

function validateGlobalMcpSandboxGate(sandboxTools) {
  const allow = Array.isArray(sandboxTools?.allow) ? sandboxTools.allow : [];
  const alsoAllow = Array.isArray(sandboxTools?.alsoAllow) ? sandboxTools.alsoAllow : [];
  const allowsBundleMcp =
    (Array.isArray(sandboxTools?.allow) && allow.length === 0) ||
    allow.includes("bundle-mcp") ||
    alsoAllow.includes("bundle-mcp");
  requirePolicy(allowsBundleMcp && !sandboxPolicyDeniesBundleMcp(sandboxTools));
}

function effectiveSandboxTools(globalTools, agentTools) {
  return Object.fromEntries(
    ["allow", "alsoAllow", "deny"].flatMap((key) => {
      const value = Array.isArray(agentTools?.[key]) ? agentTools[key] : globalTools?.[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

function mergeSandboxPolicy(defaults, override) {
  return {
    ...defaults,
    ...override,
    docker: {
      ...defaults?.docker,
      ...override?.docker,
    },
  };
}

export function validateManagedConfig(config, sandboxImage) {
  const defaults = config?.agents?.defaults?.sandbox;
  validateSandboxPolicy(defaults, sandboxImage, new Set(["platformclaw-execution"]));
  validateToolPolicy(config?.tools);
  const globalSandboxTools = config?.tools?.sandbox?.tools;
  validateGlobalMcpSandboxGate(globalSandboxTools);

  const entries = config?.agents?.entries;
  requirePolicy(entries === undefined || (entries !== null && typeof entries === "object"));
  const projectedList = config?.agents?.list;
  requirePolicy(projectedList === undefined || Array.isArray(projectedList));
  // Current upstream persists `entries` and materializes a non-enumerable `list`
  // projection. Checking both keeps this gate aligned with the effective runtime.
  const configuredAgents = [
    ...Object.values(entries ?? {}),
    ...(Array.isArray(projectedList) ? projectedList : []),
  ];
  for (const agent of configuredAgents) {
    validateToolPolicy(agent?.tools);
    validateGlobalMcpSandboxGate(
      effectiveSandboxTools(globalSandboxTools, agent?.tools?.sandbox?.tools),
    );
    if (agent?.sandbox === undefined) {
      continue;
    }
    const effective = mergeSandboxPolicy(defaults, agent.sandbox);
    // Personal agents use the execution backend; Knox room agents may select
    // Docker directly. Both remain isolated and share the same bridge policy.
    validateSandboxPolicy(effective, sandboxImage, new Set(["platformclaw-execution", "docker"]));
  }

  const plugins = config?.plugins?.entries;
  requirePolicy(config?.plugins?.enabled !== false);
  requirePolicy(config?.plugins?.slots?.memory === "memory-core");
  for (const pluginId of REQUIRED_MANAGED_PLUGIN_IDS) {
    requirePolicy(plugins?.[pluginId]?.enabled === true);
  }
  const pluginAllow = config?.plugins?.allow;
  requirePolicy(
    !Array.isArray(pluginAllow) ||
      pluginAllow.length === 0 ||
      REQUIRED_MANAGED_PLUGIN_IDS.every((pluginId) => pluginAllow.includes(pluginId)),
  );
  const pluginDeny = normalizedPluginIds(config?.plugins?.deny);
  requirePolicy(REQUIRED_MANAGED_PLUGIN_IDS.every((pluginId) => !pluginDeny.includes(pluginId)));

  const wiki = plugins?.["memory-wiki"]?.config;
  requirePolicy(wiki?.vaultMode === "bridge");
  requirePolicy(wiki?.vault?.scope === "agent");
  // The seed/reconciler owns the portable `~` form, while loadConfig expands
  // path-like fields before this runtime gate sees them.
  requirePolicy(
    wiki?.vault?.path === "~/.openclaw/wiki" ||
      wiki?.vault?.path === resolveManagedWikiRuntimePath(),
  );
  requirePolicy(wiki?.vault?.renderMode === "native");
  requirePolicy(wiki?.bridge?.enabled === true);
  requirePolicy(wiki?.bridge?.readMemoryArtifacts === true);
  requirePolicy(wiki?.search?.backend === "shared");
  requirePolicy(wiki?.search?.corpus === "wiki");
  requirePolicy(wiki?.obsidian?.enabled === false);
  requirePolicy(wiki?.obsidian?.useOfficialCli === false);
  requirePolicy(wiki?.unsafeLocal?.allowPrivateMemoryCoreAccess === false);
  requirePolicy(Array.isArray(wiki?.unsafeLocal?.paths) && wiki.unsafeLocal.paths.length === 0);

  const memoryCoreDreaming = plugins?.["memory-core"]?.config?.dreaming;
  requirePolicy(memoryCoreDreaming?.enabled === true);
  requirePolicy(memoryCoreDreaming?.frequency === "0 3 * * *");
}

async function main() {
  const [sandboxImage] = process.argv.slice(2);
  if (!sandboxImage) {
    throw new Error("usage: validate-managed-config.mjs <sandbox-image>");
  }
  const { loadConfig } = await import("/app/dist/config/config.js");
  validateManagedConfig(loadConfig({ pin: false }), sandboxImage);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
