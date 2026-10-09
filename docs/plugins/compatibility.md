---
summary: "Plugin compatibility contracts, deprecation metadata, and migration expectations"
title: "Plugin compatibility"
read_when:
  - You maintain an OpenClaw plugin
  - You see a plugin compatibility warning
  - You are planning a plugin SDK or manifest migration
---

OpenClaw keeps older plugin contracts wired through named compatibility
adapters before removing them. This protects existing bundled and external
plugins while the SDK, manifest, setup, config, and agent runtime contracts
evolve.

## Compatibility registry

Plugin compatibility contracts are tracked in the core registry at
`src/plugins/compat/registry.ts`. Each record has:

- a stable compatibility code
- status: `active`, `deprecated`, `removal-pending`, or `removed`
- owner: `sdk`, `config`, `setup`, `channel`, `provider`, `plugin-execution`,
  `agent-runtime`, or `core`
- introduction and deprecation dates when applicable
- an exact removal date once the owning maintainer approves it; an omitted
  `removeAfter` keeps a deprecated surface ineligible for removal
- replacement guidance
- docs, diagnostics, and tests that cover the old and new behavior

The registry is the source for maintainer planning and future plugin
inspector checks. If a plugin-facing behavior changes, add or update the
compatibility record in the same change that adds the adapter.

Doctor repair and migration compatibility is tracked separately at
`src/commands/doctor/shared/deprecation-compat.ts`. Those records cover old
config shapes, install-ledger layouts, and repair shims that may need to
stay available after the runtime compatibility path is removed.

Release sweeps should check both registries. Do not delete a doctor
migration just because the matching runtime or config compatibility record
expired; first verify there is no supported upgrade path that still needs
the repair. Revalidate each replacement annotation during release planning
too, since plugin ownership and config footprint can change as providers
and channels move out of core.

## Deprecation policy

OpenClaw should not remove a documented plugin contract in the same release
that introduces its replacement. Migration sequence:

1. Add the new contract.
2. Keep the old behavior wired through a named compatibility adapter.
3. Emit diagnostics or warnings when plugin authors can act.
4. Document the replacement and timeline.
5. Test both old and new paths.
6. Wait through the announced migration window.
7. Remove only with explicit breaking-release approval.

Deprecated records include a warning start date, replacement, and docs link.
An unconditional removal window ends no more than three months after warnings
start. A named SDK-owner decision may instead retain a shipped contract until
minimum supported published readers migrate, without setting a final date.
Conditional elapsed windows use `removal-pending`, preserving the original date
and explicit blocker; permanent supported contracts use `active`.

## Current compatibility areas

The July 2026 sweep removed the expired root SDK, manifest, provider, runtime,
registry-flag, and plugin-owned web-config aliases. Doctor migrations remain
separately tracked so supported upgrade paths can still repair old config.

The remaining dated compatibility areas are:

- the August and September SDK subpath windows listed in the migration guide
- the beta.5 session-store bridge
- the shipped agent-harness SDK aliases, whose removal is pending a new
  externally documented migration decision
- the October 2026 SDK annotation families listed below

Active, undated registry records cover supported behavior rather than removal
debt, including activation hints, plugin capture, bundled plugin enablement,
and the generated channel-config fallback.

The annotation-only compatibility audit added these dated records. Their
`removeAfter` date is an earliest review date, not permission to remove a
surface while its stated reader or migration condition remains unmet. The ten
October 1 annotation families are `removal-pending`, with their original dates
and removal conditions preserved in the review queue. This does not claim
completed migration of published readers.

| Compatibility code                        | Removal condition                                                                                       | `removeAfter` |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------- |
| `plugin-sdk-channel-setup-input-fields`   | Repeat the published-plugin artifact sweep and remove only fields with no reader.                       | 2026-10-01    |
| `plugin-sdk-broad-runtime-barrels`        | Move bundled and indexed external consumers to focused SDK subpaths.                                    | 2026-10-01    |
| `plugin-sdk-provider-owned-helper-shims`  | Move each deprecated provider helper to its provider-local API and prove no published reader remains.   | 2026-10-01    |
| `message-presentation-legacy-bridges`     | Move reply producers and official channel packages to `MessagePresentation`.                            | 2026-10-01    |
| `plugin-sdk-focused-compat-aliases`       | Prove every enumerated alias has no bundled or published reader.                                        | 2026-10-01    |
| `agent-harness-terminal-result-aliases`   | Move harnesses to `terminal` and `visibleReplies`, then prove the legacy result fields are unread.      | 2026-10-01    |
| `official-plugin-export-aliases`          | Move users of Google Meet testing, channel presentation, and Discord timeout exports to canonical APIs. | 2026-10-01    |
| `memory-host-compatibility-aliases`       | Use canonical memory tables while preserving existing custom-table data during migration.               | 2026-10-01    |
| `plugin-runtime-api-compat-aliases`       | Move flat plugin registration/runtime calls to their namespaced or focused replacements.                | 2026-10-01    |
| `plugin-provider-manifest-compat-aliases` | Move kind/setup/catalog ownership to manifests and model-catalog registration.                          | 2026-10-01    |
| `deprecated-session-store-beta5-api`      | End the v2026.7.x whole-store upgrade window, including package-root aliases.                           | 2026-10-12    |

