---
name: openclaw-test-heap-leaks
description: Investigate OpenClaw pnpm test memory growth, Vitest OOMs, RSS spikes, and heap snapshot deltas.
---

# OpenClaw Test Heap Leaks

Use this skill for test-memory investigations. Do not guess from RSS alone when heap snapshots are available. Treat snapshot-name deltas as triage evidence, not proof, until retainers or dominators support the call.

Read root `AGENTS.md` Validation and `$openclaw-testing` first. Use the permitted
environment and existing wrappers; heavy profiling and Linux proof run in the
selected trusted Linux environment. Never install in a Windows linked/sparse
worktree or invoke an unavailable backend. Untrusted source runs only in
supported secretless fork CI at the immutable reviewed SHA.

For **runtime fixes** (e.g., closure leaks in long-running services like the gateway), see [Validating runtime fixes](#validating-runtime-fixes-not-test-memory) below for the dedicated full-snapshot harness.

## Workflow

1. Reproduce the failing shape first.
   - Match the real entrypoint, preflight, config, shard, worker budget, execution order, and runtime. Record the original failure before changing concurrency or adding instrumentation.
   - Use current `scripts/test-projects.mjs` output: `[test] starting <config>` identifies the executed config. Keep worker PIDs and artifact paths alongside it; do not infer lanes from retired wrapper names.
   - For ranking, use `pnpm test:perf:groups --full-suite --allow-failures --output .artifacts/test-perf/memory-groups.json`. This diagnostic changes isolation/worker defaults and does not reproduce every shared-worker failure. Preserve the original run separately. Inspect `failed`, each run's `status`, and logs; `--allow-failures` can write a report and exit 0 despite failed tests.
   - For a focused CPU/allocation investigation, use `pnpm test:perf:profile:runner --output-dir .artifacts/test-perf/runner -- <file>`. The current `scripts/run-vitest-profile.mjs` defaults to the unit config and no file parallelism; use it as supplemental triage, not a replacement for the failing shape. `test:perf:profile:main` provides main-process CPU profiles.
   - Runner `.heapprofile` files are sampling profiles, not full `.heapsnapshot` files. They do not provide the snapshot schema required by `heapsnapshot-delta.mjs` or prove that an object is retained.

2. Capture full snapshots when making retention claims.
   - Use an existing scenario harness that calls `v8.writeHeapSnapshot()` or capture full snapshots through DevTools attached to the actual suspect worker. The profiling wrapper does not schedule interval snapshots; do not assume automatic snapshot files exist.
   - Capture at least two comparable lifecycle points from the same worker PID and config while preserving the relevant reproduction. Record the capture method, elapsed work, GC conditions, and overhead. Do not compare snapshots from different processes as retained-object growth.
   - Keep task-owned artifacts in a directory such as `.tmp/heapsnap/<config>/`; never attach the debugger to an operator-owned process or expose a debug port beyond the task boundary.
   - Use `.agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs` to compare either two files directly or the earliest/latest pair per PID in one lane directory.
   - If the helper suggests transformed-module retention, confirm the top entries in DevTools retainers/dominators before calling it solved.

3. Classify the growth before choosing a fix.
   - If growth is dominated by Vite/Vitest transformed source strings, `Module`, `system / Context`, bytecode, descriptor arrays, or property maps, treat it as likely retained module graph growth in long-lived workers.
   - If growth is dominated by app objects, caches, buffers, server handles, timers, mock state, sqlite state, or similar runtime objects, treat it as a likely cleanup or lifecycle leak.
   - If the names are ambiguous, stop short of a confident label and inspect retainers/dominators in DevTools for the top deltas.

4. Fix the right layer.
   - For likely retained transformed-module growth in shared workers:
   - Use current grouped timing/import evidence and `scripts/test-projects.mjs`, `scripts/test-projects.test-support.mjs`, and the owning `test/vitest/*.config.ts` to locate the import or worker-lifetime owner.
   - Prefer removing broad imports, stale retained state, or unnecessary worker lifetime at that owner. Any measured scheduling/isolation change must preserve coverage and be checked against sibling configs and the original failing order; isolation alone does not prove an application leak fixed.
   - For real leaks:
   - Patch the implicated test or runtime cleanup path.
   - Look for missing `afterEach`/`afterAll`, module-reset gaps, retained global state, unreleased DB handles, or listeners/timers that survive the file.

5. Verify with the most direct proof.
   - Re-run the original config/shard/order/concurrency and repeat comparable same-PID full snapshots when feasible.
   - If snapshot overhead causes timeouts, also run the original shape without snapshots and report RSS/OOM changes, but keep retention proof explicitly inconclusive until full-snapshot retainer/dominator evidence is available. Never extend timeouts or weaken assertions to hide the failure.
   - For wrapper-only changes, verify expected configs, argument forwarding, actual exits, and the artifacts that the changed wrapper promises. A sampling-profile wrapper is not expected to emit full snapshots.
   - Preserve focused regression and sibling tests, changed checks, conditional builds and SDK gates from `$openclaw-testing`; use `openclaw-test-performance` for the full performance verification matrix. Retain required autoreview, independent review, security, and landing gates.

## Heuristics

- Do not call everything a leak. Long-lived shared-worker module graphs and application object leaks require different owner repairs.
- `scripts/test-projects.mjs`, `scripts/test-group-report.mjs`, and `scripts/run-vitest-profile.mjs` own current execution, grouped measurements, and sampling profiles respectively.
- Grouped reports and `[test] starting <config>` lines identify current execution surfaces; full-suite reports deliberately isolate files and may hide shared-lifetime growth.
- When one or two files dominate, compare their imports/lifecycle in the failing worker before choosing an import, cleanup, or scheduling fix.
- When the same retained object families grow across multiple intervals in the same worker PID, trust the snapshots over intuition, then confirm ambiguous calls with retainer evidence.

## Snapshot Comparison

- Direct comparison:
  - `node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs before.heapsnapshot after.heapsnapshot`
- Auto-select earliest/latest snapshots per PID within one lane:
  - `node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs --lane-dir .tmp/heapsnap/<config> --pid <pid>`
  - Auto-selection accepts Node's `Heap.<stamp>.<pid>.0.<seq>.heapsnapshot` filenames. For DevTools exports or harness-specific names, pass exactly two resolved snapshot paths directly and verify their PID independently.
- Useful flags:
  - `--top 40`
  - `--min-kb 32`
  - `--pid 16133`

Read the top positive deltas first. Large growth in module-transform artifacts suggests retained module graphs; growth in runtime objects suggests a lifecycle leak. Snapshot-name deltas alone do not establish ownership. Open the same snapshot pair in DevTools and inspect retainers/dominators for the top rows before declaring root cause.

## Validating runtime fixes (not test-memory)

The workflow above is for diagnosing Vitest worker memory growth. For
validating that a runtime/closure fix actually releases captured state, use the
dedicated harness:

- `pnpm leak:embedded-run` — runs `scripts/embedded-run-abort-leak.ts`. Loops N
  aborted runs in a function-shaped scope mimicking `runEmbeddedAttempt`,
  writes heap snapshots, and reports a PASS/FAIL verdict on retention growth
  using `FinalizationRegistry` for tracked-instance counting plus RSS delta.

Modes:

- `production` (default) — imports the real `abortable` from `src/agents/embedded-agent-runner/run/abortable.ts`; use this mode to verify the production implementation.
- `closure-extracted` — self-contained helper at module scope, mirroring the fixed lexical shape; its PASS alone does not prove production code.
- `closure-inline` — pre-fix shape (closure inside the runner scope). Use as a
  sensitivity check: if it passes you've broken the harness, not fixed a bug.
- `synthetic-leak` — deliberately retains via a module-level bucket. Use to
  confirm the harness can detect leaks before trusting a PASS on a real fix.

Snapshots land in `.tmp/embedded-run-abort-leak/`. Resolve one baseline and one
later batch snapshot from the same PID, then pass those exact filenames (shell
wildcards can expand to more than two files):

```
node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs \
  <baseline-snapshot-path> <later-batch-snapshot-path> --top 30
```

When fixing a different runtime leak, add a new harness alongside this one
rather than retrofitting it. The fixture function should mimic the lexical
scope of the function where the leak lives, not be a generic abort-loop.

## Output Expectations

When using this skill, report:

- The exact reproduce command.
- Environment, reviewed SHA/patch identity, actual exits, artifact paths, and any hosted proof URLs.
- Which lane and PID were compared.
- The dominant retained object families from the snapshot delta.
- Whether the issue is a likely real leak or likely shared-worker retained module growth, plus whether retainers/dominators confirmed it.
- The concrete fix or impact-reduction patch.
- What you verified, and what snapshot overhead prevented you from verifying.
