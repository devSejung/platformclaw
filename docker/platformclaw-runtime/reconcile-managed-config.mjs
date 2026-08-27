#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_MANAGED_PLUGIN_IDS,
  sandboxPolicyDeniesBundleMcp,
} from "./validate-managed-config.mjs";

const MCP_DENY_MIGRATION_ERROR =
  "Existing sandbox tool deny policy blocks managed global MCP; remove bundle-mcp, matching wildcards, or group:plugins before upgrading PlatformClaw";
const MANAGED_DISABLED_AGENT_TOOLS = ["group:nodes"];

function reconcileSkillHubArchiveInstallPolicy(config, skillHubEnabled) {
  if (!skillHubEnabled) {
    return { config, changed: false };
  }
  const skills = config?.skills;
  const install = skills?.install;
  if (install?.allowUploadedArchives === true) {
    return { config, changed: false };
  }
  // Preserve operator-owned skill and installer tuning. Malformed non-object
  // values remain untouched so validation fails instead of masking bad config.
  if (
    (skills !== undefined && (!skills || typeof skills !== "object" || Array.isArray(skills))) ||
    (install !== undefined && (!install || typeof install !== "object" || Array.isArray(install)))
  ) {
    return { config, changed: false };
  }
  return {
    changed: true,
    config: {
      ...config,
      skills: {
        ...skills,
        install: { ...install, allowUploadedArchives: true },
      },
    },
  };
}

const MANAGED_MEMORY_WIKI_CONFIG = {
  vaultMode: "bridge",
  vault: {
    scope: "agent",
    path: "~/.openclaw/wiki",
    renderMode: "native",
  },
  obsidian: {
    enabled: false,
    useOfficialCli: false,
  },
  bridge: {
    enabled: true,
    readMemoryArtifacts: true,
  },
  search: {
    backend: "shared",
    corpus: "wiki",
  },
  unsafeLocal: {
    allowPrivateMemoryCoreAccess: false,
    paths: [],
  },
};

function isRequiredPluginId(value) {
  return (
    typeof value === "string" && REQUIRED_MANAGED_PLUGIN_IDS.includes(value.trim().toLowerCase())
  );
}

function reconcileSandboxImage(config, sandboxImage) {
  const docker = config?.agents?.defaults?.sandbox?.docker;
  if (!docker || typeof docker !== "object" || Array.isArray(docker)) {
    return { config, changed: false };
  }
  if (docker.image === sandboxImage) {
    return { config, changed: false };
  }
  return {
    changed: true,
    config: {
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents.defaults,
          sandbox: {
            ...config.agents.defaults.sandbox,
            docker: { ...docker, image: sandboxImage },
          },
        },
      },
    },
  };
}

function reconcileSandboxToolPolicy(sandboxTools, createWhenMissing) {
  if (!sandboxTools || typeof sandboxTools !== "object" || Array.isArray(sandboxTools)) {
    return createWhenMissing
      ? { policy: { alsoAllow: ["bundle-mcp"] }, changed: true }
      : { policy: sandboxTools, changed: false };
  }
  // Upstream defines `allow: []` as unrestricted. Adding one item would turn
  // it into a restrictive allowlist and silently remove unrelated tools.
  if (Array.isArray(sandboxTools?.allow) && sandboxTools.allow.length === 0) {
    return { policy: sandboxTools, changed: false };
  }
  const allowKey = Array.isArray(sandboxTools?.allow) ? "allow" : "alsoAllow";
  const currentAllow = sandboxTools?.[allowKey];
  if (currentAllow !== undefined && !Array.isArray(currentAllow)) {
    return { policy: sandboxTools, changed: false };
  }
  if (currentAllow?.includes("bundle-mcp")) {
    return { policy: sandboxTools, changed: false };
  }
  return {
    policy: {
      ...sandboxTools,
      [allowKey]: [...(currentAllow ?? []), "bundle-mcp"],
    },
    changed: true,
  };
}

