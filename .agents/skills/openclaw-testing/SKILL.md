---
name: openclaw-testing
description: Choose proportional OpenClaw and PlatformClaw tests and checks, diagnose failures, and route package, Docker, or release proof to its owner.
---

# OpenClaw Testing

Prove the changed contract with the smallest meaningful check, complete required
checks, then finish. Broaden or repeat for new changes, failures, or unresolved
risks. Add tests for observable behavior and boundaries; avoid assertions that
merely mirror reversible, low-impact implementation changes.

Read root and scoped `AGENTS.md` first: they own source trust, execution routing,
review, and merge gates. Start command selection at
`docs/reference/test.md#routine-local-order` and `#core-commands`; read
`docs/ci.md` when CI scope or runner behavior matters. For private workflow
capabilities, read `docs/platformclaw/private-downstream-ci.md`.

## Select The Proof

| Change or question                             | Starting point                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- |
| Runtime defect                                 | Reproduce the failing boundary narrowly; rerun after repair with relevant siblings |
| Source diff                                    | Inspect changed lanes, run required changed checks, and choose focused tests       |
| Public SDK/plugin contract                     | Changed checks plus representative consumer tests; broaden for demonstrated risk   |
| Build output, lazy imports, package boundaries | Include the required build and artifact checks                                     |
| Workflow                                       | `git diff --check` plus relevant workflow syntax/guard checks                      |
| Documentation only                             | Relevant link/format sanity and `git diff --check`; no automatic runtime tests     |

Follow repository and user host policy when choosing where to run these checks.
If a backend is declared unavailable, do not probe or retry it. Use the permitted
fallback for trusted source and record the limitation. PlatformClaw's final
runtime and validation authority is Ubuntu Linux Docker; Windows proof alone
cannot establish Linux deployment behavior.

Untrusted contributor/fork tooling must never execute locally, including its
wrapper or config. Use secretless fork CI or the sanitized remote procedure in
root policy when available; never put untrusted code in a credential-hydrated
lease. An unavailable backend does not relax that boundary.

## Commands And State

For trusted source, use repository wrappers with an existing dependency install:

```bash
node scripts/changed-lanes.mjs --json -- <paths...>
node scripts/check-changed.mjs --dry-run -- <paths...>
node scripts/run-vitest.mjs <path-or-filter>
```

The changed-check dry run prints the plan without delegating or running checks.
Normal `check:changed` can delegate automatically; inspect its plan and respect
host restrictions before execution. It checks formatting, types, lint, and
guards; it does not run Vitest. Choose test targets separately.
`test:changed` selects direct, mapped, sibling, and import-dependent tests;
shared harness/config changes may need explicit targets or its documented broad
fallback. Full `verify` runs checks then tests only when that scope is required.

For PlatformClaw development, use
`node scripts/platformclaw-check.mjs --changed --quick` during editing and the
same command without `--quick` before push or PR. Its selected groups include
focused tests; shared/core paths can delegate through the upstream changed gate.
For those paths, inspect `node scripts/check-changed.mjs --dry-run -- <paths...>`
before starting the full gate under host restrictions. `--overlay-only` on the
PlatformClaw wrapper omits upstream changed-gate execution when hosted CI supplies
that proof; it does not waive required shared checks.

In linked/sparse worktrees, keep the direct `node` wrappers; do not reconcile or
install dependencies merely to obtain local proof. Serialize independent Vitest
runs, group targets in one invocation, or assign distinct
`OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` values. Wait for an active run before
editing its source/tests.

Use isolated test state and a free port. Never restart or edit an operator's
Gateway or real data without per-task approval. Do not kill unrelated processes
or alter a shared dependency install while other jobs use it.

## Diagnose CI Failures

Bind diagnosis to the exact SHA, job, shard/lane, and artifact. Check whether a
cancelled same-branch run was superseded. Fetch relevant failed logs once and
reuse them; exact run/job state is stronger than a stale PR rollup.
Separate product, harness, infrastructure, and credential failures before
choosing a retry. Reproduce ordering/state failures in their original order.

For prompt snapshot drift, reproduce in CI's Linux/Node environment before
regenerating. Repair the owner, rerun affected proof, and document unrelated
failures with scoped evidence. A passing replay alone does not prove a fix.
Never rerun or re-push merely to get green, or mask failures with retries,
longer timeouts, weaker assertions, broader mocks, or altered baselines.
Related failing checks and red-main landing remain subject to root merge gates.

## Specialized Proof

Load only the route needed for the current task:

- Package installation, plugin trust, Docker/live lane choice or reruns:
  [Package And Docker Proof](references/package-and-docker.md).
- Release candidates, validation identity, evidence or recovery:
  [release-openclaw-ci](../release-openclaw-ci/SKILL.md); plugin release matrices:
  [release-openclaw-plugin-testing](../release-openclaw-plugin-testing/SKILL.md).
  Publication/version changes still require the release owner's approval flow.
- Slow tests or memory growth:
  [openclaw-test-performance](../openclaw-test-performance/SKILL.md) and, when
  heap evidence is needed, [openclaw-test-heap-leaks](../openclaw-test-heap-leaks/SKILL.md).
- UI behavior: [control-ui-e2e](../control-ui-e2e/SKILL.md). New Docker lanes:
  [openclaw-docker-e2e-authoring](../openclaw-docker-e2e-authoring/SKILL.md).
