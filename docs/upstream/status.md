# Upstream and Migration Status

## Upstream

- Upstream repository: `https://github.com/openclaw/openclaw.git`
- Origin repository: `https://github.com/devSejung/platformclaw`
- Baseline commit: `17c2ce05d8021b969f9e822a34e92535145922d5`
- Last upstream sync: 2026-07-17 on `sync/upstream-20260717`
- Initial sync state: local `main`, `origin/main`, and `upstream/main` identical

## Current Phase

Environment setup complete. Project guidance documentation in progress.

## Completed

- Windows development path established
- Git and GitHub CLI verified
- Docker Linux engine verified
- Private origin repository created
- Official upstream configured
- Clean OpenClaw `main` pushed to origin
- `main` tracks `origin/main`
- Clean upstream Linux Docker image build and Gateway health smoke validated
- Focused credential-free Linux Docker tests validated

## Not Started

- Previous PlatformClaw capability inventory
- Previous core modification inventory
- Architecture migration plan
- PlatformClaw feature migration
- Company Jammy image validation with the approved internal APT source

## Migration Status

| Capability | Status | Related PR/commit |
| --- | --- | --- |
| Branding and product boundary | Not started | - |
| Account/session/workspace isolation | Not started | - |
| Enterprise authentication | Not started | - |
| Credential runtime and policy | Not started | - |
| Skill Hub | Not started | - |
| Knox adapter | Not started | - |
| Remote execution and filesystem bridge | Not started | - |
| Operations UI, retry and recovery | Not started | - |
| Cron and automation | Not started | - |
| Production Docker deployment | In progress | `feature/jammy-company-build` |

## Update Rule

- After an upstream sync, update the baseline or last synced commit.
- After a capability migration PR is complete, record its status and related PR/commit.
- Do not mark unconfirmed plans as complete.
