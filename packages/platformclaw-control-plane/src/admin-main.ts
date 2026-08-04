#!/usr/bin/env node
import { runPlatformClawAdminCli } from "./admin-cli.js";

runPlatformClawAdminCli({ argv: process.argv.slice(2) }).catch((error: unknown) => {
  process.stderr.write(
    `PlatformClaw administrator update failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
