# Upstream and Migration Status

## Upstream

- Upstream repository: `https://github.com/openclaw/openclaw.git`
- Origin repository: `https://github.com/devSejung/platformclaw`
- Baseline commit: `17c2ce05d8021b969f9e822a34e92535145922d5`
- Last upstream sync: 2026-07-18 on `sync/upstream-20260718-refresh` through upstream commit `0acece45912de43a7c29638babcb70afce59652c`
- Latest upstream inspection: 2026-07-22 at `8d3d472cbeb68f00cdae9df411b5cb0d6b4fab42`; this was an investigation only, not a sync
- Initial sync state: local `main`, `origin/main`, and `upstream/main` identical

## Current Phase

Environment setup complete. Control-plane Phase 1 implementation in progress.
VM sandbox Phase 2 design and prerequisite backend-contract work started.

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
- PlatformClaw Web login, authenticated Control UI hosting, fixed same-origin
  Gateway adapter, restricted employee routes, identity/logout shell, and
  Windows mocked-browser proof implemented
- Secret-backed `platformclaw-control` deployment entry point implemented

## Not Started

- Previous PlatformClaw capability inventory
- Previous core modification inventory
- Remaining architecture migration plan
- Linux control-process supervision and container browser proof
- Company Jammy image validation with the approved internal APT source

## Migration Status

| Capability                             | Status                              | Related PR/commit                     |
| -------------------------------------- | ----------------------------------- | ------------------------------------- |
| Branding and product boundary          | Not started                         | -                                     |
| Account/session/workspace isolation    | Web runtime implemented             | `packages/platformclaw-control-plane` |
| Enterprise authentication              | LDAP-phase adapter implemented      | `packages/platformclaw-control-plane` |
| Credential runtime and policy          | Not started                         | -                                     |
| Skill Hub                              | Not started                         | -                                     |
| Knox adapter                           | Control-plane contracts implemented | `packages/platformclaw-control-plane` |
| Remote execution and filesystem bridge | Not started                         | -                                     |
| Personal-agent VM sandbox              | Design and prerequisite seam        | `feature/vm-sandbox-phase-2`          |
| Operations UI, retry and recovery      | Employee Web shell implemented      | `ui/src/platformclaw`                 |
| Cron and automation                    | Not started                         | -                                     |
| Production Docker deployment           | In progress                         | `feature/jammy-company-build`         |

## Update Rule

- After an upstream sync, update the baseline or last synced commit.
- After a capability migration PR is complete, record its status and related PR/commit.
- Do not mark unconfirmed plans as complete.
