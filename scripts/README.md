---
summary: "Repository script entry points and compatibility notes"
read_when:
  - Looking for an existing script before adding a new one
  - Running repository checks, tests, docs, Docker, release, or GitHub helper scripts
  - Updating package scripts or CI workflow script references
title: "Scripts Directory"
---

# Scripts Directory

The `scripts/` directory contains repository tooling used by local development,
CI, docs publishing, releases, Docker proof, and maintainer operations. Prefer
the package-script entry points in `package.json` when one exists, then read the
underlying script before running it directly.

## Compatibility

Many scripts are stable paths referenced by `package.json`, GitHub Actions,
docs, and maintainer runbooks. Do not move, rename, or regroup scripts only to
improve taxonomy. A directory migration needs an explicit maintainer-approved
compatibility plan for package scripts, workflows, docs snippets, and any raw
script paths users may have copied.

This index is a discovery aid for the current flat layout. It does not define a
new directory taxonomy.

## Common Entry Points

| Area            | Prefer                                                                         | Notes                                                                                                              |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Build           | `pnpm build`                                                                   | Runs `scripts/build-all.mjs`; use specific build scripts only when debugging a build stage.                        |
| Changed checks  | `pnpm changed:lanes --json`, `pnpm check:changed`                              | Lane classification lives in `scripts/changed-lanes.mjs`; changed-file checks live in `scripts/check-changed.mjs`. |
| Docs            | `pnpm docs:list`, `pnpm docs:check-mdx`, `pnpm docs:check-links`               | Backed by `scripts/docs-list.js`, `scripts/check-docs-mdx.mjs`, and `scripts/docs-link-audit.mjs`.                 |
| Formatting docs | `pnpm format:docs:check`                                                       | Uses `scripts/format-docs.mjs`; use write mode only when intentionally formatting docs.                            |
| Lint            | `pnpm lint`, `pnpm lint:core`, `pnpm lint:all`                                 | Wrapper scripts keep oxlint behavior aligned with repo config.                                                     |
| Targeted tests  | `pnpm test <path-or-filter>` or `node scripts/run-vitest.mjs <path-or-filter>` | Avoid bare `vitest`; it can start watch mode.                                                                      |
| Changed tests   | `pnpm test:changed`                                                            | Uses the repo's changed-test resolver instead of a broad Vitest run.                                               |
| Docker proof    | `pnpm test:docker:all`, `pnpm test:docker:rerun`, `pnpm test:docker:timings`   | Use the planner/rerun helpers before launching broad Docker work.                                                  |
| Live proof      | `pnpm test:live`                                                               | Live checks require the matching environment and credentials.                                                      |
| Release checks  | `pnpm release:check`, `pnpm release:beta`, `pnpm release:candidate`            | Release scripts are maintainer workflows; read release docs before use.                                            |
| GitHub reads    | `scripts/gh-read`                                                              | Uses a GitHub App read token when configured, leaving normal `gh` login for writes.                                |
| Commits         | `scripts/committer "<message>" <files...>`                                     | Preferred scoped commit helper for OpenClaw changes.                                                               |
| Proof routing   | [Root validation policy](../AGENTS.md#validation)                              | Source trust and proof requirements determine Docker/WSL/CI use; follow the canonical root policy.                 |

## Script Families

- `check-*.mjs` / `check-*.ts`: guardrails for architecture, docs, package
  contents, boundaries, workflows, and generated artifacts.
- `run-*.mjs`: wrappers around repo runtimes or tools, such as Node, Vitest,
  oxlint, tsgo, and environment setup.
- `test-*.mjs` / `test-*.sh` / `test-*.ts`: test planners, Docker lanes, live
  checks, and focused validation helpers.
- `docs-*` and `check-docs-*`: docs listing, link auditing, MDX checks,
  spellcheck, sync, and i18n glossary checks.
- `release-*`, `openclaw-npm-*`, and `plugin-*-release-*`: release preparation,
  package verification, and publishing helpers.
- `docker-*`, `test-docker-*`, and `test-live-*-docker.sh`: Docker E2E planning,
  rerun, timing, and live/package lane helpers.
- `gh-read*`, `label-*`, `sync-labels.ts`, and PR helpers: GitHub read,
  labeling, and maintainer workflow support.
- `generate-*`, `write-*`, `copy-*`, and `sync-*`: generated docs, metadata,
  package surfaces, and build artifact support.
- `lib/`: shared helpers imported by script entry points.

## Maintenance Rules

- Read `scripts/AGENTS.md` before changing scripts.
- Keep package scripts, generators, generated-artifact checks, docs references,
  and workflow references aligned when touching a script path.
- Prefer existing wrappers instead of introducing a raw tool invocation.
- Add or update focused tests under `test/scripts/` when changing script
  behavior.

## PlatformClaw Development Resources

Use one primary checkout per developer and Node 24.15 or newer. Managed task
commands run on Windows or Linux; on other hosts use a Linux development
environment for those commands. The resource
tool itself needs only Node and Git; it works before package installation.
Install the
repository's pinned dependencies once in the primary checkout when host
installation is permitted. Never run `pnpm install` in a Windows linked worktree.
Focused host checks use existing repository wrappers to reuse a compatible
primary toolchain; heavy checks use local Linux Docker or healthy WSL with
Linux-owned source and dependencies, following the root validation policy.
Share package download caches, not arbitrary `node_modules` directories across
different lockfiles or runtimes. A junction points at an existing installation;
counting its target again overstates physical disk use.

From the primary checkout, create a task instead of another independent clone:

```sh
git fetch origin main
node scripts/platformclaw-dev-task.mjs create login-fix --branch fix/login-fix --ref origin/main
node scripts/platformclaw-dev-task.mjs list
```

`create` prints the worktree path under `.worktrees/`; open that path in your
editor. The task has its own scratch directory under `.artifacts/dev-tasks/`.
All linked invocations share one development-only SQLite registry in the Git
common directory. No Gateway or agent database is used.

Run a bounded command from the primary checkout against that task's source:

```sh
node scripts/platformclaw-dev-task.mjs run login-fix -- node scripts/run-vitest.mjs test/scripts/platformclaw-dev-task.test.ts
```

The command receives task-local `TMP`, `TEMP`, and `TMPDIR`. Normal command
success and failure both join the child and clean its disposable scratch files;
the source worktree remains for further edits. Do not use `run` to launch
detached servers or other background work. Keep any result you need outside the
temporary directory and exclude private data from committed evidence.

Build disposable Docker images through the task owner:

```sh
node scripts/platformclaw-dev-task.mjs image login-fix proof -- -f Dockerfile.proof .
```

Replace the Dockerfile and context with your actual validation inputs; pass
short flags separately (`-f Dockerfile`, not grouped or attached forms). `image`
prints its task-specific tag and adds ownership metadata. Direct `docker build`,
independent clones, arbitrary temporary folders, and preexisting resources are
not automatically adopted. Release images and release archives remain under
the release builder's retention policy, not the disposable-proof lifecycle.
Use `docker run --rm` for bounded proof containers. The task tool never stops
containers or deletes volumes; a remaining container reference blocks cleanup.

After committing or discarding your intended edits, finish from the primary
checkout. Preview first, then apply:

```sh
node scripts/platformclaw-dev-task.mjs finish login-fix
node scripts/platformclaw-dev-task.mjs finish login-fix --apply
node scripts/platformclaw-dev-task.mjs list
```

Finishing deletes only the task's disposable resources and a clean worktree;
the Git branch remains. Dirty, untracked, ignored, or container-referenced
resources are retained with an explanation. Remove or relocate those files
deliberately, then retry. Do not use force deletion to make cleanup appear clean.
Periodic sweeping retries finished tasks; it never completes active tasks for
you or removes product volumes and databases.

A killed wrapper or uncertain child outcome is not normal completion. First
verify the original command and all of its descendants stopped, then recover
that exact task and finish it:

```sh
node scripts/platformclaw-dev-task.mjs recover login-fix --confirm-stopped
node scripts/platformclaw-dev-task.mjs finish login-fix --apply
```

Inspect legacy independent clones and unmanaged worktrees without deleting them:

```sh
node scripts/platformclaw-dev-task.mjs audit
node scripts/platformclaw-dev-cleanup.mjs --skip-final-images --skip-archives
```

Classify legacy folders separately using their Git state, merged status, recent
changes, and actual running consumers. An old timestamp or a matching folder
name alone is not deletion authority.

### Windows maintenance setup

After updating the primary checkout to include this tooling, install or refresh
the per-user task there; installation from a removable worktree is rejected:

```powershell
.\scripts\platformclaw-dev-maintenance.ps1 -Action Install
.\scripts\platformclaw-dev-maintenance.ps1 -Action Status
```

The task runs every four hours while that user is signed in, using the same
bounded options as `-Action Run`: managed-task sweeping, release intermediates,
and a BuildKit cache target of 20 GB with 5 GB reserved and a 20 GB free-space
target. Final release images and archives are skipped; their lifecycle remains
with the release builder. `Status` shows the last result and next run. Read
cleanup output for skipped or blocked work; a scheduled-task result alone does
not prove every resource was reclaimed.

For manual maintenance or hosts without Windows Task Scheduler:

```sh
node scripts/platformclaw-dev-cleanup.mjs --apply --skip-final-images --skip-archives --cache-max 20gb --cache-reserved 5gb --cache-min-free 20gb
```

The 20 GB target applies to BuildKit cache, not total Docker storage. Images,
container writable layers, volumes, and exported archives are separate. Docker
internal free space also does not necessarily shrink Docker Desktop's VHDX.
Compaction is a separate, elevated, explicitly scheduled downtime operation:
only after Docker and WSL work has stopped, run
`./scripts/platformclaw-docker-vhdx-compact.ps1 -Apply`. It stops Docker Desktop
and WSL; routine maintenance never does this automatically.

See also [Scripts](https://docs.openclaw.ai/help/scripts) for public-facing script guidance.
