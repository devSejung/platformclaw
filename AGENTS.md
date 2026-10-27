# PlatformClaw agent policy

Keep this root under 20,000 characters. Root owns hard policy and routing; guides own details. Read matching guides in full, including cross-directory callers. Update rules at their owner.

## Project boundary

- This repository is PlatformClaw, a private downstream of OpenClaw.
- Read `PLATFORMCLAW.md` before PlatformClaw planning or implementation. Read `docs/upstream/status.md` before upstream sync or feature migration.
- `origin` is the private PlatformClaw repository; `upstream` is the official OpenClaw repository. Preserve OpenClaw Git ancestry and the common ancestor; minimize upstream divergence.
- Use `feature/*` for features, `fix/*` for fixes, and `refactor/*` for refactors. Perform upstream integration on a temporary `sync/upstream-YYYYMMDD` branch; never apply unverified upstream changes directly to `main`.
- Windows is the development host; Ubuntu Linux Docker is the final runtime and validation authority. Do not depend on Windows-only paths or commands, CRLF, or case-insensitive filesystem behavior.
- On Windows linked worktrees, never run `pnpm install` and never run Git restore/checkout/reset against tracked `node_modules` paths. pnpm creates recursive workspace junctions there; Git can follow them and delete the worktree root. Reuse the primary checkout toolchain through repository wrappers or validate remotely. The tracked post-checkout/post-merge hook must install the junction guard in every worktree before other Git operations.
- PlatformClaw features prefer existing plugin, provider, adapter, hook, registry, or SDK boundaries. Do not spread enterprise-only logic across OpenClaw core.
- Migrate the previous PlatformClaw one small capability at a time; never copy it wholesale.
- Never commit credentials, internal data, private URLs, user workspaces, logs, or runtime databases.
- Use the host application's built-in agents by default for delegation under the Repair Doctrine below. External agent runners require an explicit user request.
- At a functional checkpoint, start autoreview and the relevant lint, typecheck,
  and focused tests concurrently when the repository lock and available runner
  permit it. Collect both result sets before patching so one fix cycle addresses
  review and verification findings together.
- After that fix cycle, rerun only the affected checks before PR creation. Do
  not repeatedly alternate autoreview and broad CI for each small edit.
- Preserve upstream test, review, security, and release requirements. For PlatformClaw, the Validation section below owns execution-environment selection and supersedes upstream runner defaults in scoped guides, skills, and CI runbooks. Report other conflicts; never resolve them by weakening a required gate.

## Repair Doctrine and execution

- Read `PLATFORMCLAW.md`, `VISION.md`, nearest scoped `AGENTS.md`, and matching task guides before work; also `docs/upstream/status.md` before sync/migration. Read sparse omitted guides with `git show HEAD:<path>`; omission is not a missing contract.
- Inspect `git status -sb` before editing or GitHub work. Preserve unrelated changes, branches, checkouts, processes, and user services; serialize shared Git mutations. Never switch a checkout another agent or test uses.
- Check existing solutions briefly before custom work. Prefer adequate maintained plugins/libraries/free platforms. Paid recommendations/spend need approval.
- Repair invariants at their owner. Read complete modules, entrypoints, callers/callees, siblings, tests, docs, history, shipped behavior, and dependency contracts. No arbitrary investigation bounds or diff-only verdicts. Fix connected defects or record follow-ups.
- Keep one canonical path; remove connected stale policy, wrappers, fallbacks, and duplicate state. Compatibility needs a cited contract/observed production state and migration/removal plan.
- Delegate useful independent work to the host's built-in agents; give clear responsibility and completion criteria. Primary agent stays hands-on and verifies consequential evidence. External agent runners require an explicit user request.
- After two identical tooling failures without new evidence, or 10 min without progress, switch to an authorized supported alternative. Pin the reviewed revision where applicable, reconcile uncertain writes first, and never bypass trust, gates, or host restrictions.
- Reproduce at the real failing entrypoint. Could proof pass while the defect remains? Failed setup is a proof gap. Add checks for a named unknown/risk/gate; reuse valid evidence and finish when requested behavior and required gates are proven.
- Dependency-backed behavior needs direct source/docs/types inspection. External API work also needs live verification and current official proof. Never print secrets.
- **Codex hard gate:** personally inspect exact sibling `../codex` runtime/protocol source before any Codex verdict/comment/approval/merge recommendation/change/proof claim. Clone `https://github.com/openai/codex.git` there if missing. Reports, wrappers, schemas, memory, and prior reviews do not substitute. Cite checked paths/lines.
- Say "plugins" in product/docs/UI/changelog; `extensions/` is internal. Preserve OpenClaw CLI/API/package/path/config names. Use American English and repo-root reply references.
- Edit canonical `AGENTS.md` files only; new `AGENTS.md` files need sibling `CLAUDE.md` symlinks. Keep compatibility aliases pointed at the canonical file. Run the docs inventory before docs/user-visible work.
- Never edit `node_modules`. Local-only `.agents` ignores belong in `.git/info/exclude`, not repo `.gitignore`.

