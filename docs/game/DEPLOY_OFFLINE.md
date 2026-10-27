---
summary: "Build and transfer the existing PlatformClaw images with fishing included"
read_when:
  - Preparing an offline PlatformClaw image handoff
title: "Fishing offline deployment handoff"
---

# Fishing offline deployment handoff

Fishing ships inside the existing PlatformClaw service image with baseball and
racing. It has no separate container, service, port, login, or external game API.
The current game is manual-only, credits shared G on catch and exposes rankings
and records. All forty species share one theme/pool without equipment or location gates.
Use the repository-owned [Jammy build procedure](/upstream/jammy-build), which
also packages the matching sandbox image and approved companion images.
Do not deploy to company systems from this development task.

## Validate the working branch

The user has resumed autoreview and required CI for the final source based on
latest main. No additional preview deployment is requested. Existing preview
state and assets remain intact; stop only the task harness if gate resources
require it, and do not restart it as a new preview revision. The engine outage was recovered under explicit Desktop-restart
approval; task resources are capped at4GiB. The bounded timing repair, focused
checks, UI build and same-state preview startup passed for the previous contract. Full packaging/review
gates remain pending. The commands
below describe later handoff steps, not evidence that a build has run.

The build wrapper explicitly supports dirty local validation without export:

```powershell
node scripts/platformclaw-build.mjs --allow-dirty --no-export
```

This preserves the normal build/smoke pipeline; it is not a transferable release
artifact. Record the patch identity and the actual build result. Run the existing
service with synthetic local state and verify all three games, authentication,
persistence, and game transitions. Static game assets must continue to work with
external network access blocked. Synthetic auth is a proof fixture, not a new
production authentication system.

## Refresh the synthetic preview

The task preview uses the existing `scripts/platformclaw-racing-preview.ts` and
its isolated synthetic state. Build the final UI with `pnpm ui:build` inside the
prepared Linux checkout. The BFF snapshots the asset map and application HTML at
startup; a UI rebuild alone cannot serve new hashed asset names. Gracefully
restart only the task harness with the same state directory, then check the new
served asset returns HTTP 200 and matches its disk hash. Preserve synthetic
sessions/game state and leave operator containers untouched.
Stop the task harness before replacing its output directory: a concurrent build
can remove files that its cached asset map still references, yielding500/404.
For ship validation while a preview remains live, use a separate source/output
checkout. The latest user instruction does not authorize another preview restart.

Use real mouse/keyboard input to verify the independent transparent bottom-right dock,
catch-to-G transaction, single-pool probabilities, rankings and records. Preview-specific test
funding and the controllable racing clock are not fishing product features.

## Build the transfer artifact

After fresh review and checks, use a clean approved source revision:

```powershell
node scripts/platformclaw-build.mjs
```

The wrapper uses the existing Dockerfiles and derives the version, source SHA,
image refs, manifest, archive, and hash. Its normal export requires the existing
credential-free sandbox `pip.conf` build input; do not invent company mirror
settings or bake credentials into an image. Use a release/version override only
with the release owner's explicit authorization.

Expected names are `.artifacts/platformclaw/platformclaw-<version>-<git-sha>.tar`
and the matching `.tar.sha256`. These names are expectations, not evidence that
the files exist. Record actual archive bytes, hash, image refs, and commit before
marking this handoff complete. See [Implementation report](/game/IMPLEMENTATION_REPORT).

## Import using the established procedure

After the company operator approves the artifact and maintenance window:

```bash
sha256sum -c platformclaw-<version>-<git-sha>.tar.sha256
docker load -i platformclaw-<version>-<git-sha>.tar
```

Use the existing deployment bundle and image update procedure. Do not rebuild
source inside the disconnected network. Runtime credentials, user workspaces,
and databases remain external to images.

## Back up and roll back

Back up the complete control database using the established maintenance/SQLite
backup procedure before upgrade, together with its matching deployment metadata.
Do not copy only the main SQLite file while a writer and WAL are active.
The bounded fishing-state conversion credits old unsold catches once, preserves
records and stops retired automatic state; verify its idempotency before handoff.
Fishing tables are additive and do not advance `user_version`; existing
baseball/racing records and the canonical shared-wallet column remain intact.

For code rollback, restore the previously approved image refs and retain the
current database. Older code ignores fishing tables, but shared G already earned
or spent remains real game state. Do not automatically restore an old database:
that would also erase later baseball, racing, and user activity. Any data restore
requires a separately approved maintenance and reconciliation decision.
