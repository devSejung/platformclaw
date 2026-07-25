#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function reconcileManagedSandboxImage(config, sandboxImage) {
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

async function main() {
  const [configPath, sandboxImage] = process.argv.slice(2);
  if (!configPath || !sandboxImage) {
    throw new Error("usage: reconcile-managed-config.mjs <config-path> <sandbox-image>");
  }
  const source = JSON.parse(await readFile(configPath, "utf8"));
  const result = reconcileManagedSandboxImage(source, sandboxImage);
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