## Product and architectural gates

- Silent failure is worse than a crash or missing feature. Every action needs a visible outcome or recorded non-outcome. Defaults, onboarding, actionable failures, and accurate tool/prompt text are product requirements. Default-off capability needs an enablement path.
- Core is plugin-agnostic; owner plugins own vendor/channel/auth/catalog/default policy. Cross only documented SDK/manifest/public barrels. Dependencies follow runtime ownership. Read Architecture before boundary changes.
- Prefer existing owners/integrations/plugin contracts. A missing capability may justify a narrow SDK/core seam with bundled callers migrated together; justify universal core surface and context cost.
- Runtime consumes only canonical config/data. Doctor/migration owns normalization and persistent-state cutover; no runtime aliases, dual writes, fallback readers, or speculative compatibility. Config changes align types/schema/help/metadata/docs and matching doctor repair.
- Runtime state/cache/queues use SQLite; files need a named artifact/external contract. Use the proper shared/agent DB and Kysely. Plan asynchronously before synchronous write transactions. **Schema-version bumps need explicit discussion and acceptance.** Compatible additive tables do not need a bump; follow Architecture.
- Protocol changes are additive first; incompatible contracts need versioning/docs/client follow-through. **Protocol bumps, dependency patches/overrides/vendoring, and releases/publishing/version changes require explicit approval.** New config/env surfaces must satisfy Architecture's necessity/compatibility rules and applicable owner gates. Preserve the Carbon dependency owner-only restriction.
- Security-sensitive credentials, approvals, execution, and external side effects need current owner-held authority; revalidate after awaited work and before the effect. Tokens/IDs alone do not prove current authority. Use idempotency and point-of-effect checks for internal bookkeeping.
- Preserve transcript bytes and bounded deterministic context. Serve required guidance whole; only compaction rewrites history. Stable prompt mutations defer to next session unless explicitly opted in. No static references to unavailable cross-toolset tools.
- Count production/test LOC separately; justify production growth by capability, ownership, security, or contract. No assertions/mocks/retries/timeouts/test environments/casts/suppressions that mask owner defects. Preserve non-obvious invariant comments.

## Validation

