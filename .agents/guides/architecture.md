# Architecture and runtime contracts

Read before plugin, SDK, provider/channel, config, protocol, storage, context, cache, or performance changes. Read this guide in full. The [root policy](../../AGENTS.md) owns hard gates, task routing, and validation-environment selection. Paths and commands here are relative to the repository root.

## Cross-owner operational contracts

These rules also appear in Operations; architecture/config/provider work must apply them without an Operations task trigger.

- Rebrand/migration/config warnings: run `openclaw doctor`.
- Provider tool schemas: prefer flat string enum helpers over `Type.Union([Type.Literal(...)])`; some providers reject `anyOf`.

## Architecture

- Core stays plugin-agnostic. No bundled ids/defaults/policy in core when manifest/registry/capability contracts work.
- Plugins cross into core only via `openclaw/plugin-sdk/*`, manifest metadata, injected runtime helpers, documented barrels (`api.ts`, `runtime-api.ts`).
- Plugin prod code: no core `src/**`, `src/plugin-sdk-internal/**`, other plugin `src/**`, or relative outside package.
- Core/tests: no deep plugin internals (`extensions/*/src/**`, `onboard.js`). Use public barrels, SDK facade, generic contracts.
- Owner boundary: owner-specific repair/detection/onboarding/auth/defaults/provider behavior lives in owner plugin. Shared/core gets generic seams only.
- Dependency ownership follows runtime ownership: plugin-only deps stay plugin-local; root deps only for core imports or intentionally internalized bundled plugin runtime.
- Internal bundled plugins ship in core dist; bundled-only facade loader ok only for them.
- External official plugins own package/deps and are excluded from core dist; core uses registry-aware `facade-runtime` or generic contracts.
- Externalizing a bundled plugin: update package excludes, official catalogs, docs, tests, and prove core runtime paths resolve installed plugin roots before root-dep removal.
- Runtime reads canonical config only. No silent compat for old/malformed config keys. If a config change invalidates existing files, add a matching `openclaw doctor --fix` migration. Core/auth config repairs live in core doctor; plugin-owned config repairs live in that plugin's doctor contract (`legacyConfigRules` / `normalizeCompatibilityConfig`).
- OpenAI Codex is folded into `openai`. No new/live `openai-codex` provider/plugin/auth/model routes; treat them as legacy input only. Runtime/setup/auth/catalog use `openai` + `openai/*`; doctor/migrations repair stale `openai-codex/*` profiles/metadata.
- Config/env surface bar is high; `openclaw.json` and environment variables are already large. Before adding a config option or env var, first prove existing product behavior, provider selection, defaults, or doctor migration cannot solve it. Prefer removing or consolidating config/env options when touching these surfaces. Core supports only the latest config shape; `openclaw doctor --fix` migrates older shipped shapes into the current one.
- CLI setup flows are public API when external docs, installers, or integrations can copy them. Changes to `openclaw onboard`, `openclaw configure`, their documented flags, non-interactive behavior, or generated config shape are compatibility-sensitive API contract changes; prefer additive flags/aliases, deprecation windows, and backward-preserving migrations over breaking existing snippets.
- Fix shape: Repair Doctrine owns the default. Prefer coherent owner-boundary refactors; remove connected stale abstractions, duplicate policy, dead branches, wrappers, and fallback stacks.
- New binary fallible-operation results use `Result` from `@openclaw/normalization-core/result`; domain-rich outcomes keep named discriminated unions.
- Tests may use observed examples, but prod literals need a short contract reason.
- Compatibility is opt-in. "Shipped" means reachable from a release Git tag; main/GitHub/PR/unreleased code is not shipped.
- Refactor default: one canonical path. Delete the old path unless user explicitly wants compat or the shipped public contract is obvious and cited.
- Reuse the canonical non-array record guard instead of adding local `isRecord` copies. Core, UI, scripts with workspace package resolution, and packages that already depend on normalization-core import `@openclaw/normalization-core/record-coerce`; plugins import `openclaw/plugin-sdk/string-coerce-runtime`. Keep a local guard only when the semantics intentionally differ or the file must remain dependency-free, browser-serialized, generated, or runnable outside workspace package resolution.
- Core runtime consumes only current canonical shapes/config/data. Legacy or retired shapes normalize only in doctor/migration code before runtime; no runtime shims, aliases, or fallback readers.
- State/storage migrations are database-first. Runtime reads/writes the canonical store only. Old file stores, sidecars, aliases, and fallback readers belong in `openclaw doctor --fix` migration code only, never steady-state runtime.
- Storage default: SQLite only. Do not add JSON/JSONL/TXT/sidecar files for OpenClaw-owned runtime state, caches, queues, registries, indexes, cursors, checkpoints, or plugin scratch data.
- Any SQLite change requiring a schema-version bump needs explicit user discussion and acceptance before implementation. Agents must not advance SQLite schema versions autonomously.
- Purely additive SQLite surface (new tables; downgraded builds keep working, just without the new feature): do not bump the schema version. Declare in the canonical schema file plus a one-time idempotent lazy ensure on first feature use; fold into the migration path at the next natural bump. Bumps are reserved for changes older readers cannot tolerate.
- SQLite runtime access uses Kysely helpers, not raw SQL statement strings, except schema DDL, migrations, low-level DB bootstrap, or narrowly justified SQLite primitives.
- SQLite write transactions are synchronous commit sections only. Finish async planning, filesystem access, plugin hooks, and predicates before `BEGIN`; then reread and validate authoritative rows before writing. Never return a Promise or execute `await` from a transaction callback.
- Use the shared state DB (`state/openclaw.sqlite`) for global runtime state and plugin KV data. Use the per-agent DB (`agents/<agentId>/agent/openclaw-agent.sqlite`) for agent-scoped state/cache. Use a dedicated SQLite DB only when schema, volume, or lifecycle clearly does not fit those stores.
- Legacy state/cache files are migration debt. When touching code that reads/writes them, prefer moving the data into SQLite or calling out the refactor follow-up; do not add parallel file paths.
- File storage must be a named product artifact: import/export, user attachment, log, backup, or external tool contract. If it is app state or cache, it belongs in SQLite.
- Before adding any path under state dirs, choose one: shared state DB, plugin KV, agent DB, or dedicated SQLite schema. If none fits, design the SQLite owner/schema first.
- Cache/transient state gets no compat migration unless a shipped user contract is cited. Prefer delete/drop/rebuild over import. If old state can be lost without user-visible data loss, remove the old path entirely.
- Persistent user state gets one migration owner. Doctor migrates, verifies, and then runtime assumes the new shape. No dual-write, read-through fallback, lazy import, or "if SQLite fails use JSON" branches.
- Fallback is a product decision, not an implementation convenience. Before adding one, name the shipped contract, failure mode, removal plan, and why doctor cannot solve it. Otherwise delete it.
- Keep old behavior only for an explicit public API/config/plugin SDK/data contract, tagged upgrade path, security/migration boundary, dependency contract, or observed prod state.
- If unsure, ask before preserving compat. Do not keep aliases, shims, fallback stacks, stale names, or obsolete tests just in case.
- Tests alone do not make internals contracts. If compat stays, name the contract and migration/removal plan in code, test, or PR.
- Lean code is a goal. No internal shims, aliases, legacy names, broad fallbacks, or defensive branches just to reduce diff or handle unrealistic edge cases.
- Handle real production states, tagged upgrade paths, security boundaries, and dependency contracts. Public/hostile/observed malformed input gets care; hypothetical malformed input does not.
- Deprecate shipped public contracts only.
- Plugin SDK exception: shipped external API gets new API first plus named compat/deprecation, small tests/docs if useful, removal plan.
- Migrate internal/bundled callers to modern API in the same change. Do not let internal compat become permanent architecture.
- Channels are implementation under `src/channels/**`; plugin authors get SDK seams. Providers own auth/catalog/runtime hooks; core owns generic loop.
- Message/channel plugins stay transport-only. They render portable presentation/actions, enforce transport limits, and map native callback envelopes. They do not own product command trees, plugin/provider policy, or feature-specific menus.
- Portable command UI must use typed presentation actions, not raw string inference. Do not make channels guess that `value` starting with `/` means a native command; core/owner plugins declare command actions, channels map them when supported.
- Raw callback data is transport/private. Approval, command, URL, web-app, and select actions must stay distinguishable before channel encoding so transport adapters do not special-case product strings.
- Agent run terminal state: normalize/merge via `src/agents/agent-run-terminal-outcome.ts`; do not rederive timeout/cancel precedence in projections.
- Hot paths should carry prepared facts forward: provider id, model ref, channel id, target, capability family, attachment class. Do not rediscover with broad plugin/provider/channel/capability loaders.
- Do not fix repeated request-time discovery with scattered caches. Move the canonical fact earlier; reuse prepared runtime objects; delete duplicate lookup branches.
- Gateway/plugin metadata is process-stable: installs, manifests, catalogs, generated paths, bundled metadata. Changes require restart or explicit owner reload/install/doctor flow.
- Runtime hot paths: no freshness polling (`stat`/`realpath`/JSON reread/hash). Reuse current snapshots, install records, discovery, lookup tables, root scopes, resolved paths.
- Process-local metadata caches ok when lifecycle-owned and bounded/single-slot. Freshness exceptions need named owner + tests.
- Inline comments: preserve reviewer context at the code site. Required for non-obvious cross-path/state invariants, lifecycle ordering, ownership boundaries, queue/dedupe symmetry, TTL/cache expiry, cleanup/release coupling, session/id adoption, fallback behavior, platform/dependency caps, deterministic ordering, compact encoded state, or intentional caller differences.
- Comment shape: 1-3 short lines; state why the branch/helper exists, what contract it protects, and the bad outcome if removed. Cite nearby constants/helpers when useful. No syntax narration, PR/user-specific lore, or obvious mechanics.
- Gateway protocol changes: additive first; incompatible needs versioning/docs/client follow-through.
- Protocol version bumps: explicit owner confirmation only; never automatic/generated.
- Config contract: exported types, schema/help, metadata, baselines, docs aligned. Retired public keys stay retired; compat in raw migration/doctor only.
- Prompt cache: deterministic ordering for maps/sets/registries/plugin lists/files/network results before model/tool payloads. Preserve old transcript bytes when possible.
- Model-context budget: every injected prompt/tool-schema/context item is bounded with a hard cap; no unbounded items. New model-visible text that can cross ~1K tokens is a P0 review flag needing explicit justification. Context builds incrementally; only compaction rewrites history.
- Tool/prompt descriptions never statically name tools from other toolsets/plugins; gating turns the reference into hallucination bait. Needed cross-references are injected at definition-build time from what is actually available. Descriptions state capability, not implementation; no marketing words.
- Guidance the model must apply in full (skills, playbooks, prompt instructions) is served whole: no offset/limit or windowed-read parameters on those tools. Given a window, the model treats the first window as the whole document.
- Prompt-state mutations (skills/tools/memory) default to deferred cache invalidation — effect next session; immediate invalidation is an explicit opt-in.
- Agent tool schema cleanup: remove stale args cleanly; no hidden compat for model-facing params just to avoid churn.

## Current upstream refinements

- Choose the first adequate capability surface: existing owner/integration, existing plugin contract, then a narrow generic SDK/core gap with bundled callers migrated together. A universal core surface needs a fundamental unmet requirement and an explanation of continuing cost; no parallel manager for repeated independent requests.
- Cache, memo, in-flight join, and shared-snapshot identities include every input that changes the answer: agent/account/credential/session/workspace scope and provider set, mode, options, and deadline. Keep volatile values out of keys. Prove sharing and scope isolation with interleaved callers and work-count assertions.
- Credentials, approvals, execution, and external side effects require current authority held by their owner; revalidate after awaited work and before effect. IDs, signatures, or expiry alone do not establish current authority. Internal bookkeeping uses idempotency and a check at effect.

Sources: [capability surface](https://github.com/openclaw/openclaw/blob/d3eec4c06862499f53f1f259c0daa08096d4ed6e/src/plugin-sdk/AGENTS.md#choose-the-capability-surface), [cache identity and authority](https://github.com/openclaw/openclaw/blob/d3eec4c06862499f53f1f259c0daa08096d4ed6e/AGENTS.md#runtime-and-code-safeguards). No upstream-only runtime helper or test path is assumed to exist locally.
