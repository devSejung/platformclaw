# GitHub and Git workflows

Read before issues/PRs, Git mutations, CI dispatch/polling, evidence publication, or commit/push/ship. Read this guide in full. The [root policy](../../AGENTS.md) owns hard gates, task routing, and validation-environment selection. Paths and commands here are relative to the repository root.

## Workflow scope

Direct pushes to `main` retain the linear-history/rebase requirements in Git below. Wrapper-managed PR landing follows the reviewed-head and mergeability rules in GitHub / PRs; do not rebase that workflow solely because `main` advanced. Request-specific push/ship steps apply within the selected workflow and never authorize unrelated checkout mutation.

## GitHub / PRs

- Fresh GitHub items: read `CONTRIBUTING.md`, the issue chooser/form, PR template, and `.github/CODEOWNERS`; blank issues are disabled; preserve templates and evidence requirements.
- Issue first for bugs, user-facing features, architecture/product decisions, or work needing durable discussion. Bounded maintainer-requested refactor may go direct; agent decides whether an issue adds value. PRs use the template, link context, and keep durable problem/impact/evidence sections.
- Route support to Discord and security through `SECURITY.md`. Use listed maintainer areas/`CODEOWNERS`; never guess mentions.
- Use `$openclaw-pr-maintainer` immediately for maintainer-side OpenClaw issue/PR review, triage, duplicates, labels, comments, close, land, or evidence. Contributor PR creation/refresh follows the requested contributor workflow; linked refs alone do not require maintainer archive tooling.
- Issue/PR start: `git status -sb`; if clean, `git pull --ff-only`; if dirty, yell before pull/rebase.
- PR refs: `gh pr view/diff` or `gh api`, not web search. Prefer `gitcrawl` for maintainer discovery; missing/stale `gitcrawl` falls through to live `gh`, not contributor setup. Verify live with `gh` before mutation.
- Bare issue/PR URL/number: inspect live and take the efficient maintainer path; switch branches/refs when useful.
- No unsolicited PR labels/retitles/rebases/fixups/landing. Comments/reviews ok only for reviewable findings, pre-merge proof, or close/duplicate reason after explicit close/sweep/landing request.
- Maintainer decision closes the cluster: if deciding reported behavior/proposed fix is not planned, comment+close all directly associated open issues/PRs unless explicitly told to keep one open. Associated means linked PRs/issues, duplicates, companion workaround PRs, and the canonical issue for the rejected behavior.
- Do not leave associated issues open for hypothetical future repros. Close with rationale; ask for a new issue or reopen only if concrete new evidence appears. Close comment states: decision, why, supported alternative, and what evidence would change the decision.
- Issue/PR work: search strong related issues/PRs before final; close proven dupes/fixed siblings. If none close, suggest one next related follow-up.
- PR superseded by `main`: if code proof shows `main` already has same-or-better behavior, comment canonical commit/PR + focused proof, then close. Bar high: inspect PR diff, current code/tests, linked issue, caller/sibling path. If unsure, leave open.
- Issue/PR numbers need a short summary every time; assume the reader has not opened or read them.
- Before presenting a batch of issues/PRs, verify live state and current `main`; delegate independent verification when useful under the Repair Doctrine. Omit closed/fixed items, and comment+close items already fixed on `main` when maintainer action is authorized.
- Generic triage and landing shortlists: exclude PRs authored by maintainers with broad repository access until 14 days after creation. An ordinary request for landing candidates does not override this gate; only a named PR or explicit request for maintainer-owned work does.
- PR review answer: bug/behavior, URL(s), affected surface, provenance for regressions when traceable, best-fix judgment, evidence from code/tests/CI/current or shipped behavior.
- PR reviewable findings: post them on the PR, not chat-only, so author sees actionable feedback.
- Issue/PR final answer: last line is the full GitHub URL.
- PR verification: before merge, post land-ready work done, exact commands and execution environment, required CI run IDs/URLs, before/after proof when used, and known proof gaps.
- Issue fixed on `main` with proof: comment proof + commit/PR, then close.
- After landing or requested close/sweep: search duplicates; comment proof + canonical commit/PR/release before closing.
- After PR merge/ship: concise prose recap, not a bullet pile; cover behavior, key surface, proof, and issue/PR state. Check for worthwhile refactor or simplification follow-ups; suggest any warranted.
- `ship` that fixes an issue: after push, comment proof + commit link, then close the issue.
- Public GH comments: show draft in chat first unless user explicitly asked to post/comment/reply/close/merge/land. After work starts and changes/proof exist, post the review/proof/commit comment.
- Representing user: if user already has a comment/thread for the point, update/reply there when possible; avoid duplicate PR/issue comments.
- No surprise GH writes: chat must mention every posted/updated public comment with URL.
- GH comments with backticks, `$`, or shell snippets: use heredoc/body file, not inline double-quoted `--body`.
- PR create: real body required. Use the current template: `What Problem This Solves`, `Why This Change Was Made`, `User Impact`, and `Evidence`; include visible refs, behavior, and validation.
- PR create races GitHub's merge-ref computation: the pull_request-open CI run can drop entirely or die as `startup_failure`/`BuildFailed` (`(Unknown event)`, not rerunnable). Prevention: `gh pr create --draft`, poll `mergeable` non-null, then `gh pr ready`. After opening, verify the CI workflow attached to the head SHA; if missing, the hourly `pr-ci-sweeper` re-fires it, or close/reopen manually.
- PR create/refresh: keep PR branches takeover-ready. Use a branch maintainers can push to, or for fork PRs ensure `maintainer_can_modify` / GitHub's `Allow edits by maintainers` is enabled unless explicitly told otherwise or GitHub's Actions/secrets warning makes that unsafe.
- GitHub issue/PR transcripts: use `$agent-transcript` only when explicitly requested. Do not offer or ask during ordinary PR work; follow its redaction and publication-scope rules.
- Contributor PRs: parsed context requires authored `What Problem This Solves` and `Evidence` sections. Do not require field-level proof forms; reviewers inspect code, tests, and CI for correctness.
- PR artifacts/screenshots: attach sanitized evidence to the PR/comment or an existing accessible artifact store under the Validation policy. Never push screenshots, videos, proof images, or proof assets to OpenClaw or any product repo branch, including temp artifact branches. Do not commit `.github/pr-assets`.
- CI polling: exact SHA, relevant checks only, minimal fields. Skip routine noise (`Auto response`, `Labeler`, docs agents, performance/stale). Logs only after failure/completion or concrete need. Never `gh run watch`; its 3s polling exhausts API quota. Use sparse GraphQL rollups. Filter `gh run list` by workflow/branch/commit; broad JSON lists can exceed relay caps. Exact-SHA fallback dispatches require the full 40-character SHA.
- CI waits: `node scripts/watch-pr-ci.mjs <pr> <head-sha>` — prechecks mergeable (CONFLICTING = pull_request CI cannot attach) and run attachment before polling; watchers emit every terminal state; no unbounded polls.
- Trusted-workflow release-branch CI: pass `target_ref` + `release_candidate_ref`; never `release_gate` (requires workflow head == target).
- Agent PR landing to `main`: use only the repo-native `scripts/pr` wrapper: run `scripts/pr review-init <PR>`, follow its checkout/guard guidance, complete review artifacts with `scripts/pr review-artifacts-init <PR>`, validate with `scripts/pr review-validate-artifacts <PR>`, then run `OPENCLAW_TESTBOX=1 scripts/pr prepare-run <PR>` and `scripts/pr merge-run <PR>`. Despite its name, `OPENCLAW_TESTBOX=1` selects existing hosted-evidence verification; it does not provision a Testbox. Keep this verification gate and exact-head/reviewed patch-identical reuse checks; never combine it with `OPENCLAW_PR_GATES_REMOTE=testbox`. Invoke prepare only after the required hosted checks are green. If this downstream cannot produce evidence the verifier accepts, report that gap; do not disable the verifier, fabricate stamps, or substitute local success for required hosted proof. Do not rebase only because `main` advanced; merge drift is advisory unless strict drift is explicitly enabled, while GitHub still blocks conflicts. Do not idle on `auto-response` or `check-docs`.
- After GitHub throttling, check core quota before `scripts/pr prepare-run` or `merge-run`. A failed operation can retain its lock; verify no child remains, then recover only with its emitted token.
- Non-main PRs: do not run `scripts/pr prepare-run` or `merge-run`; they diff against `main`. Use review artifacts, exact base-head CI, revalidate `headRefOid`, then `gh pr merge --match-head-commit <verified-sha>`.
- Main-bound workflow dispatch: resolve server `main` SHA immediately before dispatch; retry if identity fails after `main` advances.
- `release-ci-summary` accepts Full Release Validation parent runs only. Diverged release-branch logs: `--first-parent` plus a bounded count.