- Routing owner: this section selects where PlatformClaw checks run. Use `$openclaw-testing` for the required test matrix; scoped guides and skill recipes retain their scenario, review, and evidence requirements, but their remote-runner defaults or dependency-install locations do not override this routing policy or host constraints.
- Unavailable backends: Crabbox and Testbox are unavailable on this host. Do not probe, warm, invoke, retry, or auto-delegate to either unless the user explicitly confirms restoration. An inherited skill recipe or wrapper default is not that confirmation. Do not set `OPENCLAW_PR_GATES_REMOTE=testbox`.
- Source trust first: untrusted contributor/fork code, including its scripts, checks, config, wrappers, and install hooks, never runs on the host, Docker Desktop, WSL, or a credentialed/hydrated runner. Use existing secretless fork CI at the immutable reviewed full SHA; no local fallback. Keep trusted orchestration separate from candidate code, use an isolated HOME and pinned runtime/package manager, and exclude operator credentials/auth profiles, secret-bearing env, instance roles, tailnet/LAN access, and ambient `NODE_OPTIONS`. If suitable CI is unavailable, report the proof gap. Maintainer approval of credentialed execution after review makes code trusted; an explicit owner/maintainer instruction to land named, reviewed PRs supplies that approval.
- Trusted small proof: run one/few focused tests, `git diff --check`, targeted formatting/lint, and cheap static checks on the host only when the existing dependencies are ready. Keep repo wrappers, heavy-check locks, Vitest cache isolation, and checkout ownership intact.
- Trusted heavy or Linux proof: full suites, typecheck/lint fan-out, builds, Docker/packaging, E2E, live, and production-style proof use local Docker Desktop Linux containers first. Use a healthy local WSL distribution when Docker is unsuitable for the required scenario. Ubuntu Linux remains runtime authority; Linux prompt snapshots use Node 24. Use a separate Linux checkout/dependency volume, never install through a bind mount onto the Windows checkout or its `node_modules`.
- Required hosted/native proof: use existing GitHub Actions workflows when a required OS/device/hosted gate cannot be proven by Docker/WSL, or an existing hosted gate is mandatory. Verify repository/auth/workflow support before dispatch, keep immutable target SHA/patch identity and required permissions, and reuse valid exact-head evidence. Docker/WSL success does not replace native, live-channel, packaged-upgrade, release, or mandatory hosted gates. If the environment is unavailable, report the missing proof instead of treating a substitute as passing.
- Checks are unchanged: run required focused regression and sibling tests, `tsgo` typechecks, lint/format, SDK/script-declaration gates, conditional builds, autoreview, scenario proof, and release validation. Keep PlatformClaw quick/full checks from `PLATFORMCLAW.md`; in the trusted Linux environment, set `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1` for full PlatformClaw checks that invoke `check:changed`. Do not fake `CI`, weaken assertions, change baselines/ignores, or set skip flags to obtain a pass.
- Dependency and resource lifecycle: provision dependencies only in the permitted environment; never run `pnpm install` or reconciliation in Windows linked/sparse worktrees. Acquire containers/WSL sessions only when needed, reuse a task-owned environment with current source, and clean up only resources this task created. Never stop operator containers/services, change another agent's checkout, mount the host Docker socket into untrusted execution, or expose real runtime state/credentials to tests.
- Visual/live proof: exercise the real operator scenario and inspect screenshots through available browser/capture tools in the selected environment. Retain required channel/Desktop/native proof and sanitized before/after evidence; no mock/harness/bypass substitutes unless explicitly authorized by the owning proof contract.
- Evidence: record actual environment, exact commands, reviewed SHA or dirty-patch identity, exits/results, evidence paths or CI run URLs, and limitations. Unknown outcomes and missing proof remain gaps. A pre-dispatch infrastructure failure is not a test verdict; preserve any actual failing gate and rerun only the affected checks after fixes.
- Worktree and formatting wrappers: use direct `node` wrappers for bounded host checks; use existing formatter binaries without `pnpm exec` reconciliation. Run pnpm-gated or dependency-missing checks in the selected trusted Linux environment. Repo-native PR worktrees may omit `node_modules`; use `git commit --no-verify` only after the relevant proof is clean.
- Parallel agents share the checkout; never switch its branch while sibling work runs.
- QA CLI `--output-dir` must be repo-relative.
- Before handoff/push: prove touched surface. Before landing to `main`: proof matches actual risk. Bounded behavior-neutral refactor: focused tests/checks enough; no issue proof or full/broad suite by default.
- Release-branch full validation: freeze the product-complete **Code SHA**, then use `node scripts/full-release-validation-at-sha.mjs --sha <code-sha> --target-ref release/YYYY.M.PATCH`; no raw dispatch without `target_context_ref`.
- Pre-land/pre-commit code changes: mandatory fresh `$autoreview` until no accepted/actionable findings remain. Do not land code on CI, ClawSweeper, prior review comments, or your own manual review alone unless user explicitly opts out or scope is truly trivial/docs-only. If findings want refactor, refactor; no ugly fixes. Autoreview staged/uncommitted diff: `--mode uncommitted`; there is no `dirty` or `staged` mode.
- If proof is blocked, say exactly what is missing and why.
- Do not land related failing format/lint/type/build/tests. If unrelated on latest `origin/main`, say so with scoped proof.
- Landing PR onto red `main` (unrelated breakage blocks the merge gate): fix the breakage in the same landing PR; note it in the PR body; never land onto red or bypass the gate. Prefer the smallest correct fix (e.g. register a missing source file, add a dropped export).
- Docs/changelog-only and CI/workflow metadata-only: `git diff --check` plus relevant docs/workflow sanity; escalate only if scripts/config/generated/package/runtime behavior changed.
- Prompt snapshots: CI truth is Linux Node 24. If macOS local passes but CI drifts, reproduce/generate in Linux before rerun.

## Authority, review, and delivery

