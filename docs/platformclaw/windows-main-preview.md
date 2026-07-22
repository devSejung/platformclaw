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

The launcher never installs dependencies into the source checkout. It fetches
`origin/main`, exports that exact commit into an isolated cache under
`%LOCALAPPDATA%`, and uses the repository-pinned pnpm through Corepack. This
keeps the normal `main` checkout clean and avoids Windows junction changes to
tracked workspace links.

The launcher also installs a local Git index guard for tracked workspace links.
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

Close the three service windows to stop the local stack. Actual model replies
still require an approved OpenAI-compatible provider configuration; login,
session, provisioning, authorization, and UI checks do not.
