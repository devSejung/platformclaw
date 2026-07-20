# PlatformClaw

## Project

PlatformClaw is a private, enterprise-oriented downstream of OpenClaw. It starts cleanly from the latest OpenClaw upstream instead of continuing to expand the previous PlatformClaw codebase. Existing capabilities will be migrated incrementally, one capability at a time.

The goals are to:

- keep OpenClaw upstream practical to track over the long term;
- isolate PlatformClaw enterprise capabilities behind maintainable boundaries.

## Current State

- Local repository: `C:\dev\platformclaw`
- Development host: Windows
- Primary agent environment: Codex Windows app
- Final runtime: Ubuntu Linux
- Final validation: Linux Docker containers
- Deployment artifact: Docker image
- Company transfer: `docker save` to `docker load`
- `origin`: `https://github.com/devSejung/platformclaw`
- `upstream`: `https://github.com/openclaw/openclaw.git`
- Baseline commit: `17c2ce05d8021b969f9e822a34e92535145922d5`
- The Jammy company deployment profile is the first capability being migrated.
- The first control-plane contract slice now lives in
  `packages/platformclaw-control-plane` with an in-memory implementation.
- The clean OpenClaw Linux Docker build and focused credential-free test baseline has been validated.

## Why This Rebuild Exists

The previous PlatformClaw directly modified multiple OpenClaw core areas, making upstream synchronization and long-term maintenance difficult. This rebuild starts from current upstream, analyzes ownership boundaries and extension points first, and then migrates capabilities in small units.

## Capability Areas

These areas are candidates for future evaluation and migration. They are not an approved architecture:

- multi-user account, session, and workspace isolation
- enterprise authentication and organization/permission handling
- runtime credential resolution and policy
- Skill Hub and managed skill execution
- Knox messaging integration
- remote execution and filesystem bridge
- Docker-based enterprise deployment
- operational UI, retry, recovery, cron, and automation

## Development Principles

- Do not copy the previous codebase wholesale.
- Migrate capabilities through small, capability-focused PRs.
- Investigate current OpenClaw structure and extension points first.
- When a core change is unavoidable, keep it generic and minimal.
- Treat Windows only as the development host; judge final behavior in Linux Docker.
- Do not introduce Windows-only runtime dependencies.
- Do not freeze unconfirmed interface names or directory structures in documentation.

## Git Workflow

- `main`: validated PlatformClaw baseline
- `feature/*`: feature development
- `fix/*`: bug fixes
- `refactor/*`: bounded structural improvements
- `sync/upstream-YYYYMMDD`: temporary upstream import, conflict resolution, and validation

Bring upstream changes from `upstream/main` into a sync branch, validate them there, and merge them into `main` through a PR.

## Current Phase

Production Docker deployment migration and validation remains in progress.
Control-plane Phase 1 implementation is now also in progress for enterprise
identity, server sessions, idempotent agent provisioning, and Web and Knox
ingress authorization. The contract, in-memory store, and approved SQLite v1
store slices are complete; runtime adapters have not started. See
`docs/platformclaw/control-plane-phase-1.md` and
`docs/platformclaw/decisions.md`.

Next steps:

1. Establish project guidance and state documentation.
2. Validate each upstream sync against the Linux Docker build/test baseline.
3. Inventory previous PlatformClaw capabilities and core changes.
4. Decide migration order and architecture boundaries.
5. Migrate capabilities through small PRs.

Do not begin capability migration without an explicit request.