## Tooling Gotchas

Mechanics only; policy lives above.

- `gh`: `gh pr view` takes the branch positionally (no `--head`). `gh pr diff` has no `--stat`; use `gh pr view --json changedFiles,additions,deletions` or `git diff --stat`. `gh pr checks --json` uses `link`, not `detailsUrl`. `gh run view --json` uses `attempt`, not `attemptNumber`; reruns need `gh run view <run> --attempt <n>` (default output may show the prior attempt). `gh --jq` is not standalone `jq` (no `--arg`); pipe JSON to `jq`. `gh api --paginate '<endpoint>' | jq -s ...`; gh `--slurp` may emit nothing and forbids `--jq`/`--template`.
- zsh: quote `gh api` endpoints containing `?` or brackets and quote command globs; unmatched patterns abort before the tool runs. Don't use `path` as a variable; it rewrites `$PATH`. Git object paths: `${sha}:path`; `$sha:path` invokes parameter modifiers. File lists into tools: `--name-only -z | xargs -0`; zsh scalars don't word-split, and a zero-file run exits 0 looking clean.
- git: shared checkout — serialize `git fetch`; on ref-lock failure, re-read the ref before retry. Fetch/pull yielding without completion: inspect/stop only the owned process before retry; never overlap retries. Main locked elsewhere: detach at `origin/main`, then create the task branch.
- GitHub Actions: resolve workflow files from `.github/workflows` or API; never infer filenames from display names. Checkout refs use full 40-char SHAs; short SHAs resolve as branches/tags. GH job logs: filter the exact tab-delimited step first; broad patterns also match the job name.
- Shell/exec: yielded exec — retain the returned session id before polling; never blind-retry. Nested remote shell: avoid local `$()` expansion; use remote-safe validation. Merge guard shells start `set -euo pipefail`; a failed `[[ ... ]]` alone does not stop a later merge command.
- `rg`: options/globs before `--`; `--` immediately before a leading-dash pattern only.
- macOS `find` has no `-printf`; use `-print0` plus `stat`.
- Path formatter: `node_modules/.bin/oxfmt`; `pnpm exec` may reconcile workspace deps.
- `scripts/pr`: subcommands require a PR number (no subcommand `--help` placeholder). Artifacts preserve template enum values with evidence detail in summaries; validate before prepare, from PR-head mode (moving main invalidates the main-baseline guard). Review flow: checkout main baseline, then PR, before artifact validation. After every PR push, rerun `scripts/pr review-init`; checkout alone leaves a stale guard SHA. Locally unset `GITHUB_TOKEN`, `GH_TOKEN`, `HOMEBREW_GITHUB_API_TOKEN`; ambient tokens can select an exhausted or wrong identity. Review JSON: land-ready recommendation `READY FOR /prepare-pr`, `issueValidation.status=valid`; never `APPROVE`. After `scripts/pr merge-run` removes its worktree, `cd` to a persistent repo before follow-up commands.

## Git

- Commit via `scripts/committer "<msg>" <file...>`; stage intended files only.
- Commits: conventional-ish, concise, grouped.
- No manual stash/autostash unless explicit. Branch switches ok when useful; no new worktrees unless requested.
- `main`: no merge commits; rebase on latest `origin/main` before push. After one green run plus clean rebase sanity, do not chase moving `main` with repeated full gates.
- User says `commit`: your changes only. `commit all`: all changes in grouped chunks. `push`: may `git pull --rebase` first.
- User says `ship it`: commit intended changes, pull --rebase, push.
- Do not delete/rename unexpected files; ask if blocking, else ignore.
- Bulk PR close/reopen >50: ask with count/scope.
