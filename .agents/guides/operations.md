# Platform and runtime operations

Read before native app/device work, Gateway/operator demos, or product channel/media/memory runtime behavior. Read this guide in full. The [root policy](../../AGENTS.md) owns hard gates, task routing, and validation-environment selection. Paths and commands here are relative to the repository root.

The messaging/media response modes below apply to those product runtime/operator workflows. They do not replace ordinary coding-chat replies.

## Platform / Ops

- Before simulator/emulator testing, check real iOS/Android devices.
- "restart iOS/Android apps" = rebuild/reinstall/relaunch, not kill/launch.
- SwiftUI: Observation (`@Observable`, `@Bindable`) over new `ObservableObject`.
- Mac gateway: dev watch = `pnpm gateway:watch`; managed installs = `openclaw gateway restart/status --deep`; logs = `./scripts/clawlog.sh`. No launchd/ad-hoc tmux.
- Mac app permission testing: stable app path + real signing identity required. No `--no-sign`, `SIGN_IDENTITY=-`, or raw debug binary; TCC prompts/listing won't stick.
- Version bump surfaces live in `$release-openclaw-maintainer`.
- Parallels: `$openclaw-parallels-smoke`; Discord roundtrip: `$parallels-discord-roundtrip`.
- Human demos: use available browser/capture tools under Validation; keep the desktop visible/windowed, with no fullscreen remote browser unless video/capture-style output is requested.
- Before sharing a demo/browser link, inspect a screenshot of the actual app/path and verify the target UI works. Do not invoke an unavailable backend for screenshots.
- ClawSweeper ops: `$clawsweeper`. Deployed hook sessions may post one concise `#clawsweeper` note only when surprising/actionable/risky; if using message tool, reply exactly `NO_REPLY`.
- Generated-media completions wake the requester agent first. Requester visible-reply config decides final text vs message tool; direct media send is fallback/recovery only.
- `message_tool_only`: normal agent final visible reply = current-source `message(action=send)` only. No `NO_REPLY` prompt/contract; no message call = no source reply. Plugin-owned bound-thread reply = plugin return value; no message tool needed. Never auto-publish private final.
- Memory wiki prompt digest stays tiny; prefer `wiki_search` / `wiki_get`; verify contact data before use; source-class provenance for generated people facts.
- Rebrand/migration/config warnings: run `openclaw doctor`.
- Never edit `node_modules`.
- Local-only `.agents` ignores: `.git/info/exclude`, not repo `.gitignore`.
- Provider tool schemas: prefer flat string enum helpers over `Type.Union([Type.Literal(...)])`; some providers reject `anyOf`.
- External messaging: no token-delta channel messages. Follow `docs/concepts/streaming.md`.
