#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function runGit(repoRoot, args, options = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown Git error").trim();
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout;
}

function parseStageEntries(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, objectId, stage] = entry.slice(0, tab).split(" ");
      return { mode, objectId, stage, path: entry.slice(tab + 1) };
    });
}

function parseTreeEntries(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, , objectId] = entry.slice(0, tab).split(" ");
      return { mode, objectId, stage: "0", path: entry.slice(tab + 1) };
    });
}

function isWorkspaceDependencyLink(entry) {
  return entry.mode === "120000" && entry.path.split("/").includes("node_modules");
}

function listIndexEntries(repoRoot) {
  return new Map(
    parseStageEntries(runGit(repoRoot, ["ls-files", "--stage", "-z"])).map((entry) => [
      entry.path,
      entry,
    ]),
  );
}

function listHeadEntries(repoRoot) {
  return new Map(
    parseTreeEntries(runGit(repoRoot, ["ls-tree", "-r", "-z", "HEAD"])).map((entry) => [
      entry.path,
      entry,
    ]),
  );
}

function listSkipWorktreePaths(repoRoot, paths) {
  if (paths.length === 0) {
    return new Set();
  }
  // Unlike `-v`, `-t` does not lowercase the skip-worktree tag when the
  // independent assume-unchanged bit is also set.
  const output = runGit(repoRoot, ["ls-files", "-t", "-z", "--", ...paths]);
  return new Set(
    output
      .split("\0")
      .filter((entry) => entry.startsWith("S "))
      .map((entry) => entry.slice(2)),
  );
}

function getProtectedEntries(repoRoot) {
  const indexEntries = listIndexEntries(repoRoot);
  const headEntries = listHeadEntries(repoRoot);
  const protectedPaths = new Set();
  for (const [entryPath, entry] of [...headEntries, ...indexEntries]) {
    if (isWorkspaceDependencyLink(entry)) {
      protectedPaths.add(entryPath);
    }
  }
  const paths = [...protectedPaths].toSorted((left, right) => left.localeCompare(right));
  const mismatches = paths.filter((entryPath) => {
    const head = headEntries.get(entryPath);
    const index = indexEntries.get(entryPath);
    return !head || !index || head.mode !== index.mode || head.objectId !== index.objectId;
  });
  if (mismatches.length > 0) {
    throw new Error(
      `refusing to change guard while HEAD and index differ for: ${mismatches.join(", ")}`,
    );
  }
  return paths.map((entryPath) => indexEntries.get(entryPath));
}

function isLinkOrJunction(repoRoot, relativePath) {
  try {
    return lstatSync(path.join(repoRoot, ...relativePath.split("/"))).isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function installGuard(repoRoot) {
  const entries = getProtectedEntries(repoRoot);
  const paths = entries.map((entry) => entry.path);
  if (paths.length > 0) {
    runGit(repoRoot, ["update-index", "--skip-worktree", "--", ...paths]);
  }
  checkGuard(repoRoot);
  return paths;
}

export function checkGuard(repoRoot) {
  const entries = getProtectedEntries(repoRoot);
  const paths = entries.map((entry) => entry.path);
  const protectedPaths = listSkipWorktreePaths(repoRoot, paths);
  const missing = paths.filter((entryPath) => !protectedPaths.has(entryPath));
  if (missing.length > 0) {
    throw new Error(
      `Windows Git junction guard is missing for: ${missing.join(", ")}. Run this script with install.`,
    );
  }
  return paths;
}

export function removeGuard(repoRoot, platform = process.platform) {
  const entries = getProtectedEntries(repoRoot);
  const paths = entries.map((entry) => entry.path);
  if (platform === "win32") {
    const unsafe = paths.filter((entryPath) => isLinkOrJunction(repoRoot, entryPath));
    if (unsafe.length > 0) {
      throw new Error(
        `refusing to remove guard while Windows links or junctions exist: ${unsafe.join(", ")}`,
      );
    }
  }
  if (paths.length > 0) {
    runGit(repoRoot, ["update-index", "--no-skip-worktree", "--", ...paths]);
  }
  return paths;
}

function parseCli(argv) {
  const action = argv[0] ?? "check";
  let repoRoot = process.cwd();
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--repo" && argv[index + 1]) {
      repoRoot = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argv[index]}`);
  }
  return { action, repoRoot: path.resolve(repoRoot) };
}

function main() {
  const { action, repoRoot } = parseCli(process.argv.slice(2));
  let paths;
  if (action === "install") {
    paths = installGuard(repoRoot);
  } else if (action === "check") {
    paths = checkGuard(repoRoot);
  } else if (action === "remove") {
    paths = removeGuard(repoRoot);
  } else {
    throw new Error(`unknown action: ${action}`);
  }
  console.log(`[PlatformClaw] Windows Git junction guard ${action}: ${paths.length} paths`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[PlatformClaw] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
