---
summary: "Frozen product and security policy for personal execution on the PlatformClaw server or an assigned VM"
read_when:
  - Synchronizing PlatformClaw with a newer OpenClaw upstream
  - Implementing or reviewing personal VM execution
  - Changing execution-target, employee-profile, credential, workspace, or background-process behavior
title: "PlatformClaw VM execution policy"
---

# PlatformClaw VM execution policy

This page is the canonical first policy freeze for personal execution targets.
It defines product and security behavior that an upstream synchronization must
preserve. Implementation may adopt newer upstream seams, but it must not change
these decisions implicitly.

Policy freeze date: 2026-07-23. Runtime implementation starts only after the
next verified upstream synchronization.

## Definition and ownership

PlatformClaw does not create VMs. A VM execution target is an existing Linux
account on an administrator-approved VM that PlatformClaw reaches through
SafeConnect SSH. Only `exec`, `process`, and filesystem tool operations move to
that account. The Gateway, agent orchestration, prompt construction, employee
profile lookup, LLM request, and control-plane database remain on the
PlatformClaw deployment.

The VM never receives direct access to the PlatformClaw database, Gateway
credential, credential-encryption key, browser session, or another employee's
state.

PlatformClaw keeps one employee BFF, one shared `BrowserGatewayProxy` policy
layer, one private Gateway client, and one Gateway process. It does not create
per-user Gateway or proxy instances.

## Routing and execution matrix

| Ingress             | Agent and session                         | Execution target            |
| ------------------- | ----------------------------------------- | --------------------------- |
| Employee Web        | Owned personal agent and selected session | Active personal target      |
| Knox direct message | Same personal agent and main session      | Same active personal target |
| Knox group          | `group-<roomId>` room agent               | Server Docker sandbox       |

Knox room workspaces organize files and sessions but are not security
boundaries. Room agents never receive a personal VM allocation or AD
credential, but their tools still execute inside an upstream Docker sandbox.

## Personal execution targets

Each personal agent has one active target:

- `platform_server`: the PlatformClaw basic workspace;
- `assigned_vm`: the employee's assigned Linux account and remote workspace.

The default is `platform_server`. A user without a VM retains the same
`exec` and `process` feature policy in the basic workspace. VM registration and
target selection are separate: an administrator publishes an approved VM
catalog, while the employee selects one VM and confirms their Linux account.

The first release permits one active VM/Linux-account allocation per personal
agent. The Linux account defaults to the authenticated employee account ID and
may be edited when the VM account differs. Users cannot submit arbitrary hosts,
ports, or target addresses. A VM/Linux-account pair has only one active owner.

Selection is atomic at the product boundary: PlatformClaw tests the candidate
VM and transient credential before replacing the current allocation. A failed
test leaves the existing allocation unchanged. Selection, replacement, and
release require the basic workspace. Target switching is rejected during an
active Agent run; administrator revocation first uses that same guarded switch
when the VM is active. Files and background processes remain in the previous
environment.

## Stable plugin routing

Personal agents use one statically configured private backend named
`platformclaw-execution`. The backend receives a prepared `agentId`, treats the
sandbox `scopeKey` as opaque, and resolves one target snapshot at the start of
each run:

- `platform_server` returns the upstream Docker sandbox handle;
- `assigned_vm` returns a SafeConnect SSH execution handle.

Target changes must not rewrite one OpenClaw agent configuration per employee.
Knox room agents retain their explicit server-only route and never enter the
personal execution backend.

The Gateway owns both handles. There is no separate VM executor process or VM
executor image. For VM authentication only, Gateway may read the execution
service-token file and connect to the one-shot credential-broker socket. It
never receives the credential master key or durable password storage. The
broker socket, service token, and password bytes must never enter an agent
sandbox.

No agent command runs in the Gateway container. Server execution, including
Knox groups, uses the upstream Docker backend through a dedicated rootless
Docker daemon endpoint. The host Docker socket is forbidden. Gateway and the
daemon must see identical absolute workspace paths.

This backend shape is approved policy, subject to focused proof that the latest
upstream sandbox contract can preserve local `exec`, `process`, and filesystem
behavior. If upstream provides a cleaner equivalent seam, use it without
changing the product behavior on this page.

## Target changes between runs

PlatformClaw supports atomic target changes between runs, not mid-run hot
swaps. A target change preserves the personal agent ID, session identity, and
conversation history. It does not move workspace files, shell state,
environment variables, packages, or processes.

