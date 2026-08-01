#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const SENSITIVE_PATHS = [
  /^(src|packages)\/(agents|channels|gateway|plugins|plugin-sdk)\//,
  /^src\/(config|cron|process|sandbox)\//,
  /^extensions\//,
  /^ui\//,
  /^\.github\/workflows\//,
  /(^|\/)(crons?|sandboxes?|process(?:es)?|sessions?|models?|providers?|credentials?|workspaces?|sqlite|mcps?)(\/|\.|-)/i,
];

function fail(message) {
  process.stderr.write(`[platformclaw-upstream-sync] ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    fail(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

function git(repo, args, options = {}) {
  return run("git", ["-C", repo, ...args], options);
}

function parseArgs(argv) {
  const command = argv[0] || "help";
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "json" || key === "allow-non-platformclaw") {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return { command, values };
}

function repositoryRoot(repoArg) {
  const candidate = path.resolve(repoArg || process.cwd());
  return path.resolve(git(candidate, ["rev-parse", "--show-toplevel"]).stdout);
}

function assertPlatformClaw(repo, allowNonPlatformClaw) {
  if (allowNonPlatformClaw) return;
  for (const relative of ["PLATFORMCLAW.md", "docs/upstream/status.md"]) {
    if (!existsSync(path.join(repo, relative))) {
      fail(`refusing non-PlatformClaw repository: missing ${relative}`);
    }
  }
}

function resolveCommit(repo, ref, label) {
  if (!ref) fail(`--${label} is required`);
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).stdout.toLowerCase();
}

function lines(value) {
  return value ? value.split(/\r?\n/).filter(Boolean).sort() : [];
}

function changedFiles(repo, from, to) {
  return lines(git(repo, ["diff", "--name-only", `${from}..${to}`]).stdout);
}

function remoteUrl(repo, name) {
  const result = git(repo, ["remote", "get-url", name], { allowFailure: true });
  if (result.status !== 0) return null;
  const value = result.stdout;
  try {
    const parsed = new URL(value);
    if (!["git:", "http:", "https:", "ssh:"].includes(parsed.protocol)) return "<configured>";
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const scpLike = value.match(/^(?:[^/@:\s]+@)?([^/:\s]+):(.+)$/);
    const repositoryPath = scpLike?.[2].split(/[?#]/, 1)[0];
    return scpLike ? `${scpLike[1]}:${repositoryPath}` : "<configured>";
  }
}

function previousUpstreamSync(repo, base) {
  const status = git(repo, ["show", `${base}:docs/upstream/status.md`]).stdout;
  const lastSyncLine = status.split(/\r?\n/).find((line) => /last upstream sync:/i.test(line));
  const previous = lastSyncLine?.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase();
  if (!previous) {
    fail(`base ${base} does not record a full SHA on the Last upstream sync line`);
  }
  const resolved = resolveCommit(repo, previous, "previous upstream sync");
  if (resolved !== previous) fail("recorded previous upstream sync is not an exact commit SHA");
  return previous;
}

function inspect(repo, baseRef, targetRef) {
  const base = resolveCommit(repo, baseRef, "base");
  const target = resolveCommit(repo, targetRef, "target");
  const mergeBase = git(repo, ["merge-base", base, target]).stdout.toLowerCase();
  if (!mergeBase) fail("base and target have no merge base");
  const previousSync = previousUpstreamSync(repo, base);

  const downstreamFiles = changedFiles(repo, mergeBase, base);
  const upstreamFiles = changedFiles(repo, mergeBase, target);
  const downstreamSet = new Set(downstreamFiles);
  const overlapFiles = upstreamFiles.filter((file) => downstreamSet.has(file));
  const sensitiveUpstreamFiles = upstreamFiles.filter((file) =>
    SENSITIVE_PATHS.some((pattern) => pattern.test(file)),
  );
  const branchResult = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], {
    allowFailure: true,
  });

  return {
    repository: repo,
    branch: branchResult.status === 0 ? branchResult.stdout : null,
    dirty: git(repo, ["status", "--porcelain"]).stdout.length > 0,
    remotes: { origin: remoteUrl(repo, "origin"), upstream: remoteUrl(repo, "upstream") },
    baseRef,
    base,
    targetRef,
    target,
    mergeBase,
    previousSync,
    targetDescendsFromPreviousSync:
      git(repo, ["merge-base", "--is-ancestor", previousSync, target], {
        allowFailure: true,
      }).status === 0,
    upstreamOnlyCommits: Number(git(repo, ["rev-list", "--count", `${base}..${target}`]).stdout),
    downstreamOnlyCommits: Number(git(repo, ["rev-list", "--count", `${target}..${base}`]).stdout),
    targetAlreadyMerged:
      git(repo, ["merge-base", "--is-ancestor", target, base], {
        allowFailure: true,
      }).status === 0,
    upstreamFiles,
    downstreamFiles,
    overlapFiles,
    sensitiveUpstreamFiles,
  };
}

function printPlan(report, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const list = (title, values) => {
    process.stdout.write(`\n${title} (${values.length})\n`);
    for (const value of values) process.stdout.write(`  ${value}\n`);
  };
  process.stdout.write(`Repository: ${report.repository}\n`);
  process.stdout.write(
    `Branch: ${report.branch || "detached"}${report.dirty ? " (dirty)" : " (clean)"}\n`,
  );
  process.stdout.write(`Base: ${report.baseRef} -> ${report.base}\n`);
  process.stdout.write(`Target: ${report.targetRef} -> ${report.target}\n`);
  process.stdout.write(`Merge base: ${report.mergeBase}\n`);
  process.stdout.write(`Previous upstream sync: ${report.previousSync}\n`);
  process.stdout.write(
    `Target descends from previous sync: ${report.targetDescendsFromPreviousSync}\n`,
  );
  process.stdout.write(`Upstream-only commits: ${report.upstreamOnlyCommits}\n`);
  process.stdout.write(`Downstream-only commits: ${report.downstreamOnlyCommits}\n`);
  process.stdout.write(`Target already merged: ${report.targetAlreadyMerged}\n`);
  process.stdout.write(`Origin: ${report.remotes.origin || "missing"}\n`);
  process.stdout.write(`Upstream: ${report.remotes.upstream || "missing"}\n`);
  list("Semantic overlap candidates", report.overlapFiles);
  list("Policy-sensitive upstream paths", report.sensitiveUpstreamFiles);
  process.stdout.write(
    `\nAll upstream-changed paths: ${report.upstreamFiles.length} (use --json to inspect)\n`,
  );
  process.stdout.write(
    `All downstream-changed paths: ${report.downstreamFiles.length} (use --json to inspect)\n`,
  );
}

function prepare(repo, values) {
  const branch = values.branch;
  const worktree = values.worktree;
  if (!branch || !/^sync\/upstream-\d{8}(?:-\d+)?$/.test(branch)) {
    fail("--branch must match sync/upstream-YYYYMMDD or sync/upstream-YYYYMMDD-N");
  }
  if (!worktree) fail("--worktree is required");
  const targetInput = values.target;
  if (!targetInput || !/^[0-9a-fA-F]{40}$/.test(targetInput)) {
    fail("prepare requires --target as an exact 40-character commit SHA");
  }
  const target = resolveCommit(repo, targetInput, "target");
  if (target !== targetInput.toLowerCase()) fail("target SHA did not resolve to itself");
  const baseRef = values.base || "origin/main";
  const base = resolveCommit(repo, baseRef, "base");
  const originMain = resolveCommit(repo, "origin/main", "origin/main");
  if (base !== originMain) {
    fail(`base ${base} does not equal current origin/main ${originMain}`);
  }
  git(repo, ["merge-base", base, target]);
  const previousSync = previousUpstreamSync(repo, base);
  if (
    git(repo, ["merge-base", "--is-ancestor", previousSync, target], { allowFailure: true })
      .status !== 0
  ) {
    fail(`target ${target} does not descend from previous upstream sync ${previousSync}`);
  }
  if (
    git(repo, ["merge-base", "--is-ancestor", target, base], { allowFailure: true }).status === 0
  ) {
    fail(`target ${target} is already merged into base ${base}`);
  }
  git(repo, ["check-ref-format", "--branch", branch]);

  const branchExists =
    git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      allowFailure: true,
    }).status === 0;
  if (branchExists) fail(`branch already exists: ${branch}`);

  const worktreePath = path.resolve(repo, worktree);
  if (existsSync(worktreePath)) fail(`worktree path already exists: ${worktreePath}`);
  git(repo, ["worktree", "add", "-b", branch, worktreePath, base]);

  const result = { repository: repo, branch, worktree: worktreePath, base, target };
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Created ${branch} at ${base}\n`);
    process.stdout.write(`Worktree: ${worktreePath}\n`);
    process.stdout.write(`Frozen target: ${target}\n`);
    process.stdout.write(`Next: cd ${worktreePath}\n`);
    process.stdout.write(`Then: git merge --no-ff --no-commit ${target}\n`);
  }
}

