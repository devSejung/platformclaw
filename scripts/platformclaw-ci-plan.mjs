#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const EXACT_OVERLAY_PATHS = new Set([
  ".github/actionlint.yaml",
  ".github/workflows/platformclaw-ci.yml",
  ".github/workflows/platformclaw-full-ci.yml",
  ".github/workflows/platformclaw-submission.yml",
  ".oxfmtrc.jsonc",
  "ARCHITECTURE.md",
  "ATTRIBUTION.md",
  "EVALUATION.md",
  "PLATFORMCLAW.md",
  "PRD.md",
  "README.md",
  "scripts/mock_employee_auth.py",
  "scripts/e2e/platformclaw-runtime-docker.sh",
  "scripts/platformclaw-ci-plan.d.mts",
  "scripts/platformclaw-ci-plan.mjs",
  "scripts/platformclaw-check.d.mts",
  "scripts/platformclaw-check.mjs",
  "test/scripts/platformclaw-check.test.ts",
  "test/scripts/platformclaw-ci-plan.test.ts",
  "ui/vite.platformclaw-login.config.ts",
]);

const OVERLAY_PREFIXES = [
  "docs/assets/platformclaw/",
  "docs/platformclaw/",
  "docs/submission/",
  "extensions/admin-http-rpc/",
  "extensions/knox/",
  "extensions/platformclaw-execution/",
  "extensions/platformclaw-user-mcp/",
  "packages/platformclaw-control-plane/",
  "scripts/submission/",
  "submission/",
  "ui/src/platformclaw/",
];

const SHARED_METADATA_PATHS = new Set(["package.json", "pnpm-lock.yaml"]);

function normalizePath(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isOverlayPath(file) {
  return (
    EXACT_OVERLAY_PATHS.has(file) ||
    OVERLAY_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    file.startsWith("docker/platformclaw-") ||
    file.startsWith("scripts/platformclaw-") ||
    file.startsWith("test/scripts/platformclaw-") ||
    file.startsWith("ui/platformclaw-")
  );
}

function isDocumentationOnlyPath(file) {
  return (
    file.endsWith(".md") ||
    file.startsWith("docs/assets/platformclaw/") ||
    file.startsWith("submission/")
  );
}

export function classifyPlatformClawChanges(inputFiles) {
  const files = [...new Set(inputFiles.map(normalizePath).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
  const hasChanges = files.length > 0;
  const hasDocsChanges = files.some(
    (file) =>
      file === "PLATFORMCLAW.md" ||
      file.startsWith("docs/platformclaw/") ||
      file.startsWith("docs/submission/"),
  );
  const hasPackageChanges = files.some((file) =>
    file.startsWith("packages/platformclaw-control-plane/"),
  );
  const hasAdminHttpRpcChanges = files.some((file) =>
    file.startsWith("extensions/admin-http-rpc/"),
  );
  const hasKnoxChanges = files.some((file) => file.startsWith("extensions/knox/"));
  const hasExecutionChanges = files.some((file) =>
    file.startsWith("extensions/platformclaw-execution/"),
  );
  const hasUserMcpChanges = files.some((file) =>
    file.startsWith("extensions/platformclaw-user-mcp/"),
  );
  const hasBoardFarmChanges = files.some((file) =>
    file.startsWith("packages/platformclaw-control-plane/src/board-farm/"),
  );
  const hasSkillPolicyChanges = files.some(
    (file) =>
      file.startsWith("extensions/platformclaw-execution/src/remote-skill") ||
      file.startsWith("submission/internal-templates/global-skills/") ||
      file === "docs/submission/07_GLOBAL_SKILLS_POLICY.md",
  );
  const hasSubmissionDocsChanges = files.some(
    (file) =>
      ["ARCHITECTURE.md", "ATTRIBUTION.md", "EVALUATION.md", "PRD.md", "README.md"].includes(
        file,
      ) ||
      file.startsWith("docs/submission/") ||
      file === "submission/README.md" ||
      file === "submission/SUBMISSION_MANIFEST.md" ||
      file === "submission/INTERNAL_FINALIZATION_CHECKLIST.md" ||
      file.startsWith("submission/internal-templates/") ||
      file.startsWith("submission/slides/") ||
      file.startsWith("submission/video/"),
  );
  const hasSubmissionEvidenceChanges = files.some(
    (file) =>
      file === "submission/evaluation-map.yaml" ||
      file === "submission/internal-requirements.yaml" ||
      file.startsWith("submission/evidence/"),
  );
  const hasPlannerChanges = files.some(
    (file) =>
      file === "scripts/platformclaw-ci-plan.mjs" ||
      file === "scripts/platformclaw-ci-plan.d.mts" ||
      file === "scripts/platformclaw-check.mjs" ||
      file === "scripts/platformclaw-check.d.mts" ||
      file.startsWith("scripts/submission/") ||
      file.startsWith("test/scripts/platformclaw-"),
  );
  const hasWorkflowChanges = files.some((file) =>
    file.startsWith(".github/workflows/platformclaw-"),
  );
  const hasUiChanges = files.some(
    (file) =>
      file.startsWith("ui/src/platformclaw/") ||
      file.startsWith("ui/platformclaw-") ||
      file === "ui/vite.platformclaw-login.config.ts",
  );
  const hasDeploymentChanges = files.some(
    (file) =>
      file.startsWith("docker/platformclaw-") ||
      file === "scripts/platformclaw-build.mjs" ||
      file === "scripts/e2e/platformclaw-runtime-docker.sh",
  );
  const hasOverlayChanges = files.some(isOverlayPath);
  // A lockfile updated alongside an overlay-owned package is validated by the
  // frozen install and dependency guards. Lockfile-only changes stay upstream-wide.
  const hasUpstreamSurface = files.some(
    (file) => !isOverlayPath(file) && (!SHARED_METADATA_PATHS.has(file) || !hasOverlayChanges),
  );
  const hasCodeChanges = files.some((file) => !isDocumentationOnlyPath(file));

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
    needs_admin_http_rpc_checks: hasAdminHttpRpcChanges,
    needs_knox_checks: hasKnoxChanges,
    needs_execution_checks: hasExecutionChanges,
    needs_user_mcp_checks: hasUserMcpChanges,
    needs_board_farm_checks: hasBoardFarmChanges,
    needs_skill_policy_checks: hasSkillPolicyChanges,
    needs_submission_docs_checks: hasSubmissionDocsChanges,
    needs_submission_evidence_checks: hasSubmissionEvidenceChanges,
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

export function resolvePlatformClawBase(base, head) {
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

export function classifyPlatformClawRange(base, head) {
  return classifyPlatformClawChanges(changedFiles(resolvePlatformClawBase(base, head), head));
}

export function classifyPlatformClawWorktree(base = "origin/main") {
  const tracked = parseGitNameStatus(
    execFileSync("git", ["diff", "--name-status", "-z", base], { encoding: "utf8" }),
  );
  const untracked = listPlatformClawUntrackedFiles();
  return classifyPlatformClawChanges([...tracked, ...untracked]);
}

export function listPlatformClawUntrackedFiles() {
  return gitPathList(["ls-files", "--others", "--exclude-standard", "-z"]);
}

function gitPathList(args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
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
  const base = resolvePlatformClawBase(options.base, head);
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
