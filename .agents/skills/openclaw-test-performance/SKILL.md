---
name: openclaw-test-performance
description: Benchmark, diagnose, and optimize OpenClaw test and plugin-suite runtime, import hotspots, CPU/RSS, heap growth, and slow coverage paths.
---

# OpenClaw Test Performance

Use evidence first. The goal is real `pnpm test`, plugin-suite, and
plugin-inspector speed/RSS improvement with coverage intact, not runner tuning by
guesswork.

Read root `AGENTS.md` Validation and `$openclaw-testing` first. Commands below
describe proof, not permission to run it on the host. Use existing dependencies
and direct wrappers for trusted focused host checks; run broad profiling, builds,
and Linux proof in the selected trusted Linux environment. Never install in a
Windows linked/sparse worktree or invoke an unavailable backend. Untrusted source
stays on supported secretless fork CI at the immutable reviewed SHA.

## Workflow

1. Read the relevant local `AGENTS.md` files before editing:
   - `src/agents/AGENTS.md` for agent/import hotspots.
   - `src/channels/AGENTS.md` and `src/plugins/AGENTS.md` for plugin/channel
     laziness.
   - `src/gateway/AGENTS.md` for server lifecycle tests.
   - `test/helpers/AGENTS.md` and `test/helpers/channels/AGENTS.md` for shared
     contract helpers.
   - `src/infra/outbound/AGENTS.md` for outbound/media/action tests.
2. Establish a baseline before changing code:
   - Prefer `pnpm test:perf:groups --full-suite --allow-failures --output <file>`
     for full-suite ranking.
     `--allow-failures` retains diagnostic reports; inspect `failed`, each run's
     `status`, and logs. A report written with exit 0 does not make failed tests
     pass. Full-suite reporting changes isolation/worker defaults, so retain the
     original failing command, shard, concurrency, and order as separate proof.
   - For bundled plugin breadth, run the smallest relevant `pnpm
test:extensions:batch <plugin[,plugin...]>` or plugin-inspector command
     before jumping to the full extension sweep.
   - For a scoped hotspot use:
     `/usr/bin/time -v pnpm test <file-or-files> --maxWorkers=1 --reporter=verbose`
     in Linux (`-l` is the macOS variant). Record this serial timing as a
     diagnostic; it cannot replace a concurrency-sensitive reproduction.
   - For import-heavy suspicion add:
     `OPENCLAW_VITEST_IMPORT_DURATIONS=1 OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN=1`.
3. Separate wall/runner noise from real file cost:
   - Compare Vitest duration, test body timing, import breakdown, wall time, and
     max RSS.
   - Re-run single files when grouped/full-suite numbers look stale or noisy.
   - If a grouped run fails while JSON says assertions passed, inspect the
     wrapper exit, stderr, timeout, and worker lifecycle. Keep it a failing gate
     until explained and repaired; a focused pass alone does not clear it.
4. Pick the next attack by return and risk:
   - High return: one file/test dominates seconds or RSS and has a clear root.
   - High leverage: one plugin or SDK barrel causes every plugin-inspector or
     extension-batch run to load broad runtime.
   - Lower risk: static descriptors, target parsing, routing, auth bypass,
     setup hints, registry fixtures, or test server lifecycle.
   - Higher risk: real memory/runtime behavior, live providers, protocol
     contracts, or broad production refactors.
5. Fix the root cause, not the symptom:
   - Move static metadata/parsing into narrow helpers or lightweight artifacts
     reused by full runtime and fast paths.
   - Prefer dependency injection, loaded-plugin-only lookup, explicit fixtures,
     and pure helpers over broad mocks.
   - Reuse suite-level servers/clients when a fresh handshake is irrelevant.
   - Keep schedulers/background loops off unless the test proves scheduling.
   - In plugin paths, move static metadata into manifest/lightweight artifacts
     and keep runtime plugin loads behind explicit execution boundaries.
6. Preserve coverage shape:
   - Do not delete a slow integration proof unless the exact production
     composition is extracted into a named helper and tested.
   - Keep one cheap integration smoke when cross-component wiring matters.
   - State explicitly what incidental coverage was removed, if any.
7. Re-benchmark the same command after the change and compute seconds plus
   percent gain.
8. Update the running report when requested or when this thread is tracking one.
   Include before/after commands, artifacts, coverage notes, verification, and
   next attack order.
