#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  containsAuthoredInclude,
  isSingleTopLevelIncludeMigration,
} from "../src/commands/doctor/shared/include-migration-ownership.js";
import { migrateLegacyConfig } from "../src/commands/doctor/shared/legacy-config-migrate.js";
import { createConfigIO, replaceConfigFile } from "../src/config/config.js";

function readConfigPath(argv) {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error("Usage: platformclaw-windows-config-migrate.mjs --config <path>");
  }
  return path.resolve(value);
}

export async function migrateWindowsPreviewConfig(configPath) {
  const resolvedConfigPath = path.resolve(configPath);
  const io = createConfigIO({
    configPath: resolvedConfigPath,
    pluginValidation: "skip",
  });
  const prepared = await io.readConfigFileSnapshotForWrite();
  const { snapshot } = prepared;
  if (!snapshot.exists || snapshot.raw === null) {
    throw new Error(`Managed preview config does not exist: ${resolvedConfigPath}`);
  }
  if (snapshot.issues.some((issue) => issue.message.startsWith("JSON5 parse failed:"))) {
    throw new Error(`Unable to parse managed preview config ${resolvedConfigPath}`);
  }

  const migrationSource = snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig;
  const migrationSnapshot =
    snapshot.sourceConfigBeforeMigrations === undefined
      ? snapshot
      : { ...snapshot, sourceConfig: migrationSource, resolved: migrationSource };
  const migrated = migrateLegacyConfig(migrationSource);
  if (!migrated.config) {
    return { migrated: false, changes: [] };
  }
  const migratedAgentEntries = migrated.changes.includes(
    "Moved agents.list → keyed agents.entries.",
  );

  const hasAuthoredIncludes = containsAuthoredInclude(snapshot.parsed);
  // Persist the authored migration shape, not validation-expanded defaults.
  const nextConfig = migrated.sourceConfig ?? migrated.config;
  if (
    hasAuthoredIncludes &&
    !isSingleTopLevelIncludeMigration({
      parsed: snapshot.parsed,
      sourceConfig: migrationSource,
      candidate: nextConfig,
    })
  ) {
    throw new Error(
      "Managed preview config needs migrations across multiple included sections; run openclaw doctor --fix.",
    );
  }

  await replaceConfigFile({
    nextConfig,
    baseHash: snapshot.hash,
    snapshot: migrationSnapshot,
    io,
    writeOptions: {
      ...prepared.writeOptions,
      auditOrigin: "doctor",
      allowConfigSizeDrop: true,
      ...(migratedAgentEntries ? { explicitSetPaths: [["agents", "entries"]] } : {}),
      skipOutputLogs: true,
      skipPluginValidation: true,
    },
  });

  return { migrated: true, changes: migrated.changes };
}

async function main() {
  const configPath = readConfigPath(process.argv.slice(2));
  const result = await migrateWindowsPreviewConfig(configPath);
  if (!result.migrated) {
    console.log("PlatformClaw Windows preview config is current.");
    return;
  }
  console.log("Migrated saved PlatformClaw Windows preview config:");
  for (const change of result.changes) {
    console.log(`- ${change}`);
  }
  console.log("Canonical OpenClaw backup rotation applied.");
}

/** @param {unknown} error */
function reportError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch(reportError);
}
