# @openclaw/memory-wiki

Persistent wiki compiler and Obsidian-friendly knowledge vault for **OpenClaw**.

This plugin is separate from the active memory plugin. The active memory plugin still handles recall, promotion, and dreaming. `memory-wiki` compiles durable knowledge into a navigable markdown vault with deterministic indexes, provenance, structured claim/evidence metadata, and optional Obsidian CLI workflows.

When the active memory plugin exposes shared recall, agents can use `memory_search` with `corpus=all` to search durable memory and the compiled wiki in one pass, then fall back to `wiki_search` / `wiki_get` when wiki-specific ranking or provenance matters.

## Modes

- `isolated`: own vault, own sources, no dependency on `memory-core`
- `bridge`: reads public memory artifacts and memory events through public seams
- `unsafe-local`: explicit same-machine escape hatch for private local paths

Default mode is `isolated`.

`vaultMode` controls the wiki's inputs. `vault.scope` separately controls
whether agents share one vault (`global`, the default) or resolve separate
vaults (`agent`).

## Config

Put config under `plugins.entries.memory-wiki.config`:

```json5
{
  vaultMode: "isolated",

  vault: {
    scope: "global", // or "agent"
    path: "~/.openclaw/wiki/main",
    renderMode: "obsidian", // or "native"
  },

  obsidian: {
    enabled: true,
    useOfficialCli: true,
    vaultName: "OpenClaw Wiki",
    openAfterWrites: false,
  },

  bridge: {
    enabled: false,
    readMemoryArtifacts: true,
    indexDreamReports: true,
    indexDailyNotes: true,
    indexMemoryRoot: true,
    followMemoryEvents: true,
  },

  unsafeLocal: {
    allowPrivateMemoryCoreAccess: false,
    paths: [],
  },

  ingest: {
    autoCompile: true,
    maxConcurrentJobs: 1,
    allowUrlIngest: true,
  },

  search: {
    backend: "shared", // or "local"
    corpus: "wiki", // or "memory" | "all"
  },

  context: {
    includeCompiledDigestPrompt: false, // opt in to append a compact compiled digest snapshot to memory prompt sections
  },

  render: {
    preserveHumanBlocks: true,
    createBacklinks: true, // accepted for existing configurations; never rewrites source pages
    createDashboards: true,
  },
}
```

### Per-agent vaults

In agent scope, `vault.path` is a parent directory. OpenClaw appends the
normalized agent id:

```json5
{
  vaultMode: "bridge",
  vault: {
    scope: "agent",
    path: "~/.openclaw/wiki",
  },
  bridge: {
    enabled: true,
    readMemoryArtifacts: true,
  },
  obsidian: {
    useOfficialCli: false,
  },
}
```

This resolves agents such as `support` and `marketing` to
`~/.openclaw/wiki/support` and `~/.openclaw/wiki/marketing`. With no explicit
path, the parent defaults to `~/.openclaw/wiki`; the default `main` agent
therefore keeps the existing `~/.openclaw/wiki/main` path. In global scope,
`vault.path` remains the exact shared vault path.

Wiki tools and compiled prompt/corpus supplements resolve the active runtime
agent on each call. In bridge mode, an agent vault imports only public memory
artifacts whose `agentIds` includes that agent; unowned and other-agent
artifacts are skipped. CLI operations use the configured default agent unless
the command passes `--agent <agentId>`; Gateway operations in multi-agent
setups require `agentId` on the `wiki.*` RPC request.

Configuration validation rejects agent scope with either
`vaultMode: "unsafe-local"` or `obsidian.useOfficialCli: true`. Obsidian-friendly
Markdown rendering still works with agent vaults when official CLI actions are
disabled.

Changing scope does not copy or split existing pages. Back up the vault and
move or import content deliberately. Per-agent paths are a same-process
knowledge boundary, not an operating-system security boundary; unsandboxed
plugins and tools can still access another agent's host files.

## Vault shape

The plugin initializes a vault like this:

```text
<vault>/
  AGENTS.md
  WIKI.md
  index.md
  inbox.md
  entities/
  concepts/
  syntheses/
  sources/
  reports/
  _attachments/
  _views/
  .openclaw-wiki/
```

Compile preserves authored Markdown byte for byte. Generated navigation and dashboards use their own managed blocks; authored documents at reserved report paths remain unchanged.

Key beliefs can live in structured `claims` frontmatter with per-claim evidence, confidence, and status. Compile also persists a machine-readable snapshot in OpenClaw plugin state so agent/runtime consumers do not have to scrape markdown pages.

Links and backlinks are derived metadata for navigation and impact inspection. Search does not require links. Compile never inserts `## Related` blocks into authored pages; `render.createBacklinks` remains accepted for existing configurations without enabling body changes.