9. Commit with `scripts/committer "<message>" <paths...>` and push when the
   user asked for commits/pushes. Stage only files touched for this attack.

## Plugin-Suite Workflow

Use this section when perf work involves bundled plugins, plugin-inspector, SDK
barrels, package-boundary tests, or extension suites.

1. Map the suite shape first:
   - source tests: `pnpm test extensions/<id>` or `pnpm test:extensions:batch <id>`
   - package boundaries: `pnpm run test:extensions:package-boundary:canary` and
     `pnpm run test:extensions:package-boundary:compile`
   - all bundled source tests: `pnpm test:extensions`
   - plugin import memory: `pnpm test:extensions:memory -- --json .artifacts/test-perf/extensions-memory.json`
   - plugin-inspector/report work: keep report primitives in `plugin-inspector`;
     keep wrappers thin and collect peak RSS when the command supports it.
2. Start narrow, then widen:
   - one plugin changed: run that plugin's tests and plugin-inspector slice.
   - SDK/public barrel changed: add representative provider, channel, memory,
     and feature plugins.
   - loader/runtime mirror changed: add package-boundary checks and build/package
     proof as needed.
   - unknown shared plugin behavior: run `test:extensions:batch` groups before
     `pnpm test:extensions`.
3. Treat plugin-inspector failures as product signals:
   - JSON must parse.
   - warnings/errors must be classified, not hidden.
   - runtime capture should be quiet and config-tolerant.
   - command output should include wall time, exit code, and peak RSS when
     available.
4. For broad or package-heavy plugin proof, use root Validation's selected
   environment. Reuse a task-owned Linux checkout/dependency volume across
   comparisons, preserve required hosted/native gates, and clean up only this
   task's resources.
5. If plugin performance is package-artifact sensitive, switch to
   `release-openclaw-plugin-testing` and Package Acceptance rather than
   trusting source-only timing.

## Metric Collection

Collect at least one stable metric before and after. Prefer the same machine and
same command, runtime, dependency state, and task-owned environment when possible.

| Metric          | Use for                            | Preferred source                                                           |
| --------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| wall time       | user-visible suite cost            | Linux `/usr/bin/time -v`, test wrapper duration                            |
| Vitest duration | test body/import cost              | Vitest output per file/shard                                               |
| import duration | broad barrel/runtime loads         | `OPENCLAW_VITEST_IMPORT_DURATIONS=1`                                       |
| max RSS         | memory pressure and OOM risk       | Linux `/usr/bin/time -v`, `pnpm test:extensions:memory`, wrapper summaries |
| CPU/user/sys    | CPU-bound vs wait-bound split      | Linux `/usr/bin/time -v`, CPU profiles from the Vitest profiling wrapper   |
| heap snapshots  | real leak vs retained module graph | `openclaw-test-heap-leaks` workflow                                        |

Local scoped command with CPU/RSS:

```bash
timeout 240 /usr/bin/time -v pnpm test <file> --maxWorkers=1 --reporter=verbose
```

Plugin import memory profile:

```bash
pnpm build
pnpm test:extensions:memory -- --top 20 --json .artifacts/test-perf/extensions-memory.json
```

Targeted plugin import memory:

```bash
pnpm test:extensions:memory -- --extension discord --extension telegram --skip-combined
```

CPU and sampling-heap escalation:

```bash
pnpm test:perf:profile:main --output-dir .artifacts/test-perf/main -- <file>
pnpm test:perf:profile:runner --output-dir .artifacts/test-perf/runner -- <file>
```

These map to `scripts/run-vitest-profile.mjs`: main mode writes CPU profiles;
runner mode writes CPU profiles and sampling `.heapprofile` artifacts. Both
default to the unit config and no file parallelism. They supplement the original
reproducer, including any different config/shard/concurrency. Sampling profiles
are not full `.heapsnapshot` files and cannot be read by `heapsnapshot-delta.mjs`.

Use `openclaw-test-heap-leaks` when RSS keeps growing across intervals, workers
OOM, or the suspect command has app-object retention. Do not call RSS growth a
leak until snapshots or retainers support it.

## Common Root Causes

- Full bundled channel/plugin runtime loaded for static data.
- `getChannelPlugin()` fallback used when an already-loaded fixture or pure
  parser would suffice.