function sandboxPolicyAllowsBundleMcp(globalPolicy, agentPolicy) {
  const allow = Array.isArray(agentPolicy?.allow) ? agentPolicy.allow : globalPolicy?.allow;
  const alsoAllow = Array.isArray(agentPolicy?.alsoAllow)
    ? agentPolicy.alsoAllow
    : globalPolicy?.alsoAllow;
  return (
    (Array.isArray(allow) && allow.length === 0) ||
    allow?.includes("bundle-mcp") ||
    alsoAllow?.includes("bundle-mcp")
  );
}

function reconcileGlobalMcpSandboxGate(config) {
  const rootResult = reconcileSandboxToolPolicy(config?.tools?.sandbox?.tools, true);
  if (sandboxPolicyDeniesBundleMcp(rootResult.policy)) {
    throw new Error(MCP_DENY_MIGRATION_ERROR);
  }
  let entriesChanged = false;
  const entries = Object.fromEntries(
    Object.entries(config?.agents?.entries ?? {}).map(([agentId, agent]) => {
      const policy = agent?.tools?.sandbox?.tools;
      const effectiveDenyPolicy = {
        deny: Array.isArray(policy?.deny) ? policy.deny : rootResult.policy?.deny,
      };
      if (sandboxPolicyDeniesBundleMcp(effectiveDenyPolicy)) {
        throw new Error(`${MCP_DENY_MIGRATION_ERROR} (agent: ${agentId})`);
      }
      if (policy === undefined || sandboxPolicyAllowsBundleMcp(rootResult.policy, policy)) {
        return [agentId, agent];
      }
      const result = reconcileSandboxToolPolicy(policy, false);
      if (!result.changed) {
        return [agentId, agent];
      }
      entriesChanged = true;
      return [
        agentId,
        {
          ...agent,
          tools: {
            ...agent.tools,
            sandbox: {
              ...agent.tools.sandbox,
              tools: result.policy,
            },
          },
        },
      ];
    }),
  );
  if (!rootResult.changed && !entriesChanged) {
    return { config, changed: false };
  }
  return {
    changed: true,
    config: {
      ...config,
      ...(entriesChanged ? { agents: { ...config.agents, entries } } : {}),
      ...(rootResult.changed
        ? {
            tools: {
              ...config.tools,
              sandbox: {
                ...config.tools?.sandbox,
                tools: rootResult.policy,
              },
            },
          }
        : {}),
    },
  };
}

function reconcileManagedAgentToolPolicy(config) {
  const tools = config?.tools && typeof config.tools === "object" ? config.tools : {};
  const currentDeny = Array.isArray(tools.deny) ? tools.deny : [];
  const normalizedDeny = new Set(
    currentDeny.flatMap((entry) => (typeof entry === "string" ? [entry.trim().toLowerCase()] : [])),
  );
  const missing = MANAGED_DISABLED_AGENT_TOOLS.filter((toolName) => !normalizedDeny.has(toolName));
  if (missing.length === 0 && Array.isArray(tools.deny)) {
    return { config, changed: false };
  }
  return {
    changed: true,
    config: {
      ...config,
      tools: {
        ...tools,
        deny: [...currentDeny, ...missing],
      },
    },
  };
}

