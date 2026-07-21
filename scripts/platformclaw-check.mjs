#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import {
  classifyPlatformClawRange,
  classifyPlatformClawWorktree,
  listPlatformClawUntrackedFiles,
  resolvePlatformClawBase,
} from "./platformclaw-ci-plan.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const node = process.execPath;
const oxfmt = resolve(repoRoot, "node_modules", "oxfmt", "bin", "oxfmt");

const FORMAT_PATHS = [
  "packages/platformclaw-control-plane",
  "extensions/admin-http-rpc",
  "scripts/platformclaw-check.d.mts",
  "scripts/platformclaw-ci-plan.d.mts",
  "scripts/platformclaw-*.mjs",
  "test/scripts/platformclaw-*.test.ts",
  ".github/workflows/platformclaw-*.yml",
  "docs/platformclaw",
  "ui/platformclaw-*.html",
  "ui/src/platformclaw",
  "ui/vite.platformclaw-login.config.ts",
];

const command = (label, executable, args) => ({ label, executable, args });

const SURFACE_COMMANDS = {
  "admin-http-rpc": [
    command("lint admin HTTP RPC", node, [
      "scripts/run-oxlint.mjs",
      "--tsconfig",
      "config/tsconfig/oxlint.core.json",
      "extensions/admin-http-rpc",
    ]),
    command("typecheck admin HTTP RPC", node, [
      "scripts/run-tsgo.mjs",
      "-p",
      "extensions/admin-http-rpc/tsconfig.platformclaw.json",
      "--noEmit",
    ]),
    command("typecheck admin HTTP RPC tests", node, [
      "scripts/run-tsgo.mjs",
      "-p",
      "extensions/admin-http-rpc/tsconfig.platformclaw.test.json",
      "--noEmit",
    ]),
    command("test admin HTTP RPC", node, ["scripts/run-vitest.mjs", "extensions/admin-http-rpc"]),
  ],
  "control-plane": [
    command("lint control plane", node, [
      "scripts/run-oxlint.mjs",
      "--tsconfig",
      "config/tsconfig/oxlint.core.json",
      "packages/platformclaw-control-plane/src",
    ]),
    command("typecheck control plane", node, [
      "scripts/run-tsgo.mjs",
      "-p",
      "packages/platformclaw-control-plane/tsconfig.json",
      "--noEmit",
    ]),
    command("test control plane", node, [
      "scripts/run-vitest.mjs",
      "packages/platformclaw-control-plane/src",
    ]),
    command("build control plane", "corepack", [
      "pnpm",
      "--dir",
      "packages/platformclaw-control-plane",
      "build",
    ]),
  ],
  planner: [
    command("lint PlatformClaw CI planner", node, [
      "scripts/run-oxlint.mjs",
      "--tsconfig",
      "config/tsconfig/oxlint.core.json",
      "scripts/platformclaw-check.d.mts",
      "scripts/platformclaw-check.mjs",
      "scripts/platformclaw-ci-plan.d.mts",
      "scripts/platformclaw-ci-plan.mjs",
      "test/scripts/platformclaw-check.test.ts",
      "test/scripts/platformclaw-ci-plan.test.ts",
    ]),
    command("validate script declarations", node, ["scripts/check-script-declarations.mjs"]),
    command("test PlatformClaw CI planner", node, [
      "scripts/run-vitest.mjs",
      "test/scripts/platformclaw-check.test.ts",
      "test/scripts/platformclaw-ci-plan.test.ts",
      "test/scripts/platformclaw-runtime-docker.test.ts",
    ]),
  ],
  ui: [
    command("verify UI translations", "corepack", ["pnpm", "ui:i18n:verify"]),
    command("typecheck UI", node, ["scripts/run-tsgo.mjs", "-p", "tsconfig.ui.json", "--noEmit"]),
    command("lint PlatformClaw UI", node, [
      "scripts/run-oxlint.mjs",
      "--tsconfig",
      "config/tsconfig/oxlint.core.json",
      "ui/src/platformclaw",
      "ui/vite.config.ts",
      "ui/vite.platformclaw-login.config.ts",
    ]),
    command("test PlatformClaw UI", node, ["scripts/run-vitest.mjs", "ui/src/platformclaw"]),
    command("build UI", "corepack", ["pnpm", "--dir", "ui", "build"]),
  ],
};

const QUICK_SKIP_LABELS = new Set(["build control plane", "build UI"]);

