#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sandboxPolicyDeniesBundleMcp } from "./validate-managed-config.mjs";

const MCP_DENY_MIGRATION_ERROR =
  "Existing sandbox tool deny policy blocks managed global MCP; remove bundle-mcp, matching wildcards, or group:plugins before upgrading PlatformClaw";

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

function reconcileRequiredPlugins(config) {
  const entries = config?.plugins?.entries;
  if (entries?.knox?.enabled === true) {
    return { config, changed: false };
  }
  return {
    changed: true,
    config: {
      ...config,
      plugins: {
        ...config?.plugins,
        entries: {
          ...entries,
          knox: { ...entries?.knox, enabled: true },
        },
      },
    },
  };
}

export function reconcileManagedConfig(config, sandboxImage) {
  const imageResult = reconcileSandboxImage(config, sandboxImage);
  const mcpResult = reconcileGlobalMcpSandboxGate(imageResult.config);
  const pluginResult = reconcileRequiredPlugins(mcpResult.config);
  return {
    config: pluginResult.config,
    changed: imageResult.changed || mcpResult.changed || pluginResult.changed,
  };
}

async function main() {
  const [configPath, sandboxImage] = process.argv.slice(2);
  if (!configPath || !sandboxImage) {
    throw new Error("usage: reconcile-managed-config.mjs <config-path> <sandbox-image>");
  }
  const source = JSON.parse(await readFile(configPath, "utf8"));
  const result = reconcileManagedConfig(source, sandboxImage);
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