A change follows this sequence:

1. Reject the change while an agent run or foreground tool call is active.
2. For a VM target, require an active allocation, current credential, strict
   host-key match, and successful SafeConnect connection check.
3. Commit the new target and monotonically increasing revision in one
   control-plane transaction.
4. Require Gateway acknowledgement of that revision.
5. Pin one target snapshot for the complete next run.
6. Add a visible session event and prompt context stating that the location
   changed and files were not transferred.

Any failed prerequisite leaves the previous target and revision active.

## Failure behavior

PlatformClaw never silently falls back from a VM to the basic workspace. A
fallback could execute the same command against a different filesystem and
security boundary.

- A failed change to a VM leaves the previous target active.
- A failure while the VM is active marks the target as requiring connection or
  authentication and blocks `exec`, `process`, and filesystem tools.
- The user may reconnect, update the AD password, or explicitly change to the
  basic workspace.
- Knox direct messages follow the same rule and may return a link to the Web
  execution settings page.
- Knox groups remain unaffected because they always use the basic workspace.

SSH cannot always distinguish an expired password from an incorrect password.
User-facing copy therefore says `Authentication failed - update your password`
instead of asserting expiration.

## Workspace and Core Files

The basic and VM workspaces are independent. PlatformClaw does not copy,
synchronize, merge, delete, or migrate files, packages, process state, or shell
state between them. Returning to a target reuses that target's existing
workspace.

On an assigned VM, the canonical default workspace is
`${HOME}/.platformclaw/workspace`, but it is not the filesystem authority
boundary. File tools may read and write the assigned Linux account's complete
canonical home directory, and command workdirs may be anywhere inside that
home. Paths outside the home remain unavailable to file tools. There is no
PlatformClaw-managed denylist inside the home; Linux account permissions remain
authoritative. Accounts whose canonical home is the filesystem root (`/`) are
not supported because they would erase this boundary.

Workspace files have two owners. `SOUL.md`, `IDENTITY.md`, `USER.md`,
`BOOTSTRAP.md`, and durable memory belong to the Agent and have one canonical
copy in its Gateway workspace. `AGENTS.md` belongs to the active project and is
read from the selected execution target. Codex uses its native selected-
environment discovery for `AGENTS.md`; other runtimes use the generic sandbox
project-bootstrap seam. Subagents receive project instructions but not the
parent Agent's profile or bootstrap state.

PlatformClaw does not mirror or dual-write Agent files, intercept matching
basenames in general file tools, or copy project instructions between targets.
General `read`, `write`, `edit`, and search tools always address the active
workspace. When that filesystem is an assigned VM, the backend advertises a
generic split-workspace capability and core exposes path-bounded Agent
workspace tools for `SOUL.md`, `IDENTITY.md`, `USER.md`, and `BOOTSTRAP.md`.
Those tools cannot access arbitrary Gateway paths. Durable recall uses the
memory tools; writes append to the canonical Agent memory corpus and do not
change wiki or combined-search corpus ownership.

Bootstrap completion is explicit. The Gateway first parses canonical
`IDENTITY.md` and commits its supported fields to the selected Agent's config,
then records the canonical per-Agent SQLite completion/attestation state and
removes Gateway `BOOTSTRAP.md`. A failed identity config write leaves bootstrap
pending and retryable; the next turn reloads that state and canonical Agent files.
Merely having a general read tool, or editing same-named files on a VM, never
proves bootstrap access or completion. Assigned-VM runs must not create Agent
Core Files on the VM. The feature was not previously released, so no VM-file
migration or compatibility reader is required.

The first VM release keeps the existing Agent Core Files UI, clearly labels
those files as Agent-owned and shared across work locations, defers a general
remote Files browser, and uses the SSH filesystem bridge for VM project files.
The UI must never display basic-workspace files as though they came from the
VM, and identity form saves remain authoritative Gateway Agent updates.

## Employee profile and runtime context

Employee directory data remains managed state, not editable `USER.md` content.
The Gateway injects it through a data-only prompt hook keyed by the prepared
agent owner.

Identity ownership fields remain immutable after binding. Mutable directory
fields, including display name, email, department, part, groups, notes, and
approved attributes, refresh after successful employee authentication. Updates
must verify the existing owner and use a revision or compare-and-swap contract.