Discord and Slack retain their published legacy renderer exports as conversion
adapters to the canonical presentation renderers. Bundled channel callers use
presentation rendering after converting legacy payloads; Telegram no longer
owns a separate private legacy renderer. Legacy payload fields remain supported
until the producer and reader removal conditions above are satisfied.

The private memory-host package no longer re-exports `loadConfig`. Memory
callers use prepared config or `getRuntimeConfig`. Custom cache and FTS table
overrides remain supported to preserve existing data.

`pnpm plugins:boundary-report` reports `removal-pending` records separately
from deprecated records. A due `removal-pending` record remains blocked until
its reported migration condition is satisfied and its reader references are
cleared; the existing `--fail-on-eligible-compat` gate continues to apply only
to dated `deprecated` records. Reader references are surface-token matches for
triage; use the published-artifact sweep before authorizing removal.

### Channel prompt-context identifier aliases

New channel plugins should use `MsgContext.ChannelPromptContext`,
`MsgContext.ChannelStructuredContext`, `ChannelStructuredContextEntry`, and
`SupplementalContextFacts.channelStructuredContext`. The older
`UntrustedContext`, `UntrustedStructuredContext`,
`UntrustedStructuredContextEntry`, and supplemental `untrustedContext` names
remain as deprecated SDK aliases. Their 2026-09-08 review date is unchanged,
but `sdk-untrusted-context-identifier-aliases` is `removal-pending` until
published-reader migration is verified and explicit breaking-release approval
is granted. Inbound finalization folds those
deprecated fields into the channel-named fields and removes the old keys from
runtime context.

The security runtime similarly exports `buildChannelMetadata`; the deprecated
`buildUntrustedChannelMetadata` alias remains available under the same pending
removal conditions.

### Retired channel compatibility surfaces

The `subagent_spawning` hook, explicit channel target parser, and
`openclaw/plugin-sdk/messaging-targets` have been removed. Use
`subagent_spawned` for observation, channel session-binding adapters for thread
routing, and `messaging.targetResolver` for normalization. Third-party plugins
keep transport-specific parsing plugin-owned. The JavaScript-only private
`openclaw/plugin-sdk/channel-targets` host surface remains available for official
plugins; it is not a typed third-party replacement.

WhatsApp `WebInboundMessage` callbacks now require the canonical nested
`event`, `payload`, `platform`, and `admission` contexts. Optional quote and group
data use the nested `quote` and `group` contexts.
`LegacyFlatWebInboundMessage`, `WebInboundMessageInput`, flat callback aliases,
and top-level admission aliases have been removed. Read conversation identity
from `admission.conversation.id`, account identity from `admission.accountId`,
conversation kind from `admission.conversation.kind`, and the access decision
from `admission.ingress.decision`.

The five broad SDK facades retired under the September 30 SDK-owner decision
are `channel-lifecycle`, `channel-message`, `channel-reply-pipeline`,
`config-runtime`, and `infra-runtime`. Their migration mappings are in the
[SDK migration guide](/plugins/sdk-migration). Published channel setup schemas
and helpers used through `2026.7.1` remain supported; their owner restored a
reader-based removal gate without a fixed date.

## Plugin inspector package

The plugin inspector should live outside the core OpenClaw repo as a
separate package/repository backed by the versioned compatibility and
manifest contracts. The day-one CLI should be:

```sh
openclaw-plugin-inspector ./my-plugin
```

It should emit manifest/schema validation, the contract compatibility
version being checked, install/source metadata checks, cold-path import
checks, and deprecation/compatibility warnings. Use `--json` for stable
machine-readable output in CI annotations. OpenClaw core should expose
contracts and fixtures the inspector can consume, but should not publish the
inspector binary from the main `openclaw` package.

### Maintainer acceptance lane

Use Crabbox-backed Blacksmith Testbox for the installable-package acceptance
lane when validating the external inspector against OpenClaw plugin
packages. Run it from a clean OpenClaw checkout after the package is built:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json --shell -- "pnpm install && pnpm build && npm exec --yes @openclaw/plugin-inspector@0.1.0 -- ./extensions/telegram --json"
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json --shell -- "npm exec --yes @openclaw/plugin-inspector@0.1.0 -- ./extensions/discord --json"
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json --shell -- "npm exec --yes @openclaw/plugin-inspector@0.1.0 -- <clawhub-plugin-dir> --json"
```

Keep this lane opt-in for maintainers, since it installs an external npm
package and may inspect plugin packages cloned outside the repo. The local
repo guards cover the SDK export map, compatibility registry metadata,
deprecated SDK-import burn-down, and bundled extension import boundaries;
Testbox inspector proof covers the package as external plugin authors
consume it.

## Release notes

Release notes should include upcoming plugin deprecations with target dates
and links to migration docs, before a compatibility path moves to
`removal-pending` or `removed`.
