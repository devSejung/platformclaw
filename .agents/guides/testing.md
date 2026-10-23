# Testing and command contracts

Read before choosing or running tests, builds, dependency setup, lint/typechecks, validation, or proof. Read this guide in full. The [root policy](../../AGENTS.md) owns hard gates, task routing, and validation-environment selection. Paths and commands here are relative to the repository root.

Preserved references to the selected Linux environment "below" mean [root Validation](../../AGENTS.md#validation).

## Commands

- Runtime: Node 22.22.3+, 24.15+, or 25.9+; Node 26 recommended (CI and release workflows still pin Node 24). Keep Node + Bun paths working.
- Package manager/runtime: repo defaults only. No swaps without approval.
- Install: `pnpm install` (keep Bun lock/patches aligned if touched), only where the Validation policy permits dependency installation. Reuse the primary checkout toolchain for bounded host proof; prepare separate Linux dependencies for heavy proof.
- CLI: `pnpm openclaw ...` or `pnpm dev`; build: `pnpm build`.
- Never run the CLI as `node --import tsx src/index.ts`: tsx compiles all bundled plugins per process (~220s), the cost lands inside the agent task budget, and the run fails as a misleading `no progress ... timed out`. Use the dist-backed wrappers above.
- Packaged `pnpm build` omits QA Lab + qa-channel by design (source-checkout only). To exercise `openclaw qa`/qa-channel from a built dist, build with `OPENCLAW_BUILD_PRIVATE_QA=1 pnpm build` (emits `dist/plugin-sdk/qa-lab.js`, `qa-runtime.js`, `dist/extensions/{qa-lab,qa-channel}`) or run via `pnpm dev`.
- Test commands: trusted-source focused local proof uses `node scripts/run-vitest.mjs <path-or-filter>`; remote or normal-checkout proof may use `pnpm test <path-or-filter> [vitest args...]`, `pnpm test:changed`, `pnpm test:serial`, or `pnpm test:coverage`. Never raw `vitest`; if unavoidable, `vitest run ...` (bare `vitest` starts local watch mode and never exits). No `--repeat`; use a bounded shell loop around the focused repo test command.
- Host test execution is allowed only for trusted source and one/few focused files when the existing dependency install is ready. In a Codex worktree or linked/sparse checkout, use `node scripts/run-vitest.mjs <path-or-filter>`; never direct host `pnpm test*` or dependency reconciliation. Heavy proof runs in the selected Linux environment below.
- Changed checks: classify trusted source with `node scripts/check-changed.mjs --dry-run [--staged|-- <files...>]` or inspect lanes with `node scripts/changed-lanes.mjs --json`. Select the execution environment under Validation before running the planned checks; bare `check:changed` can auto-delegate to an unavailable backend. Never run repository-controlled classification locally for untrusted source.
- Changed checks in a trusted Codex worktree or linked/sparse checkout: use direct `node` wrappers, not host `pnpm check*`. In the selected trusted Linux environment, use `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 node scripts/check-changed.mjs [--staged|-- <files...>]` to suppress automatic remote delegation while retaining every planned check. This routing guard does not replace or skip validation.
- Extension tests: `pnpm test:extensions`, `pnpm test extensions`, `pnpm test extensions/<id>`.
- Typecheck: `tsgo` lanes only (`pnpm tsgo*`, `pnpm check:test-types`); never add `tsc --noEmit`, `typecheck`, `check:types`.
- Formatting: `oxfmt`, not Prettier. Write paths with `pnpm format <paths>`; no `format:write` script. Checks use repo wrappers (`pnpm format:*`, `scripts/run-oxlint.mjs`; full `pnpm lint:*` only when scope requires).
- SDK surface gate: `pnpm plugin-sdk:surface:check`; no `plugin-sdk:surface-report` script.
- `scripts/*.mjs` exports: matching declaration in sibling `.d.mts` mandatory. `pnpm check:script-declarations` (check-guards) + `check-test-types` enforce; new export without declaration = red CI.
- Script wrappers: failing or crashed run must end with one final `[tool] FAILED (exit N)` stderr line; crash = nonzero exit. Truncated output must never read as success. Pattern: `scripts/run-oxlint.mjs`.
- Tooling crash `Cannot find module ...` right after pulling/merging main: check for stale dependencies before debugging code. Install in the permitted validation environment; the Windows linked-worktree install ban still applies.
- Build before push when build output, packaging, lazy/module boundaries, dynamic imports, or published surfaces can change; use the selected validation environment and retain any required native or hosted proof.

## Tests

- Vitest. Colocated `*.test.ts`; e2e `*.e2e.test.ts`; example models `sonnet-4.6`, `gpt-5.6-luna`; test GPT with Luna preferred; use Sol when capability matters; no GPT-4.x agent-smoke defaults.
- Test where the bugs live: boundaries, not internals. Coverage behind mocks proves the mocks; one test through the real transport/dispatch seam outranks many stub-backed branch tests.
- Prefer invariant assertions (every input accounted for; every action ends in a visible outcome or recorded non-outcome) over enumerating happy paths.
- Inject faults — network, provider, ordering, restart — instead of asserting only success shapes. Changes to delivery, dispatch, or session paths need at least one boundary-level proof (harness or live), not only unit tests of the changed function.
- Shared-state/order failures: reproduce original execution order, repair the writer or lifecycle owner, and add boundary regression coverage. Use tracked environment helpers; never mask producer leaks with consumer-only environment overrides.
- Prefer behavior tests over workflow/docs string greps. Put operator policy reminders in AGENTS/docs.
- A test asserting on files owned by lane X belongs in lane X's suite. A cross-lane assertion may never be selected by PR change classification, so it passes PR CI and first breaks on `main` full runs.
- QA scenario sources are YAML only: `qa/scenarios/index.yaml` and `qa/scenarios/<theme>/*.yaml`. Do not add fenced `qa-scenario`/`qa-flow` Markdown files under `qa/scenarios/`.
- Clean timers/env/globals/mocks/sockets/temp dirs/module state; `--isolate=false` safe.
- Tests asserting resolver/root-containment paths: `fs.realpath` mkdtemp/tmp roots first. macOS `os.tmpdir()` is a `/var` -> `/private/var` symlink; prod resolvers return canonical paths, so raw mkdtemp assertions pass on Linux CI but fail on Mac.
- Explicit `vi.mock` factories must export every binding prod touches, including error classes used in `instanceof` checks; `vi.importActual` the defining module for those instead of stub classes.
- Prefer injection and narrow `*.runtime.ts` mocks over broad barrels or `openclaw/plugin-sdk/*`.
- Do not edit baseline/inventory/ignore/snapshot/expected-failure files to silence checks without explicit approval.
- Do not run independent `pnpm test`/Vitest commands concurrently in one worktree; Vitest cache races with `ENOTEMPTY`. Group one command or use distinct `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH`.
- Never edit source/test files while a Vitest run is in flight in the same checkout; mid-collection reads produce phantom failures and 120s timeouts. Wait for the run to finish, then edit.
- Vitest rejects Jest `--runInBand`; use `OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test` for serial proof. Test workers max 16.
- Live: `OPENCLAW_LIVE_TEST=1 pnpm test:live`; verbose `OPENCLAW_LIVE_TEST_QUIET=0`.
- Live gateway tests: session-owned dev gateway only — isolated `OPENCLAW_STATE_DIR` + free port. Never bind the operator's real gateway port (default 18789) while their gateway runs.
- Never stop/restart/kickstart a gateway service you did not start (launchd/systemd/tmux) or edit its live `~/.openclaw` state/config; that is the operator's running instance — explicit per-task operator approval required.
- Realistic data: copy the state/DB into your dev state dir and test the copy. In-place migration of a live gateway's state needs explicit operator approval.
- Guide: `docs/reference/test.md`.

## Current upstream refinements

- Prove caller-visible behavior through the production owner, with fixed external I/O fixtures and expected values independent of implementation decisions. Name the credible regression and the limits of the test.
- Work in vertical slices: reproduce the defect, repair the owner, prove the repaired behavior. A baseline regression must fail on the defect rather than fixture/setup failure; explicitly record unavailable baseline proof. Use synthetic captures and exclude credentials.

Source: [behavioral boundary proof](https://github.com/openclaw/openclaw/blob/d3eec4c06862499f53f1f259c0daa08096d4ed6e/docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary). Retain all PlatformClaw required focused, sibling, integration/live, hosted, and release gates.
