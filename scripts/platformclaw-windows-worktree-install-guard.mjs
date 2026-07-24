#!/usr/bin/env node

import { lstatSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function assertSafeWindowsInstall({
  platform = process.platform,
  repoRoot = process.cwd(),
} = {}) {
  if (platform !== "win32") {
    return;
  }

  const gitMetadata = lstatSync(path.join(repoRoot, ".git"), { throwIfNoEntry: false });
  if (gitMetadata?.isFile()) {
    throw new Error(
      "pnpm install is blocked in Windows linked worktrees because workspace junctions can let Git delete the worktree. Use the primary checkout toolchain or remote validation.",
    );
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    assertSafeWindowsInstall();
  } catch (error) {
    console.error(`[PlatformClaw] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