function reconcileRequiredPlugins(config) {
  const plugins = config?.plugins ?? {};
  const entries = plugins.entries ?? {};
  const memoryWikiEntry = entries["memory-wiki"] ?? {};
  const memoryWikiConfig = memoryWikiEntry.config ?? {};
  const memoryCoreEntry = entries["memory-core"] ?? {};
  const memoryCoreConfig = memoryCoreEntry.config ?? {};
  const memoryCoreDreaming = memoryCoreConfig.dreaming ?? {};
  const canvasEntry = entries.canvas ?? {};
  const canvasConfig = canvasEntry.config ?? {};
  const canvasHost = canvasConfig.host ?? {};
  const nextEntries = {
    ...entries,
    ...Object.fromEntries(
      REQUIRED_MANAGED_PLUGIN_IDS.map((pluginId) => [
        pluginId,
        { ...entries[pluginId], enabled: true },
      ]),
    ),
    canvas: {
      ...canvasEntry,
      enabled: false,
      config: {
        ...canvasConfig,
        host: { ...canvasHost, enabled: true },
      },
    },
    "memory-wiki": {
      ...memoryWikiEntry,
      enabled: true,
      config: {
        ...memoryWikiConfig,
        ...MANAGED_MEMORY_WIKI_CONFIG,
        vault: { ...memoryWikiConfig.vault, ...MANAGED_MEMORY_WIKI_CONFIG.vault },
        obsidian: { ...memoryWikiConfig.obsidian, ...MANAGED_MEMORY_WIKI_CONFIG.obsidian },
        bridge: { ...memoryWikiConfig.bridge, ...MANAGED_MEMORY_WIKI_CONFIG.bridge },
        search: { ...memoryWikiConfig.search, ...MANAGED_MEMORY_WIKI_CONFIG.search },
        unsafeLocal: {
          ...memoryWikiConfig.unsafeLocal,
          ...MANAGED_MEMORY_WIKI_CONFIG.unsafeLocal,
        },
      },
    },
    "memory-core": {
      ...memoryCoreEntry,
      enabled: true,
      config: {
        ...memoryCoreConfig,
        dreaming: {
          ...memoryCoreDreaming,
          enabled: true,
          frequency: "0 3 * * *",
        },
      },
    },
  };
  const currentAllow = Array.isArray(plugins.allow) ? plugins.allow : undefined;
  const nextAllow =
    currentAllow && currentAllow.length > 0
      ? [...new Set([...currentAllow, ...REQUIRED_MANAGED_PLUGIN_IDS])]
      : currentAllow;
  const currentDeny = Array.isArray(plugins.deny) ? plugins.deny : undefined;
  const nextDeny = currentDeny?.filter((pluginId) => !isRequiredPluginId(pluginId));
  const nextPlugins = {
    ...plugins,
    ...(plugins.enabled === false ? { enabled: true } : {}),
    slots: { ...plugins.slots, memory: "memory-core" },
    ...(nextAllow ? { allow: nextAllow } : {}),
    ...(nextDeny ? { deny: nextDeny } : {}),
    entries: nextEntries,
  };
  if (JSON.stringify(nextPlugins) === JSON.stringify(plugins)) {
    return { config, changed: false };
  }
  return {
    changed: true,
    config: {
      ...config,
      plugins: nextPlugins,
    },
  };
}

export function reconcileManagedConfig(config, sandboxImage, skillHubEnabled = false) {
  const imageResult = reconcileSandboxImage(config, sandboxImage);
  const mcpResult = reconcileGlobalMcpSandboxGate(imageResult.config);
  const toolResult = reconcileManagedAgentToolPolicy(mcpResult.config);
  const pluginResult = reconcileRequiredPlugins(toolResult.config);
  const skillHubResult = reconcileSkillHubArchiveInstallPolicy(
    pluginResult.config,
    skillHubEnabled,
  );
  return {
    config: skillHubResult.config,
    changed:
      imageResult.changed ||
      mcpResult.changed ||
      toolResult.changed ||
      pluginResult.changed ||
      skillHubResult.changed,
  };
}

async function main() {
  const [configPath, sandboxImage, skillHubEnabledValue] = process.argv.slice(2);
  if (!configPath || !sandboxImage || !["true", "false"].includes(skillHubEnabledValue)) {
    throw new Error(
      "usage: reconcile-managed-config.mjs <config-path> <sandbox-image> <skillhub-enabled>",
    );
  }
  const source = JSON.parse(await readFile(configPath, "utf8"));
  const result = reconcileManagedConfig(source, sandboxImage, skillHubEnabledValue === "true");
  if (!result.changed) {
    return;
  }
  const temporaryPath = path.join(
    path.dirname(configPath),
    `.${path.basename(configPath)}.${process.pid}.tmp`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(result.config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, configPath);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
