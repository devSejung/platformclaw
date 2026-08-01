---
name: platformclaw-upstream-sync
description: Plan, execute, validate, and hand off an OpenClaw upstream merge into the private PlatformClaw downstream while preserving Git ancestry and PlatformClaw policy. Use for upstream/main comparison, selecting and freezing a green upstream SHA, creating sync/upstream-* branches and isolated worktrees, resolving upstream conflicts, auditing semantic overlap, updating docs/upstream/status.md, validating sync CI, or preparing an upstream-sync PR.
---

# PlatformClaw Upstream Sync

Synchronize OpenClaw through a reviewable merge commit without weakening the PlatformClaw overlay. Treat a green merge as necessary, not sufficient: inspect semantic overlap and re-prove private policy.

## Hard gates

- Work from the current `origin/main`, never from an arbitrary local feature branch.
- Read `PLATFORMCLAW.md`, `docs/upstream/status.md`, `docs/platformclaw/vm-execution-policy.md`, and `docs/platformclaw/private-downstream-ci.md` before choosing or merging a target.
- Fetch both remotes, then freeze one exact 40-character upstream commit SHA. Do not let a moving `upstream/main` determine later merge or validation commands.
- Use a new isolated worktree on `sync/upstream-YYYYMMDD`. Never merge upstream directly into `main`.
- Preserve ancestry with `git merge --no-ff --no-commit <target-sha>`. Do not squash, rebase, replay, or cherry-pick the upstream range.
- On Windows linked worktrees, never run `pnpm install` and never restore, checkout, or reset tracked `node_modules` paths.
- Keep the upstream import separate from new PlatformClaw feature work. Only repair private behavior required to preserve an already-approved contract.
- Never auto-resolve conflicts by choosing one side wholesale. Read the complete owning modules, callers, siblings, tests, scoped `AGENTS.md`, and dependency contracts.
- Do not push, open a PR, enable workflows, or merge without user authorization.

## 1. Establish a clean baseline

Check worktrees and remotes before mutation:

```powershell
git status --short --branch
git worktree list --porcelain
git remote -v
git fetch origin main
git fetch upstream main
```

If the current checkout is dirty, leave it untouched. All sync work belongs in the isolated worktree created below. Confirm `origin` is PlatformClaw and `upstream` is official OpenClaw.

## 2. Select and freeze the target

When the user names a release or SHA, resolve that exact object and inspect its ancestry and CI. When the request is “latest green,” inspect official OpenClaw GitHub checks for candidate commits and choose the newest exact commit whose required CI is complete and successful. Do not infer green from elapsed time or a nearby tag.

Record the exact target and generate the divergence/overlap report:

```powershell
$base = git rev-parse "origin/main^{commit}"
$candidate = "<selected-green-SHA-or-ref>"
$target = git rev-parse "$($candidate)^{commit}"
node .agents/skills/platformclaw-upstream-sync/scripts/upstream-sync.mjs plan --base $base --target $target
```

Replace the placeholder with the candidate actually proven green. Use `upstream/main` only when that exact tip is green.

The report separates upstream-only and downstream-only commit counts, lists the files changed on both sides since the merge base, and highlights policy-sensitive upstream paths. Review the full commit range as well:

```powershell
git log --oneline --decorate origin/main..$target
git diff --stat origin/main...$target
```

Stop if the target is not descended from the recorded prior upstream sync, has incomplete/failing required checks, or the range cannot be explained.

## 3. Create the sync worktree

Use a date branch; add a numeric suffix only if that branch already exists:

```powershell
node .agents/skills/platformclaw-upstream-sync/scripts/upstream-sync.mjs prepare `
  --base $base `
  --target $target `
  --branch sync/upstream-YYYYMMDD `
  --worktree ..\platformclaw-sync-YYYYMMDD
```

The command only creates the branch and worktree. It deliberately does not merge. Enter the new worktree, re-read any scoped `AGENTS.md`, and confirm it is clean and based on the resolved `origin/main` SHA printed by the command.

## 4. Merge without committing

Use the frozen SHA:

```powershell
git merge --no-ff --no-commit $target
```

Before resolving anything, inventory both explicit conflicts and silent semantic overlap:

```powershell
git status --short
git diff --name-only --diff-filter=U
node .agents/skills/platformclaw-upstream-sync/scripts/upstream-sync.mjs plan --base HEAD --target $target
```

For each affected PlatformClaw contract, write down: upstream change, private invariant, chosen owner boundary, tests that prove it, and any deliberate follow-up. Audit at least these surfaces when touched:

- sandbox/backend registration, `exec`, `process`, filesystem and workdir rules;
- agent ownership, session/channel routing, Knox group server-only execution;
- cron ownership, model selection, registered-model visibility, delivery and retries;
- prompt hooks, Core Files, employee profile and runtime context;
- credentials, workspace isolation, SSH/SafeConnect and fail-closed behavior;
- plugins, MCP, state stores, SQLite and Control UI navigation;
- workflows, runners, secrets, permissions and private-repository assumptions.

Prefer a newer upstream seam when it preserves policy. Remove obsolete private glue instead of layering a compatibility shim. Do not change an SQLite schema version without explicit user approval.

## 5. Update sync evidence

Update `docs/upstream/status.md` in the merge commit with:

- sync date and `sync/upstream-*` branch;
- the full frozen upstream SHA;
- material contract impact or an explicit “no change” result;
- any validation limitation or follow-up that remains.

Review newly added or renamed `.github/workflows/**`. Do not import OpenClaw organization secrets or runner assumptions. Repository workflow enablement is external state; inspect and change it only when authorized.

## 6. Validate before committing

Run focused tests for every resolved or semantically overlapping surface first. Then follow `$openclaw-testing` and `$crabbox` for the current repository validation route. At minimum:

```powershell
node scripts/platformclaw-check.mjs --changed --quick
node scripts/platformclaw-check.mjs --changed
git diff --check
```

Use Linux Docker as runtime authority. Start `$autoreview` concurrently with the relevant checks at the functional checkpoint; apply accepted findings in one fix cycle, then rerun only affected checks. Do not install dependencies in the linked Windows worktree.

Commit the resolved tree as one merge commit. Then verify the immutable evidence:

```powershell
node .agents/skills/platformclaw-upstream-sync/scripts/upstream-sync.mjs verify --base $base --target $target
```

`verify` requires a clean `sync/upstream-*` worktree, a two-parent HEAD whose first parent is the frozen PlatformClaw base and second parent is the frozen upstream SHA, target ancestry, and the exact SHA in `docs/upstream/status.md`.

## 7. PR handoff

When authorized, push only the sync branch and open a ready-for-review PR into `main`. Include:

- base SHA, frozen upstream SHA, upstream commit count, and merge commit SHA;
- explicit and semantic conflict summary;
- PlatformClaw invariant audit, especially cron/model and execution policy;
- focused, changed-surface, Linux/Docker, autoreview, and CI evidence;
- workflow additions/renames and private-origin enablement decisions;
- remaining risks and follow-ups separated from the sync.

Add the redacted transcript section through `$agent-transcript`. Keep the PR non-draft so PlatformClaw Full CI runs. Do not recommend merge until required PlatformClaw CI and Full CI are green and the latest ClawSweeper rank-up moves are applied or explicitly answered.

## Script contract

Run `upstream-sync.mjs help` for options. `plan` is read-only. `prepare` only creates a guarded worktree. `verify` is read-only. The script never fetches, merges, commits, pushes, opens PRs, edits files, or changes GitHub state.