Every run also receives a generated, credential-free runtime context containing
the active target, user-facing target label, safe host label when applicable,
Linux account and home when appropriate, active workspace, target revision, and an
explicit statement that target workspaces are not shared. The execution plugin
projects this data from the same immutable backend snapshot used by tools, and
upstream prompt assembly delivers it as hidden runtime context. It is also
represented by a persistent UI badge.

A virtual read-only runtime document may be added later. PlatformClaw does not
write dynamic target state into a workspace Core File.

## User experience

Employee UI uses these terms:

- `Basic workspace` for the PlatformClaw server target;
- `My development VM` for the assigned VM target;
- `Work location` for target selection.

The UI does not expose `sandbox`, `backend`, `scopeKey`, credential-broker, or
Gateway terminology.

Login reads and displays the current target but does not ask on every login or
change it automatically. A user with an assigned VM but no credential receives
a non-blocking setup card and may continue in the basic workspace.

Chat, files, and background-task surfaces always show the current work
location. Because SSH may connect per command, the UI reports readiness and
the last successful connection check rather than claiming a permanent
connection.

The execution settings surface provides:

- current work location and readiness;
- active VM catalog, assigned VM label, Linux account, and remote workspace;
- self-service VM selection, replacement, and release;
- AD password registration and update;
- connection test and last successful check;
- explicit target change;
- redacted failure details and target-change history.

Before a change, the UI explains that conversation and Agent settings remain,
while files and processes do not move. After a change, the chat timeline shows
the same boundary.

Administrators manage VM hosts, SafeConnect port and host-key records,
disablement, assignment revocation, connection status, and redacted audit
records. Disablement is a soft lifecycle state rather than a database delete.
Active assignments must be released or revoked before a VM is disabled; active
VMs must be disabled before their endpoint is disabled. Administrators cannot
retrieve stored passwords.

## Credential storage and transport

The approved persistent design advances `platformclaw-control` to SQLite
schema version 2 with personal execution profiles, VM hosts, allocations, and
encrypted credentials.

Credentials use AES-256-GCM with a fresh 96-bit nonce per write and additional
authenticated data binding the ciphertext to its owner, key identifier, and
format version. The master key is a separate Docker secret. It is not stored in
SQLite, Compose configuration, environment variables, Gateway configuration,
or the Gateway container.

A private Unix-domain credential broker owned by `platformclaw-control`
authorizes the prepared agent and allocation, decrypts one credential, and
provides it to one trusted Gateway-side SSH authentication launcher over local
IPC. The launcher supplies bytes to `sshpass -d 3`, then zeroes its buffers.
The VM and agent sandbox never call this broker.

SafeConnect uses OpenSSH keyboard-interactive authentication, strict host-key
verification, one password attempt, and no agent or key fallback. The primary
operational path is `sshpass -d <fd>` with password bytes supplied through an
anonymous one-shot descriptor. A credential-free `SSH_ASKPASS` helper remains
a diagnostic fallback. `sshpass -p`, `-e`, and password-file modes are
forbidden. Password bytes must not enter arguments, ordinary environment
variables, files, logs, browser state, workspaces, audit details, or model
input.

Backup and restore must keep the database and matching master key together.
The current runtime loads one key and fails closed on a mismatched key;
master-key rotation requires a later explicit re-encryption workflow before an
operator replaces that secret.

## Background processes

Managed background processes may remain running in their original target while
the user changes work location. PlatformClaw does not checkpoint or migrate
them. Returning to the original target reconciles the process registry and
reattaches when the process and backend still support it.

- A live process is reattached.
- A completed process reports its terminal result.
- An unreachable process reports `Status check required`.
- PlatformClaw never restarts a missing process automatically.
- Process identity includes agent, execution target, backend runtime, and
  process ID; a PID alone is never routing authority.

The first-release quotas are:

| Limit                                                            |   Value |
| ---------------------------------------------------------------- | ------: |
| Concurrent managed background processes per user per target      |      16 |
| Concurrent managed background processes in the basic workspace   |     256 |
| Concurrent PlatformClaw-managed processes per registered VM host |     512 |
| Completed process records retained per user per target           |     200 |
| Completed process record retention                               | 14 days |
| Default maximum runtime                                          |  7 days |
| One user-approved runtime extension                              | 30 days |
| Per-process output tail buffer                                   |  16 MiB |

At 80% of a deployment-wide limit, PlatformClaw warns administrators. At the
limit, existing processes continue and new background starts fail clearly.
Users and administrators can stop managed processes. User disablement and VM
allocation reclamation must surface remaining processes first.