- Task scope supplies authorization; silence does not. Keep credentials, internal data, private URLs, user workspaces, runtime DBs, and logs out of commits. Changes to operator Gateway/live state/services require per-task approval; tests use task-owned state/ports or copies.
- Preserve CODEOWNERS restrictions and listed-owner review. No unsolicited labels/retitles/rebases/landing. Public messaging and GitHub mutations need task authority; automated out-of-scope/won't-implement closes remain maintainer decisions.
- Code commits/landing require fresh autoreview until no accepted/actionable finding remains, except explicit user opt-out or truly trivial/docs-only scope. Keep relevant lint/typecheck/focused tests concurrent with checkpoint review when locks permit; collect results before fixing, then rerun only affected checks.
- Every review must assess the best fix using current/shipped behavior, callers/callees, siblings, tests/CI, and dependency proof. Read the full review guide before any PR verdict. Apply or explicitly explain every ClawSweeper rank-up move; after a changed head request one exact-head re-review and do not land with actionable findings or remaining moves.
- Do not land related failing format/lint/type/build/tests or bypass red-main/PR gate rules. Retain wrapper provenance, operation locks, review artifacts, exact-head hosted evidence, and real behavior proof. Missing runner support is a proof gap, never permission to fabricate or skip evidence.
- `CHANGELOG.md` is release-owned. Normal changes put release-note context in PR/commit text. Release work reads the release guide and freezes Code SHA then changelog-only Release SHA; no reuse of product evidence across code changes and no duplicate publish/rebuild of immutable successful artifacts.
- No manual stash/autostash, unexpected deletion/rename, new worktrees, bulk closes over 50, or destructive resets without the applicable authorization. Stage/commit intended changes only; do not silently absorb unrelated work.
- Direct pushes to `main` preserve linear ancestry and the Git guide's rebase requirements. Wrapper-managed PR landing checks actual mergeability and does not rebase solely because `main` advanced. Follow the GitHub guide for request-specific commit/push/ship sequencing.

## Read when relevant

Read matching task guides in full before acting, including cross-boundary owners. Paths/commands are repo-relative unless stated otherwise. Existing scoped guides still apply.

- **Implementation, repair, refactor, new capability:** [Engineering](.agents/guides/engineering.md), nearest scoped `AGENTS.md`.
- **Plugin/SDK/provider/channel/config/protocol/storage/context/cache/performance:** [Architecture](.agents/guides/architecture.md), touched owner scope guides.
- **Tests, setup, builds, lint/typecheck, proof:** [Testing and commands](.agents/guides/testing.md), root Validation, `scripts/AGENTS.md`, test-helper scope guides.
- **Code/PR review, triage verdict, ClawSweeper, readiness:** [Review](.agents/guides/review.md), Engineering, Testing, affected owners.
- **Issues/PRs, Git, CI, artifacts, commit/push/ship:** [GitHub and Git](.agents/guides/github.md), Review before verdict/landing, `scripts/AGENTS.md` before wrapper work.
- **Security/credentials, dependency policy, release/backport/version/publish:** [Security and releases](.agents/guides/releases.md), Architecture for runtime/security contracts, Testing/Review for release proof.
- **Docs/instructions, publishing/i18n, release-note wording:** [Documentation](.agents/guides/documentation.md), `docs/AGENTS.md`, Releases for generation.
- **Native apps/devices, demos, Gateway, runtime channel/media/memory:** [Operations](.agents/guides/operations.md), Validation, touched scope guides. Runtime messaging modes apply to those product workflows.
- **Control UI:** `ui/AGENTS.md`, Engineering, Testing, Architecture for shared protocol/state.
- **Upstream sync/migration:** `PLATFORMCLAW.md`, `docs/upstream/status.md`, Architecture, Testing, touched owners; keep sync and capability migration separate.

## Repository map

- Core TS: `src/`, `ui/`, `packages/`; plugins: `extensions/`; SDK: `src/plugin-sdk/*`; channels: `src/channels/*`; loader: `src/plugins/*`; protocol: `packages/gateway-protocol/*`; docs/apps: `docs/`, `apps/`.
- Installers: sibling `../openclaw.ai`.
- Scoped guides: `extensions/`, `src/{plugin-sdk,channels,plugins,gateway,agents}/`, `test/helpers*/`, `docs/`, `ui/`, `scripts/`.

Rule preservation and pinned upstream provenance: `.agents/guides/root-rule-map.md` (audit data, not instructions). Guides attribute additions; stricter PlatformClaw gates remain.