function verify(repo, values) {
  const baseInput = values.base;
  if (!baseInput || !/^[0-9a-fA-F]{40}$/.test(baseInput)) {
    fail("verify requires --base as an exact 40-character commit SHA");
  }
  const base = resolveCommit(repo, baseInput, "base");
  if (base !== baseInput.toLowerCase()) fail("base SHA did not resolve to itself");
  const targetInput = values.target;
  if (!targetInput || !/^[0-9a-fA-F]{40}$/.test(targetInput)) {
    fail("verify requires --target as an exact 40-character commit SHA");
  }
  const target = resolveCommit(repo, targetInput, "target");
  if (target !== targetInput.toLowerCase()) fail("target SHA did not resolve to itself");
  const branch = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]).stdout;
  if (!/^sync\/upstream-\d{8}(?:-\d+)?$/.test(branch)) {
    fail(`HEAD is not on a sync branch: ${branch || "detached"}`);
  }
  const status = git(repo, ["status", "--porcelain"]).stdout;
  if (status) fail("worktree is not clean");

  const head = resolveCommit(repo, "HEAD", "head");
  const parents = git(repo, ["show", "-s", "--format=%P", head])
    .stdout.split(/\s+/)
    .filter(Boolean);
  if (parents.length !== 2)
    fail(`HEAD must be a two-parent merge commit; found ${parents.length} parents`);
  if (parents[0].toLowerCase() !== base) {
    fail(`merge first parent ${parents[0]} does not equal frozen base ${base}`);
  }
  if (parents[1].toLowerCase() !== target) {
    fail(`merge second parent ${parents[1]} does not equal frozen target ${target}`);
  }
  const previousSync = previousUpstreamSync(repo, base);
  if (
    git(repo, ["merge-base", "--is-ancestor", previousSync, target], { allowFailure: true })
      .status !== 0
  ) {
    fail(`target ${target} does not descend from previous upstream sync ${previousSync}`);
  }
  if (
    git(repo, ["merge-base", "--is-ancestor", target, head], { allowFailure: true }).status !== 0
  ) {
    fail("frozen target is not an ancestor of HEAD");
  }

  const statusPath = path.join(repo, "docs", "upstream", "status.md");
  if (!existsSync(statusPath)) fail("docs/upstream/status.md is missing");
  const lastSyncLine = readFileSync(statusPath, "utf8")
    .split(/\r?\n/)
    .find((line) => /last upstream sync:/i.test(line));
  if (!lastSyncLine?.toLowerCase().includes(target)) {
    fail("docs/upstream/status.md Last upstream sync line does not contain the frozen target SHA");
  }

  const result = { repository: repo, branch, head, base, target, verified: true };
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Verified merge ${head}\n`);
    process.stdout.write(`Branch: ${branch}\n`);
    process.stdout.write(`Frozen PlatformClaw parent: ${base}\n`);
    process.stdout.write(`Frozen upstream parent: ${target}\n`);
    process.stdout.write("Status document and clean-worktree checks passed.\n");
  }
}

function help() {
  process.stdout.write(`PlatformClaw upstream sync guard\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  plan    --base <ref> --target <ref> [--repo <path>] [--json]\n`);
  process.stdout.write(
    `  prepare --base <ref> --target <40-sha> --branch <sync/upstream-YYYYMMDD> --worktree <path> [--repo <path>] [--json]\n`,
  );
  process.stdout.write(`  verify  --base <40-sha> --target <40-sha> [--repo <path>] [--json]\n\n`);
  process.stdout.write(
    `The hidden --allow-non-platformclaw flag is only for isolated fixture testing.\n`,
  );
}

const { command, values } = parseArgs(process.argv.slice(2));
if (command === "help" || command === "--help" || command === "-h") {
  help();
  process.exit(0);
}
if (!["plan", "prepare", "verify"].includes(command)) fail(`unknown command: ${command}`);

const repo = repositoryRoot(values.repo);
assertPlatformClaw(repo, values["allow-non-platformclaw"]);
if (command === "plan")
  printPlan(inspect(repo, values.base || "origin/main", values.target), values.json);
if (command === "prepare") prepare(repo, values);
if (command === "verify") verify(repo, values);