Gateway-restart reattachment depends on the latest upstream process contract.
If durable reattachment is unavailable, the first implementation may guarantee
reattachment only while the Gateway remains alive and must state that limit in
the UI and operator documentation.

## Skills

Server Docker sandboxes retain upstream discovery and materialization. Gateway
mounts the prepared snapshot read-only at
`/workspace/.openclaw/sandbox-skills/skills`.

VM administrators install approved global skills under
`/opt/platformclaw/skills/<skill>/SKILL.md`. PlatformClaw VM images install
release-owned built-in skills under `/opt/platformclaw/bundle/<skill>/SKILL.md`.
VM users own skills under their remote workspace `skills` and `.agents/skills`.
Remote discovery is added only to `platformclaw-execution`; generic upstream
Docker and SSH behavior stays unchanged. Discovery happens on a Gateway cache
miss, execution-target revision change, or explicit UI refresh. Ordinary runs
reuse the bounded cached catalog. One immutable snapshot is used per run. The
first release has no per-agent allowlist because VM global and built-in skills
are administrator-approved.

VM discovery precedence is remote workspace `skills`, remote workspace
.agents/skills`, the administrator-managed global directory, then the
release-owned built-in directory. The first matching skill name wins. Discovery
uses the existing SafeConnect session and requires the approved Ubuntu VM base
tools (`bash`, `find`, `stat`, and `base64`); it does not copy skill trees on
each run. The Gateway caches only bounded `SKILL.md` content and paths. The
normal read tool serves that exact immutable content, while referenced scripts
execute from their existing absolute VM paths.

VM images must install the canonical bundled `skill-creator` tree from this
release under `/opt/platformclaw/bundle/skill-creator`. PlatformClaw does not
silently copy or update administrator-managed skills during an agent run. This
keeps referenced scripts on the same VM where commands execute and makes image
rollout the single version owner.

Gateway logs emit bounded context-preparation timings without agent IDs, paths,
commands, prompts, or credentials. Filter `openclaw logs --follow` for
`sandbox_context_timing`, `platformclaw_execution_timing`, and
`platformclaw_vm_skill_catalog_timing`. The catalog event distinguishes
`cache-hit`, `cache-miss`, `refresh`, and coalesced `inflight` reads; the other
events break total preparation time into workspace, Gateway skill, target,
catalog, backend-handle, registry, browser, and Skill Workshop phases.

The normal VM catalog scan runs once while a new execution handle is prepared,
matching the upstream sandbox snapshot lifecycle. A Skills UI refresh requests
a fresh scan. Skill Workshop create and evaluate read only the exact target they
need; update lazily refreshes the catalog to resolve the selected live skill.
After a successful apply, PlatformClaw refreshes the catalog before reporting
completion, so the next list/update and the next agent attempt see the change.

`skill_workshop` remains a Gateway-owned model tool. Its ordinary JSON arguments
never contain SSH credentials, VM hostnames, or hidden paths. For an assigned
VM, the prepared backend injects a run-pinned target capability: the tool can
create, update, revise, list, and inspect pending proposals, but only an
explicit Skill Workshop UI action can evaluate, apply, or reject them. Proposal
records, events, evaluations, and rollback facts remain in the Gateway state
SQLite database. Apply writes only
`$HOME/.platformclaw/workspace/skills/<skill>` on the proposal's original VM
allocation, using a target-tree compare-and-swap, an exclusive VM lock, and
rollback recovery. `SKILL.md` is written last. A changed allocation, changed
tree, unsupported entry, or unavailable VM fails closed; there is no Basic
workspace fallback and no remote `openclaw` CLI dependency.

The Basic workspace continues to use upstream Workshop storage and mutation.
Generic Docker and SSH backends remain unchanged; only the private
`platformclaw-execution` backend advertises the extra Workshop target seam.

The personal Workshop UI is shared across both work locations. It always shows
the current location and a proposal target (`Basic workspace` for an unbound
proposal, otherwise the private target label). Location changes reload both
the target and proposal views. Proposals for another location remain visible,
but the UI disables evaluate, revise, and apply until the user switches back;
reject stays available. The UI check does not replace the server's exact
allocation, revision, and tree validation.

## Upstream synchronization gate

Every `sync/upstream-YYYYMMDD` change must read this page before resolving
conflicts or accepting a changed runtime seam. The sync review must record
whether upstream changed:

- sandbox backend registration, factory inputs, handles, or workdir rules;
- prepared agent ownership or opaque scope handling;
- local and SSH execution backends;
- filesystem bridge behavior;
- process persistence, registry, and restart reconciliation;
- prompt hook lifecycle;
- Control UI settings and navigation extension points;
- remote Files UI support;
- Skill Workshop target access, proposal schemas, lifecycle methods, or Control
  UI proposal projections;
- the minimal PlatformClaw execution-target event and current-target prop passed
  into the otherwise upstream-owned Workshop view;
- plugin SQLite or state-store contracts.

Prefer a newer upstream capability when it satisfies this policy. Do not retain
a private seam merely to preserve an earlier implementation sketch. Conversely,
do not accept an upstream merge resolution that silently changes the product,
security, workspace, credential, fallback, or channel policies above.

Keep upstream integration and VM implementation in separate pull requests.
Merge and validate the upstream sync first, then rebuild or reapply the smallest
required PlatformClaw prerequisite on the synchronized `main`.

## Implementation order

After the upstream gate passes:

1. Prove the static `platformclaw-execution` backend can preserve local and SSH
   execution and can pin one target per run.
2. Add schema version 2 and in-memory target/allocation policy tests.
3. Add AES-256-GCM persistence and matching-key restart/restore tests.
   Add online master-key rotation as a later bounded operation before rotation
   is needed in production.
4. Add the Unix credential broker and authenticated one-shot handoff.
5. Add the assigned-VM SafeConnect handle while reusing the upstream SSH
   filesystem and process implementation.
6. Move all server and Knox-group execution to upstream Docker sandboxes using
   a dedicated rootless daemon, then enable Gateway broker access.
7. Add VM remote-skill discovery and explicit refresh.
8. Add employee-profile refresh and runtime-context projection.
9. Add employee and administrator execution UI.
10. Run a Docker fake-SafeConnect E2E covering isolation, failure, restart, and
    Knox-group routing.
11. Validate against a real approved enterprise VM without recording secrets or
    internal host details.

The fake-SafeConnect lane models only the externally confirmed SSH contract:
the composite AD/Linux/target username, keyboard-interactive `Password:`
challenge, Ed25519 host key, command streams, and distinct Linux homes. It runs
the production OpenSSH and `sshpass -d` path. The fixture never claims to model
proprietary SafeConnect internals, never records a password, and is not shipped
in the production image. Real enterprise-VM validation remains the release
gate for network and vendor behavior.

### Redacted enterprise SSH evidence

An approved enterprise endpoint and assigned Ubuntu VM were probed from the
Gateway container on 2026-08-03. Internal host names, addresses, account names,
and host-key material are intentionally excluded from this repository. The
operator-only evidence record retains those values outside Git.

The live probe established the following vendor-boundary facts:

- OpenSSH keyboard-interactive authentication succeeded through the distinct
  enterprise endpoint and reached the assigned VM account.
- A single authenticated OpenSSH control connection served 20 sequential
  command sessions. Fresh connections averaged about 5 seconds; reused
  sessions averaged about 90 milliseconds.
- Concurrent control sessions, an overlapping long and short command, and a
  16 MiB upload/download round trip worked. The uploaded, remote, and downloaded
  SHA-256 values matched.
- The control connection remained usable after a two-minute keepalive window.
- Concurrent session admission varied above eight attempted channels. A
  rejected control session fell back to a fresh non-interactive connection and
  then reported an authentication failure. Production must therefore queue at
  a conservative per-connection limit instead of treating that sequence as a
  stale password.

This proves that connection reuse can remove repeated authentication overhead;
it does not yet prove the PlatformClaw credential-broker path, long-duration
lease lifecycle, revocation, restart recovery, or multi-user isolation. The
probe container did not expose a readable execution-service token mount and the
operator supplied the password directly to `sshpass -d` for this vendor test.

An operator also reports using the same enterprise access path from VS Code for
about one month without visible reauthentication. Treat that as useful lifetime
evidence, not proof that one TCP connection survived continuously: the client
may reconnect with cached authentication state.

A production connection lease should re-resolve target and credential revisions
before reuse. A dead master may trigger one single-flight authentication retry.
Session-capacity rejection should queue, not reauthenticate. A connection lost
after a remote command may have started must not cause blind command replay,
because replay can duplicate side effects.

## See also

- [PlatformClaw architecture](/platformclaw)
- [Architecture decisions](/platformclaw/decisions)
- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Upstream and migration status](/upstream/status)
