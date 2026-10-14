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

For Wiki Hub, use `platformclaw-wiki-hub` to open Personal and Shared Wikis with
the graph visible, synthetic documents, links, permissions and access requests:

```powershell
node --import tsx scripts\control-ui-fixture-preview.ts platformclaw-wiki-hub --viewport 1920x1080 --theme platformclaw --mode light --locale ko-KR
```

Use the same document reader from cards, search results and graph nodes. Select
Personal Wiki to review multi-file and folder upload, file outcomes and retry
controls. The fixture supports deterministic browser interaction; it does not
write a real Personal source or prove backend indexing. Graph counts and filters
apply to the loaded snapshot. Organization directory management remains separate
from Wiki knowledge.

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

### Horse racing preview

After building the current Control UI, run the isolated racing development harness:

```sh
node --import tsx scripts/platformclaw-racing-preview.ts
```

Stop the harness before rebuilding the Control UI, then start it again after the
build finishes. The web asset handler prepares its HTML and asset inventory at
startup; rebuilding its active asset directory can leave that HTML pointing to
removed JavaScript files and prevent the app from starting.

The test clock advances past recorded rounds after a restart, preserving normal
settlement/refunds and existing G balances.

The app opens on `http://127.0.0.1:19301/platformclaw/login`. The separate
development clock is at `http://127.0.0.1:19302`. Use `person.one` and
`admin.user`, both with `test-password`, in separate browser sessions to test
multiplayer betting. The clock page grants each synthetic account 3,000 test G
through the baseball reward producer after login. It can advance betting,
departure, and settlement without changing the production schedule. Runtime
data and generated credentials stay in a dedicated preview directory.
The immediate demo button enters two dedicated synthetic spectators and starts
a race without debiting the viewer's G. Repeated demos advance to another test
race, retaining normal server settlement/refund rules for the previous one.

In an isolated Linux container whose published ports bind only to host loopback,
pass `--listen-host 0.0.0.0`; the native default is loopback. The harness requires
Python 3, the existing dependencies, and a built dist-backed Gateway. It refuses
occupied ports and cleans up only its own child services.

The production game opens through seven quick brand/logo clicks and the game
selector. Racing uses the same G balance as baseball and bat purchases. Weekday
races start at 11:00 through 17:00 in Asia/Seoul, seven per day; there are no weekend
races. The first race opens at 10:50. Subsequent races open ten seconds after the
previous scheduled three-minute race ends. Betting closes one minute before departure.
Tickets range from 50G to 1,000G, inclusive.
Each race lasts three minutes. Horse names, stats and odds stay fixed across
races. A hidden cold/hot mixture makes Juki usually finish in the lower half,
with rare strong performances; every finishing position remains possible.
Win, unordered top-two (quinella) and two-horses-in-the-top-three (quinella-place)
odds use the exact mixture of the weighted finish orders. Net fixed odds equal
the reciprocal of the result probability multiplied by 0.97; the 3% fee is
deducted from the principal-included winning payout. Each accepted ticket records its potential payout;
the final exact rational payout is rounded down to integer G. Other tickets
cannot change it. Losing tickets pay zero. Fewer than two participating accounts
cancels and refunds the race. A user can cancel a ticket for a full refund until
the betting deadline, with idempotent retry after cancellation. The twenty-ticket
limit counts all accepted tickets, including cancelled tickets.

Before betting, each race publishes its public roster and seed commitment.
Speed and stamina appear as approximate gauges and condition as a short witty
track rumor. Numeric condition, draw weights and win probabilities are withheld
until the terminal record. Exact odds permit probability inference. Private
condition describes the recorded performance and affects the animation, without
changing the fixed odds. Rumors add noisy hints; Juki's rumors ignore its hidden
cold/hot state. These hints do not guarantee a result.
Betting cannot affect the weighted draw. After settlement, browsers can
independently verify the revealed seed against both the commitment and finish
order. Engine or pricing changes cancel and refund unfinished rounds rather than changing
their committed rules. Durable deadlines, tickets, results and gold movements
live in the control SQLite database and recover on restart.
Earlier horse-racing prototypes were development-only experimental builds.
Their earlier racing implementations are not supported downgrade readers
of the cancellation database. The released non-racing baseline's wallet column
is unchanged. Old completed preview receipts retain their recorded payouts and
finish positions; unfinished races with changed rules are refunded.
The responsive race overlay follows a rectangular course inside the browser
viewport. Upright vector artwork switches between side, front and rear views
at corners instead of rotating the whole horse. It passes pointer input through
to PlatformClaw. Compact controls and
the latest thirty active bets show display names, selections and G amounts;
cancelled tickets leave the live feed while remaining in the user's receipts.
Every runner carries its name and number. The right-side live standings reorder
from server positions, then show all six final places. A newly observed personal
winning result celebrates once, with a static announcement for reduced motion.

Baseball browser rewards require a server-issued, user-bound at-bat. The server
recomputes outcome and distance from swing timing and the issued bat. This stops
fabricated result claims and replay; it does not establish that a human, rather
than automation, supplied the timing input.

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
