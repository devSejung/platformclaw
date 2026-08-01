# Upstream and Migration Status

## Upstream

- Upstream repository: `https://github.com/openclaw/openclaw.git`
- Origin repository: `https://github.com/devSejung/platformclaw`
- Baseline commit: `17c2ce05d8021b969f9e822a34e92535145922d5`
- Last upstream sync: 2026-08-01 on `sync/upstream-20260801` through upstream commit `02457657f012d33e141c710d92671d1bc4a519e9`
- Initial sync state: local `main`, `origin/main`, and `upstream/main` identical

## Legacy Comparison Baseline

- Previous PlatformClaw reference repository: sibling `../platform-agent`
- Reference branch: `origin/platformclaw/upstream-forward-port-2026-06`
- Pinned comparison commit: `6662f049a1f792800b646b9d25681c90bb7f3967`
- Do not use the legacy repository's `main` branch as the migration or Docker
  comparison baseline.
- Treat this repository as behavioral evidence only. Migrate capabilities into
  the current PlatformClaw incrementally through the supported OpenClaw seams.

### Jammy image comparison (2026-07-22)

The legacy baseline above and current candidate `34dd1b139653a4eb19f2a28dbea1039699e75be4`
were built with their default Jammy Docker profiles on the same Linux Docker
engine. Docker reports compressed content separately from unpacked local layer
usage:

| Image                   | Compressed content | Local layer usage |
| ----------------------- | -----------------: | ----------------: |
| Legacy `platform-agent` |            1.46 GB |           5.80 GB |
| Current PlatformClaw    |             915 MB |           4.03 GB |

The current image therefore has no size regression against this legacy
baseline. Its bundled Claude and Codex tools are larger, but its pruned
application dependencies are much smaller: the legacy `node_modules` layer is
2.01 GB and includes 703 MB of `@node-llama-cpp` variants, while the current
layer is 489 MB. The current dependency lock still records `node-llama-cpp` and
LanceDB for their optional plugin workspaces, but the default runtime does not
bundle those plugin-owned dependencies. Do not add intermediate build-stage
and cache sizes to the deployable image size.

## Current Phase

Environment setup complete. Control-plane Phase 1 implementation in progress.

## 2026-08-01 Sync Contract Audit

- Preserved OpenClaw ancestry with the previous upstream sync
  `5496cff9653b00902be9f26d7ec09627425d414a` as the integration range start.
- Adopted the upstream Control UI owner split and moved PlatformClaw session,
  route, chrome, synced-preference, and runtime-config policy into the new root,
  shell chrome, gateway, and view owners.
- Preserved employee cron caller scoping, optimistic job revisions, restricted
  delivery controls, and configured-model-only selection while retaining the
  upstream agent-specific model catalog and scheduler consistency fixes.
- Preserved the PlatformClaw sandbox backend agent identity, remote skill
  provider, runtime prompt context, requester-scoped MCP disposal, and plugin
  request registry seams.
- Regenerated bundled channel metadata from the upstream result plus the
  private Knox channel surface.

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
- Control-plane SQLite v2 migration and VM endpoint, host, allocation, profile,
  and encrypted-envelope schema implemented
- User-scoped AES-256-GCM SSH credential vault, Docker-secret master key, and
  matching-key restart proof implemented
- One-shot credential grants and bounded local Unix-socket/Windows named-pipe
  broker implemented; authenticated Gateway handoff remains pending
- Assigned-VM remote skill discovery, immutable run snapshots, and explicit
  Skills UI refresh implemented through the generic sandbox backend seam
- Assigned-VM Skill Workshop proposal/evaluate/apply implemented by extending
  upstream Workshop with one optional backend-owned target capability; proposal
  state remains in Gateway SQLite and generic Docker/SSH behavior is unchanged
- Personal Workshop target context implemented as a PlatformClaw UI overlay:
  the upstream-owned Workshop remains shared, while current-target display,
  location-change refresh, and mismatched-action guidance stay downstream
- Owner-preserving employee-profile refresh and credential-free execution
  context projection implemented from the run-pinned backend snapshot
- PlatformClaw Web login, authenticated Control UI hosting, fixed same-origin
  Gateway adapter, restricted employee routes, identity/logout shell, and
  Windows mocked-browser proof implemented
- Discoverable **Settings > MCP** browser surface implemented for
  administrator server policy and employee personal credentials, with a narrow
  administrator BFF and post-change Agent runtime invalidation
- Secret-backed `platformclaw-control` deployment entry point implemented

## Not Started

- Previous PlatformClaw capability inventory
- Previous core modification inventory
- Remaining architecture migration plan
- Linux control-process supervision and container browser proof
- Company Jammy image validation with the approved internal APT source

## Migration Status

| Capability                             | Status                                | Related PR/commit                     |
| -------------------------------------- | ------------------------------------- | ------------------------------------- |
| Branding and product boundary          | Not started                           | -                                     |
| Account/session/workspace isolation    | Web runtime implemented               | `packages/platformclaw-control-plane` |
| Enterprise authentication              | LDAP-phase adapter implemented        | `packages/platformclaw-control-plane` |
| Credential runtime and policy          | Vault and local broker implemented    | `packages/platformclaw-control-plane` |
| Skill Hub                              | VM Workshop integration in progress   | `feature/vm-skill-workshop`           |
| Knox adapter                           | Control-plane contracts implemented   | `packages/platformclaw-control-plane` |
| Remote execution and filesystem bridge | Backend foundation in progress        | `extensions/platformclaw-execution`   |
| Operations UI, retry and recovery      | Employee Web shell implemented        | `ui/src/platformclaw`                 |
| Cron and automation                    | Agent-scoped self-service in progress | `feature/employee-cron-self-service`  |
| Production Docker deployment           | In progress                           | `feature/jammy-company-build`         |

## Update Rule

- After an upstream sync, update the baseline or last synced commit.
- After a capability migration PR is complete, record its status and related PR/commit.
- Do not mark unconfirmed plans as complete.

## PlatformClaw policy invariants during sync

Before resolving sandbox, process, filesystem, prompt-hook, plugin-state, or
Control UI conflicts, read the
[VM execution policy](/platformclaw/vm-execution-policy). Its product and
security decisions remain fixed across an upstream sync. A sync may replace a
private implementation sketch with a better upstream seam, but it must record
the affected contract and must not silently change execution targets, channel
routing, fallback, workspace, Core File, employee-profile, credential, or
background-process behavior.

Core File ownership is intentionally split: Agent profile, bootstrap, and
memory state remain in the Gateway Agent workspace, while `AGENTS.md` follows
the active project filesystem. Preserve the generic sandbox capability and
bounded Agent-workspace tool seam; do not replace it with PlatformClaw-specific
core checks, basename routing, mirroring, or dual-write. Prefer an equivalent
upstream split-workspace/bootstrap provider when one exists.

Keep upstream integration and VM implementation in separate pull requests.
Validate the synchronization first, then reapply only the smallest required
PlatformClaw prerequisite to the synchronized `main`.

For Workshop UI conflicts, preserve upstream ownership of proposal rendering,
storage, and lifecycle. The downstream boundary is limited to
`ui/src/platformclaw/execution-target-events.ts`, the personal-access target
prop, target labels, and mismatch affordances. Prefer an upstream generic
target-context seam when one becomes available; do not fork the Workshop page
or introduce a second proposal API during synchronization.
