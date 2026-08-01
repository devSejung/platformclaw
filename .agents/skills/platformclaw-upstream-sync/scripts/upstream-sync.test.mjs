import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "upstream-sync.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!options.allowFailure && result.status !== 0) {
    assert.fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function git(repo, ...args) {
  return run("git", ["-C", repo, ...args]).stdout.trim();
}

function write(repo, relative, content) {
  const target = path.join(repo, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function commitAll(repo, message) {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

test("plans, prepares, and verifies a two-parent upstream sync", () => {
  const root = mkdtempSync(path.join(tmpdir(), "platformclaw-upstream-sync-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "sync-worktree");

  try {
    run("git", ["init", "--initial-branch=main", repo]);
    git(repo, "config", "user.name", "PlatformClaw Skill Test");
    git(repo, "config", "user.email", "platformclaw-skill@example.invalid");
    write(repo, "PLATFORMCLAW.md", "# Fixture\n");
    write(repo, "docs/upstream/status.md", "Initial sync\n");
    write(repo, "src/cron/shared.ts", "export const owner = 'base';\n");
    const initialRoot = commitAll(repo, "base");
    git(repo, "commit", "--allow-empty", "-m", "previous upstream sync");
    const previousSync = git(repo, "rev-parse", "HEAD");
    write(repo, "docs/upstream/status.md", `Last upstream sync: ${previousSync}\n`);
    commitAll(repo, "record previous upstream sync");

    git(repo, "checkout", "-b", "upstream-test");
    write(repo, "custom/credentials/store.ts", "export const secret = false;\n");
    write(repo, "packages/runtime/models/index.ts", "export const models = [];\n");
    write(repo, "src/cron/shared.ts", "export const owner = 'upstream';\n");
    write(repo, "src/cron/upstream.ts", "export const upstream = true;\n");
    write(repo, "src/sessions.ts", "export const sessions = [];\n");
    const target = commitAll(repo, "upstream change");

    git(repo, "checkout", "main");
    write(repo, "src/cron/shared.ts", "export const owner = 'platformclaw';\n");
    const base = commitAll(repo, "downstream change");
    git(repo, "update-ref", "refs/remotes/origin/main", base);
    git(repo, "update-ref", "refs/remotes/upstream/main", target);
    git(
      repo,
      "remote",
      "add",
      "origin",
      "https://token:secret@example.com/private/repo.git?token=also-secret",
    );
    git(repo, "remote", "add", "upstream", "ssh-token@example.org:openclaw/openclaw.git");

    const planResult = run("node", [
      script,
      "plan",
      "--repo",
      repo,
      "--base",
      "origin/main",
      "--target",
      target,
      "--json",
    ]);
    const plan = JSON.parse(planResult.stdout);
    assert.equal(plan.upstreamOnlyCommits, 1);
    assert.equal(plan.downstreamOnlyCommits, 1);
    assert.equal(plan.previousSync, previousSync);
    assert.equal(plan.targetDescendsFromPreviousSync, true);
    assert.deepEqual(plan.overlapFiles, ["src/cron/shared.ts"]);
    assert.deepEqual(plan.sensitiveUpstreamFiles, [
      "custom/credentials/store.ts",
      "packages/runtime/models/index.ts",
      "src/cron/shared.ts",
      "src/cron/upstream.ts",
      "src/sessions.ts",
    ]);
    assert.equal(plan.remotes.origin, "https://example.com/private/repo.git");
    assert.equal(plan.remotes.upstream, "example.org:openclaw/openclaw.git");
    assert.doesNotMatch(planResult.stdout, /secret|token/);

    run("node", [
      script,
      "prepare",
      "--repo",
      repo,
      "--base",
      "origin/main",
      "--target",
      target,
      "--branch",
      "sync/upstream-20990101",
      "--worktree",
      worktree,
    ]);
    const merge = run("git", ["-C", worktree, "merge", "--no-ff", "--no-commit", target], {
      allowFailure: true,
    });
    assert.equal(merge.status, 1, "fixture should produce an explicit conflict");
    write(worktree, "src/cron/shared.ts", "export const owner = 'reviewed';\n");
    write(worktree, "docs/upstream/status.md", `Last upstream sync: ${target}\n`);
    commitAll(worktree, "Merge upstream fixture");

    const verify = run("node", [
      script,
      "verify",
      "--repo",
      worktree,
      "--base",
      base,
      "--target",
      target,
    ]);
    assert.match(verify.stdout, /Status document and clean-worktree checks passed/);

    const shortSha = run(
      "node",
      [
        script,
        "prepare",
        "--repo",
        repo,
        "--target",
        target.slice(0, 12),
        "--branch",
        "sync/upstream-20990102",
        "--worktree",
        path.join(root, "bad-worktree"),
      ],
      { allowFailure: true },
    );
    assert.notEqual(shortSha.status, 0);
    assert.match(shortSha.stderr, /exact 40-character commit SHA/);

    const mergedHead = git(worktree, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", mergedHead);
    const staleBase = run(
      "node",
      [
        script,
        "prepare",
        "--repo",
        repo,
        "--base",
        base,
        "--target",
        target,
        "--branch",
        "sync/upstream-20990103",
        "--worktree",
        path.join(root, "stale-base"),
      ],
      { allowFailure: true },
    );
    assert.notEqual(staleBase.status, 0);
    assert.match(staleBase.stderr, /does not equal current origin\/main/);

    const alreadyMerged = run(
      "node",
      [
        script,
        "prepare",
        "--repo",
        repo,
        "--base",
        mergedHead,
        "--target",
        target,
        "--branch",
        "sync/upstream-20990104",
        "--worktree",
        path.join(root, "already-merged"),
      ],
      { allowFailure: true },
    );
    assert.notEqual(alreadyMerged.status, 0);
    assert.match(alreadyMerged.stderr, /already merged/);

    git(repo, "tag", "-a", "target-tag", target, "-m", "annotated target");
    const tagObject = git(repo, "rev-parse", "target-tag^{tag}");
    const tagTarget = run(
      "node",
      [script, "verify", "--repo", worktree, "--base", base, "--target", tagObject],
      { allowFailure: true },
    );
    assert.notEqual(tagTarget.status, 0);
    assert.match(tagTarget.stderr, /target SHA did not resolve to itself/);

    git(repo, "checkout", "-b", "divergent-upstream", initialRoot);
    git(repo, "commit", "--allow-empty", "-m", "divergent upstream");
    const divergentTarget = git(repo, "rev-parse", "HEAD");
    const divergent = run(
      "node",
      [
        script,
        "prepare",
        "--repo",
        repo,
        "--base",
        mergedHead,
        "--target",
        divergentTarget,
        "--branch",
        "sync/upstream-20990105",
        "--worktree",
        path.join(root, "divergent"),
      ],
      { allowFailure: true },
    );
    assert.notEqual(divergent.status, 0);
    assert.match(divergent.stderr, /does not descend from previous upstream sync/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
