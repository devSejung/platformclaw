---
summary: "Run an isolated PlatformClaw main snapshot on Windows for local browser testing"
read_when:
  - Testing PlatformClaw login and Control UI changes on Windows
  - Diagnosing local Node, pnpm, Python, or main checkout problems
title: "PlatformClaw Windows main preview"
---

# PlatformClaw Windows main preview

Use the Windows preview launcher for the short browser feedback loop. It runs a
synthetic employee-auth service, one private OpenClaw Gateway, and the
PlatformClaw control service. Linux Docker remains the final runtime authority.

## Choose the lightest preview that fits

PlatformClaw has several browser and UI development loops. Use the lightest one
that proves the behavior you are working on:

| Mode                  | Command                                                            | What it runs                                                                 | Best for                                                                     |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Control UI source dev | `pnpm ui:dev`                                                      | Vite source server only; connect it to a real Gateway                        | HMR while changing generic Control UI code                                   |
| Fixture preview       | `pnpm ui:fixture-preview -- <fixture>`                             | Vite source server + headed Chromium + deterministic in-browser Gateway mock | Fast layout, responsive, theme, and interaction review without backend setup |
| Static Vite preview   | `pnpm --dir ui preview`                                            | An already-built UI bundle only                                              | Checking static build output when a Gateway is already available             |
| Mocked browser E2E    | `pnpm test:ui:e2e`                                                 | Built Control UI + headless Playwright + deterministic Gateway mocks         | Automated browser regression proof                                           |
| Windows main preview  | `.\scripts\platformclaw-windows.ps1 -Action Start -SourceRef HEAD` | Synthetic employee auth + real private Gateway + control service + built UI  | Login, routing, Gateway integration, and current-checkout behavior           |
| VM preview            | `.\scripts\platformclaw-vm-preview.ps1 -Action Start`              | Docker stack + Fake SafeConnect + VM execution path                          | Full VM registration, credential, and execution integration                  |

`pnpm ui:fixture-preview` reuses the same fixture helpers as Control UI E2E.
List the available named fixtures first:

```powershell
pnpm ui:fixture-preview -- --list
```

For example, this opens the populated PlatformClaw Memory fixture at an FHD CSS
viewport:

```powershell
pnpm ui:fixture-preview -- platformclaw-memory --viewport 1920x1080 --theme platformclaw --mode light --locale ko-KR
```

On Windows, a dependency-less linked worktree intentionally blocks `pnpm`
dependency reconciliation. In that case, reuse the primary checkout toolchain
through the Node entry point instead of installing dependencies in the worktree:

```powershell
node --import tsx scripts\control-ui-fixture-preview.ts platformclaw-memory --viewport 1920x1080 --theme platformclaw --mode light --locale ko-KR
```

Viewport presets are `desktop`, `fhd`, and `mobile`; an explicit `WIDTHxHEIGHT`
also works. Built-in theme families are `platformclaw`, `claw`, `knot`, and
`dash`, with `light` or `dark` mode selected separately. The browser stays open
for manual clicking until you close it or press Ctrl-C. Fixture preview uses
synthetic data and does not start a real Gateway or control service, so use the
Windows main preview before treating a backend integration change as validated.

Use `platformclaw-memory-busy` to inspect long titles, local document filters,
and a denser graph, `platformclaw-memory-empty` for genuinely empty Memory/Wiki
states, and `platformclaw-memory-error` for unavailable-service messages and
retry controls. Wiki filters apply to the loaded overview, not every document
in the vault. The graph inspector lists connected documents before opening the
existing reader. Dreaming distinguishes automatic consolidation being enabled
from a currently executing job; promotion and diary timestamps are not run
completion timestamps.

For organization knowledge, use `platformclaw-organization-memory` to open the
graph with Part, Group, Team, and Global data (35 documents in the Group graph):

```powershell
node --import tsx scripts\control-ui-fixture-preview.ts platformclaw-organization-memory --viewport 1920x1080 --theme platformclaw --mode light --locale ko-KR
```

Organization knowledge appears before the sharing form with local title/content
search and scope filters. Graph nodes select a full-title/connected-document
inspector; **Open document** is a separate read-only action. **Enlarge graph**
uses the available page width, **Fit graph** frames visible nodes, and **Focus
selection** makes a chosen node readable on a small screen. Counts and filters
apply to the loaded snapshot, not an unrestricted organization-wide search.

The launcher never installs dependencies into the source checkout. It fetches
`origin/main`, exports that exact commit into an isolated cache under
`%LOCALAPPDATA%`, and uses the repository-pinned pnpm through Corepack. This
keeps the normal `main` checkout clean and avoids Windows junction changes to
tracked workspace links.

The launcher also installs a local Git index guard for tracked workspace links.
Tracked post-checkout and post-merge hooks apply the same guard automatically to
new linked worktrees and refreshed checkouts.
pnpm represents these links as NTFS junctions when Windows symbolic-link support
is unavailable. Without the guard, older Git for Windows operations such as
`stash` can traverse a junction and remove files from the checkout it targets.
The guard affects only tracked links below `node_modules`; source files remain
visible to normal Git operations. It refuses changes while the current HEAD and
Git index disagree, so a partially applied link update cannot be accepted as a
healthy checkout.

## Start

From a PowerShell window in the repository:

```powershell
.\scripts\platformclaw-windows.ps1
```

Choose **Start latest main**. The first run installs dependencies and builds the
Control UI. Later runs reuse the commit-addressed source snapshot. Three visible
PowerShell windows show the employee-auth, Gateway, and control-service logs.
The launcher opens `http://127.0.0.1:19001/platformclaw/login` when all services
are healthy.

Synthetic accounts:

| Role          | Account      | Password        |
| ------------- | ------------ | --------------- |
| Employee      | `person.one` | `test-password` |
| Administrator | `admin.user` | `test-password` |

All listeners bind to loopback. Gateway credentials and runtime state stay
outside the repository under `%LOCALAPPDATA%\PlatformClaw\windows-main-preview`.
Never replace the synthetic account fixture with production employee data.

## Direct actions

```powershell
# Check Git, Node, Python, Corepack, and the pinned pnpm version.
.\scripts\platformclaw-windows.ps1 -Action Doctor

# Rebuild the UI and start the latest origin/main snapshot.
.\scripts\platformclaw-windows.ps1 -Action Start -Rebuild

# Install the Git junction guard without starting the preview.
.\scripts\platformclaw-windows.ps1 -Action GitGuard

```

Run the guard action once after a fresh clone and before using `git stash`,
or dependency installation in the main checkout. `Start` installs it
automatically, while `Doctor` verifies it without changing it. The guard is not
a safe wrapper for switching or resetting to a commit that changes the tracked
link definitions; keep dependency installs in the launcher's isolated snapshot.

Never run `pnpm install` in a Windows linked worktree. Never target tracked
`node_modules` paths with `git restore`, `git checkout`, or `git reset`. pnpm can
materialize recursive workspace junctions there, and a later Git operation can
follow a junction back into the worktree root. Dependency-less worktrees use
the primary checkout toolchain through repository wrappers or remote checks.

Close the three service windows to stop the local stack. Actual model replies
still require an approved OpenAI-compatible provider configuration; login,
session, provisioning, authorization, and UI checks do not.
