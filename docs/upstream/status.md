# Upstream and Migration Status

## Upstream

- Upstream repository: `https://github.com/openclaw/openclaw.git`
- Origin repository: `https://github.com/devSejung/platformclaw`
- Baseline commit: `17c2ce05d8021b969f9e822a34e92535145922d5`
- Last upstream sync: 2026-07-18 on `sync/upstream-20260718-refresh` through upstream commit `0acece4591248099a6c58296143adf4d24db3d1e`
- Initial sync state: local `main`, `origin/main`, and `upstream/main` identical

## Current Phase

Environment setup complete. Control-plane Phase 1 implementation in progress.

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
- Control-plane identity, session, provisioning, and Knox binding contracts
  implemented with an in-memory store and focused tests
- Approved control-plane SQLite v1 store implemented for identities, roles,
  directory groups, managed groups/parts, agent bindings, browser sessions, and
  audit events

## Not Started

- Previous PlatformClaw capability inventory
- Previous core modification inventory
- Remaining architecture migration plan
- Control-plane runtime adapters
- Company Jammy image validation with the approved internal APT source

## Migration Status

| Capability                             | Status                              | Related PR/commit                     |
| -------------------------------------- | ----------------------------------- | ------------------------------------- |
| Branding and product boundary          | Not started                         | -                                     |
| Account/session/workspace isolation    | Persistent store implemented        | `packages/platformclaw-control-plane` |
| Enterprise authentication              | Contracts implemented               | `packages/platformclaw-control-plane` |
| Credential runtime and policy          | Not started                         | -                                     |
| Skill Hub                              | Not started                         | -                                     |
| Knox adapter                           | Control-plane contracts implemented | `packages/platformclaw-control-plane` |
| Remote execution and filesystem bridge | Not started                         | -                                     |
| Operations UI, retry and recovery      | Not started                         | -                                     |
| Cron and automation                    | Not started                         | -                                     |
| Production Docker deployment           | In progress                         | `feature/jammy-company-build`         |

## Update Rule

- After an upstream sync, update the baseline or last synced commit.
- After a capability migration PR is complete, record its status and related PR/commit.
- Do not mark unconfirmed plans as complete.