- Broad `api.ts`, `runtime-api.ts`, `test-api.ts`, or plugin-sdk barrels pulled
  into hot tests.
- SDK root aliases or package barrels pulling focused subpaths back into a broad
  plugin graph.
- Plugin-inspector loading runtime code just to render metadata, reports, or CI
  policy scores.
- Bundled plugin capture reusing real config/home state instead of synthetic,
  redacted, isolated state.
- Partial-real mocks using `importActual()` around broad modules.
- `vi.resetModules()` plus fresh imports in per-test loops.
- Test plugin registry seeded in `beforeAll` while runtime state resets in
  `afterEach`.
- Per-test gateway/server/client startup when state reset would suffice.
- Runtime/default model/auth selection paid by idle snapshots or fixtures.
- Plugin-owned media/action discovery triggered before checking whether args
  contain plugin-owned fields.
- Unmeasured config/shard/import cost in current grouped reports, hiding the
  real hotspot or attributing shared-worker retention to the wrong file.
- Parallel Vitest runs sharing `node_modules/.experimental-vitest-cache` without
  distinct `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` values.

## Benchmark Commands

Scoped file:

```bash
timeout 240 /usr/bin/time -v pnpm test <file> --maxWorkers=1 --reporter=verbose
```

Scoped file with import breakdown:

```bash
timeout 240 /usr/bin/time -v env \
  OPENCLAW_VITEST_IMPORT_DURATIONS=1 \
  OPENCLAW_VITEST_PRINT_IMPORT_BREAKDOWN=1 \
  pnpm test <file> --maxWorkers=1 --reporter=verbose
```

Grouped suite:

```bash
pnpm test:perf:groups --full-suite --allow-failures \
  --output .artifacts/test-perf/<name>.json
```

Compare grouped reports from equivalent environments:

```bash
pnpm test:perf:groups:compare .artifacts/test-perf/before.json \
  .artifacts/test-perf/after.json
```

Extension batch:

```bash
pnpm test:extensions:batch <plugin[,plugin...]> -- --reporter=verbose
```

All extension tests:

```bash
pnpm test:extensions
```

Package-boundary plugin checks:

```bash
pnpm run test:extensions:package-boundary:canary
pnpm run test:extensions:package-boundary:compile
```

Reuse an existing Vitest JSON report:

```bash
pnpm test:perf:groups --report <vitest-json> \
  --output .artifacts/test-perf/<name>.json
```

## Verification

- Always run the targeted test surface that proves the change.
- For source changes, classify with `node scripts/check-changed.mjs --dry-run`,
  then run all selected checks under root Validation. In the selected trusted
  Linux environment use `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 node
scripts/check-changed.mjs` to retain checks without backend auto-delegation.
- For test-only changes, run `pnpm test:changed` or the exact edited tests.
- Run `pnpm build` when touching lazy-loading, bundled artifacts, package
  boundaries, dynamic imports, build output, or public surfaces.
- For plugin SDK/barrel/runtime changes, add `pnpm plugin-sdk:api:check` or
  `pnpm plugin-sdk:api:gen` when the API surface may drift.
- For plugin-suite perf fixes, verify at least one representative plugin batch
  plus the changed gate; use Package Acceptance if the bug only exists in a
  packed artifact.
- If deps are missing/stale, provision them only in the environment permitted
  by root Validation and retry the exact failed command once. Missing proof
  remains a gap; do not reconcile a Windows linked/sparse checkout.
- Use the report format:

```markdown
| Metric         | Before |  After |          Gain |
| -------------- | -----: | -----: | ------------: |
| File wall time |   `Xs` |   `Ys` |  `-Zs` (`P%`) |
| Max RSS        |  `XMB` |  `YMB` | `-ZMB` (`P%`) |
| CPU user/sys   | `X/Ys` | `A/Bs` |       explain |
```

## Handoff

Keep the final concise:

- Root cause.
- Suite/plugin scope.
- Files changed.
- Before/after wall, Vitest/import, CPU, and RSS numbers where available.
- Leak classification if memory was involved: real leak, retained module graph,
  or inconclusive.
- Coverage retained.
- Verification commands.
- Environment identity, reviewed SHA/patch identity, actual exits, artifact paths,
  and workflow URLs for hosted proof; state any remaining gaps.
- Commit hash and push status.
