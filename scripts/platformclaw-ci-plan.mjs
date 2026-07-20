#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXACT_OVERLAY_PATHS = new Set([
  ".github/workflows/platformclaw-ci.yml",
  ".github/workflows/platformclaw-full-ci.yml",
  "PLATFORMCLAW.md",
  "scripts/platformclaw-ci-plan.d.mts",
  "scripts/platformclaw-ci-plan.mjs",
  "test/scripts/platformclaw-ci-plan.test.ts",
]);

const OVERLAY_PREFIXES = [
  "docs/platformclaw/",
  "packages/platformclaw-control-plane/",
  "ui/src/platformclaw/",
];

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isOverlayPath(file) {
  return (
    EXACT_OVERLAY_PATHS.has(file) ||
    OVERLAY_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    file.startsWith("docker/platformclaw-") ||
    file.startsWith("scripts/platformclaw-") ||
    file.startsWith("ui/platformclaw-")
  );
}

export function classifyPlatformClawChanges(inputFiles) {
  const files = [...new Set(inputFiles.map(normalizePath).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const hasChanges = files.length > 0;
  const hasDocsChanges = files.some(
    (file) => file === "PLATFORMCLAW.md" || file.startsWith("docs/platformclaw/"),
  );
  const hasPackageChanges = files.some((file) =>
    file.startsWith("packages/platformclaw-control-plane/"),
  );
  const hasPlannerChanges = files.some(
    (file) =>
      file === "scripts/platformclaw-ci-plan.mjs" ||
      file === "scripts/platformclaw-ci-plan.d.mts" ||
      file === "test/scripts/platformclaw-ci-plan.test.ts",
  );
  const hasWorkflowChanges = files.some((file) =>
    file.startsWith(".github/workflows/platformclaw-"),
  );
  const hasUiChanges = files.some(
    (file) => file.startsWith("ui/src/platformclaw/") || file.startsWith("ui/platformclaw-"),
  );
  const hasDeploymentChanges = files.some(
    (file) => file.startsWith("docker/platformclaw-") || file === "scripts/platformclaw-build.mjs",
  );
  const hasOverlayChanges = files.some(isOverlayPath);
  const hasUpstreamSurface = files.some((file) => !isOverlayPath(file));
  const hasCodeChanges = files.some(
    (file) => file !== "PLATFORMCLAW.md" && !file.startsWith("docs/platformclaw/"),
  );

  return {
    files,
    mode: !hasChanges
      ? "none"
      : hasUpstreamSurface
        ? "upstream"
        : hasCodeChanges
          ? "platformclaw"
          : "docs",
    needs_dependencies: hasChanges,
    needs_policy_guards: hasChanges,
    needs_docs_checks: hasDocsChanges,
    needs_format_check: hasOverlayChanges,
    needs_overlay_lint: hasPackageChanges || hasPlannerChanges,
    needs_package_checks: hasPackageChanges,
    needs_planner_tests: hasPlannerChanges,
    needs_workflow_checks: hasWorkflowChanges,
    needs_ui_checks: hasUiChanges,
    needs_deployment_checks: hasDeploymentChanges,
    needs_changed_surface_checks: hasUpstreamSurface,
  };
}

export function parseGitNameStatus(output) {
  const tokens = output.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const firstPath = tokens[index++];
    if (!status || !firstPath) {
      throw new Error("Malformed git name-status output");
    }
    files.push(firstPath);
    if (status.startsWith("R") || status.startsWith("C")) {
      const secondPath = tokens[index++];
      if (!secondPath) {
        throw new Error(`Missing destination path for ${status}`);
      }
      files.push(secondPath);
    }
  }
  return files;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--base" || key === "--head" || key === "--github-output") {
      options[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return options;
}

function resolveBase(base, head) {
  if (!base || /^0+$/.test(base)) {
    return `${head}^`;
  }
  return base;
}

function changedFiles(base, head) {
  const output = execFileSync("git", ["diff", "--name-status", "-z", `${base}...${head}`], {
    encoding: "utf8",
  });
  return parseGitNameStatus(output);
}

function githubOutputs(plan) {
  return Object.entries(plan)
    .filter(([key]) => key !== "files")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const head = options.head || "HEAD";
  const base = resolveBase(options.base, head);
  const plan = classifyPlatformClawChanges(changedFiles(base, head));
  const output = githubOutputs(plan);

  if (options["github-output"]) {
    appendFileSync(options["github-output"], `${output}\n`);
  }
  process.stdout.write(`${JSON.stringify({ base, head, ...plan }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