export function createPlatformClawCheckCommands(surfaces, options = {}) {
  const selected = [...new Set(surfaces)];
  const unknown = selected.filter((surface) => !Object.hasOwn(SURFACE_COMMANDS, surface));
  if (unknown.length > 0) {
    throw new Error(`unknown PlatformClaw check surface: ${unknown.join(", ")}`);
  }
  return selected
    .flatMap((surface) => SURFACE_COMMANDS[surface])
    .filter((entry) => !options.quick || !QUICK_SKIP_LABELS.has(entry.label));
}

export function surfacesForPlan(plan) {
  const surfaces = [];
  if (plan.needs_package_checks) {
    surfaces.push("control-plane");
  }
  if (plan.needs_admin_http_rpc_checks) {
    surfaces.push("admin-http-rpc");
  }
  if (plan.needs_planner_tests) {
    surfaces.push("planner");
  }
  if (plan.needs_ui_checks) {
    surfaces.push("ui");
  }
  return surfaces;
}

export function findPatchWhitespaceErrors(text) {
  const errors = [];
  for (const [index, rawLine] of text.split("\n").entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (/[\t ]+$/u.test(line)) {
      errors.push({ line: index + 1, reason: "trailing whitespace" });
    }
    if (/^(?:<{7}|={7}|>{7})(?: |$)/u.test(line)) {
      errors.push({ line: index + 1, reason: "conflict marker" });
    }
  }
  return errors;
}

function checkUntrackedWhitespace(paths) {
  process.stdout.write("\n[platformclaw:check] check untracked file whitespace\n");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const failures = [];
  for (const path of paths) {
    const contents = readFileSync(resolve(repoRoot, path));
    if (contents.includes(0)) {
      continue;
    }
    let text;
    try {
      text = decoder.decode(contents);
    } catch {
      continue;
    }
    for (const error of findPatchWhitespaceErrors(text)) {
      failures.push(`${path}:${String(error.line)}: ${error.reason}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`untracked file whitespace errors:\n${failures.join("\n")}`);
  }
}

function parseArgs(argv) {
  const options = {
    base: "origin/main",
    changed: false,
    head: undefined,
    quick: false,
    surfaces: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--surface") {
      options.surfaces.push(argv[++index]);
    } else if (arg === "--changed") {
      options.changed = true;
    } else if (arg === "--base" || arg === "--head") {
      options[arg.slice(2)] = argv[++index];
    } else if (arg === "--quick") {
      options.quick = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.surfaces.some((surface) => !surface)) {
    throw new Error("--surface requires a value");
  }
  if (!options.changed && options.surfaces.length === 0) {
    throw new Error("use --changed or at least one --surface");
  }
  for (const revision of [options.base, options.head].filter(Boolean)) {
    if (!/^[A-Za-z0-9_./^~:@{}-]+$/u.test(revision)) {
      throw new Error(`unsafe git revision: ${revision}`);
    }
  }
  return options;
}

function run(entry, options = {}) {
  process.stdout.write(`\n[platformclaw:check] ${entry.label}\n`);
  const result = spawnSync(entry.executable, entry.args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...(options.quick ? { OPENCLAW_OXLINT_SKIP_PREPARE: "1" } : {}),
    },
    shell:
      process.platform === "win32" &&
      (entry.executable.endsWith(".cmd") || entry.executable === "corepack"),
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${entry.label} failed with exit code ${String(result.status)}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let surfaces = options.surfaces;
  let plan;
  const comparisonBase = options.head
    ? resolvePlatformClawBase(options.base, options.head)
    : options.base;
  if (options.changed) {
    plan = options.head
      ? classifyPlatformClawRange(comparisonBase, options.head)
      : classifyPlatformClawWorktree(comparisonBase);
    surfaces = [...surfaces, ...surfacesForPlan(plan)];
    const whitespaceArgs = options.head
      ? ["diff", "--check", `${comparisonBase}...${String(options.head)}`]
      : ["diff", "--check", comparisonBase];
    run(command("check patch whitespace", "git", whitespaceArgs), options);
    if (!options.head) {
      checkUntrackedWhitespace(listPlatformClawUntrackedFiles());
    }
    if (plan.needs_format_check) {
      run(
        command("check PlatformClaw formatting", node, [oxfmt, "--check", ...FORMAT_PATHS]),
        options,
      );
    }
  }
  for (const entry of createPlatformClawCheckCommands(surfaces, options)) {
    run(entry, options);
  }
  if (plan?.needs_changed_surface_checks) {
    if (options.quick) {
      process.stdout.write(
        "\n[platformclaw:check] quick mode skips upstream changed-surface checks\n",
      );
    } else {
      run(
        command("run upstream changed-surface checks", "corepack", [
          "pnpm",
          "check:changed",
          "--base",
          comparisonBase,
          ...(options.head ? ["--head", options.head] : []),
        ]),
        options,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main();
}