When `render.createDashboards` is enabled, compile also maintains report dashboards under `reports/` for open questions, contradictions, low-confidence pages, and stale pages. Generated dashboards do not duplicate source documents in search results.

A failed compile preserves originals and the last successful search snapshot, including its source versions. Status records the error and next retry; the running plugin retries automatically with bounded backoff. Use `openclaw wiki compile` or `wiki_apply` with `op: "refresh"` to rebuild manually. A vault without a snapshot compiles on its first search; an initial failure is reported explicitly.

Unmanaged raw Markdown can live under `sources/` without OpenClaw page frontmatter. Add `<!-- openclaw:wiki:raw-source -->` near the top of the page body to opt it out of wiki page metadata and freshness lint; generated or source-sync tracked imports still require their structured metadata.

## CLI

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki compile
openclaw wiki lint
openclaw wiki search "alpha"
openclaw wiki get entity.alpha --from 1 --lines 80

openclaw wiki apply synthesis "Alpha Summary" \
  --body "Short synthesis body" \
  --source-id source.alpha

openclaw wiki apply metadata entity.alpha \
  --source-id source.alpha \
  --status review \
  --question "Still active?"

openclaw wiki bridge import
openclaw wiki unsafe-local import

openclaw wiki obsidian status
openclaw wiki obsidian search "alpha"
openclaw wiki obsidian open syntheses/alpha-summary.md
openclaw wiki obsidian command workspace:quick-switcher
openclaw wiki obsidian daily

# Agent-scoped vault
openclaw wiki status --agent support
openclaw wiki search "refund policy" --agent support
```

## Agent tools

- `wiki_status`
- `wiki_lint`
- `wiki_apply`
- `wiki_search`
- `wiki_get`

The plugin also registers a non-exclusive memory corpus supplement, so shared `memory_search` / `memory_get` flows can reach the wiki when the active memory plugin supports corpus selection.

`wiki_search` accepts short search keywords in `query`, optional `maxResults`, optional Personal ranking `mode`, and an explicit Vault selector: either `vaultId` from a result or an exact Shared/Managed `vaultName` supported by its owner, never both. Set a selector only when the user chooses a vault. Otherwise registered server owners choose default sources using current permissions and user selections. Duplicate names require user selection from authorized choices. Results include vault identity, document identity, title, path, snippet, and revision or source version. `wiki_get` reads the returned path without a backend or corpus parameter. Personal content is shared only by an explicit Publish or copy. `wiki_apply`, its refresh operation, and `wiki_lint` operate on Personal Wiki; Shared edits and rebuilds use the Vault UI.

`wiki_apply` accepts structured `claims` payloads for synthesis and metadata updates, so the wiki can store claim-level evidence instead of only page-level prose.

When `context.includeCompiledDigestPrompt` is enabled, the memory prompt supplement also appends a compact snapshot from the lifecycle-owned in-memory cache. Legacy prompt assembly sees that automatically, and non-legacy context engines can pick it up when they explicitly consume memory prompt supplements via `buildActiveMemoryPromptSection(...)`.

## Gateway RPC

Read methods:

- `wiki.status`
- `wiki.doctor`
- `wiki.search`
- `wiki.get`
- `wiki.obsidian.status`
- `wiki.obsidian.search`

Write methods:

- `wiki.init`
- `wiki.compile`
- `wiki.ingest`
- `wiki.lint`
- `wiki.bridge.import`
- `wiki.unsafeLocal.import`
- `wiki.apply`
- `wiki.obsidian.open`
- `wiki.obsidian.command`
- `wiki.obsidian.daily`

For agent-scoped vaults, pass `agentId` to vault-backed RPC methods. Missing or
unknown ids fail in multi-agent setups.

## Notes

- `unsafe-local` is intentionally experimental and non-portable.
- Bridge mode reads the active memory plugin through public seams only.
- Agent scope is incompatible with `unsafe-local` and official Obsidian CLI actions.
- Authored Wiki Markdown is source content. Search indexes, metadata, links, and dashboards are derived artifacts; keep provenance attached to imported sources.
- The compiled snapshot in shared SQLite plugin state is the stable machine-facing view of the wiki.
- After editing or restoring vault files, compile again before expecting tools or prompts to use that source state. Lifecycle refresh rejects SQLite snapshots newer than a restored vault, and causal publication chaining rejects compilers started before the restore, without polling or watching files.
- Rollback quarantine clears immediately for an in-process compile. After a separate compiler process publishes, refresh the plugin lifecycle so the daemon can validate that durable publication.
- Pre-publication-epoch cache rows are rebuildable misses, not migrated state; the next compile replaces them.
- Obsidian CLI support requires the official `obsidian` CLI to be installed and available on `PATH`.
