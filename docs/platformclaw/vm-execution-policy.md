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
account, assigned by an administrator, that PlatformClaw reaches through
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
| Knox group          | `group-<roomId>` room agent               | Basic workspace only        |

Knox room workspaces organize files and sessions but are not security
boundaries. Room agents never receive a personal VM allocation or AD
credential.

## Personal execution targets

Each personal agent has one active target:

- `platform_server`: the PlatformClaw basic workspace;
- `assigned_vm`: the employee's assigned Linux account and remote workspace.

The default is `platform_server`. A user without a VM retains the same
`exec` and `process` feature policy in the basic workspace. VM registration and
target selection are separate: an administrator assigns the VM and Linux
account, while the user selects which prepared target to use.

The first release permits one active VM/Linux-account allocation per personal
agent. Users cannot submit arbitrary hosts, ports, or Linux accounts.

## Stable plugin routing

Personal agents use one statically configured private backend named
`platformclaw-execution`. The backend receives a prepared `agentId`, treats the
sandbox `scopeKey` as opaque, and resolves one target snapshot at the start of
each run:

- `platform_server` returns a server-workspace local execution handle;
- `assigned_vm` returns a SafeConnect SSH execution handle.

Target changes must not rewrite one OpenClaw agent configuration per employee.
Knox room agents retain their explicit server-only override and never enter the
personal execution backend.

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

Standard Agent Core Files have one canonical server-owned copy shared by both
targets. PlatformClaw does not create separate VM and server copies of
`USER.md`, `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, or `TOOLS.md`. The Control UI
labels these files as Agent settings shared across work locations.

The Gateway reads canonical Core Files while constructing the prompt. A VM
does not need direct database or Core File access. The first VM release keeps
the existing Core Files UI, defers a general remote Files browser, and uses the
SSH filesystem bridge for VM file tools. The UI must never display basic
workspace files as though they came from the VM.

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
Linux account when appropriate, active workspace, target revision, and an
explicit statement that target workspaces are not shared. This context comes
from a prompt hook and is also represented by a persistent UI badge.

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
- assigned VM label, Linux account, and remote workspace;
- AD password registration and update;
- connection test and last successful check;
- explicit target change;
- redacted failure details and target-change history.

Before a change, the UI explains that conversation and Agent settings remain,
while files and processes do not move. After a change, the chat timeline shows
the same boundary.

Administrators manage VM hosts, SafeConnect port and host-key records, remote
workspace roots, user-to-account allocations, disablement, reclamation,
connection status, and redacted audit records. Administrators cannot retrieve
stored passwords.

## Credential storage and transport

The approved persistent design advances `platformclaw-control` to SQLite
schema version 2 with personal execution profiles, VM hosts, allocations, and
encrypted credentials.

Credentials use AES-256-GCM with a fresh 96-bit nonce per write and additional
authenticated data binding the ciphertext to its credential, owner, and format
version. The master key is a separate Docker secret. It is not stored in
SQLite, Compose configuration, environment variables, Gateway configuration,
or the Gateway container.

A private Unix-domain credential broker owned by `platformclaw-control`
authorizes the prepared agent and allocation, decrypts one credential, and
provides it to one local SSH authentication process over one-shot file
descriptor or equivalent IPC. The VM does not call this broker.

SafeConnect uses OpenSSH keyboard-interactive authentication, strict host-key
verification, one password attempt, and no agent or key fallback. The primary
operational path is `sshpass -d <fd>` with password bytes supplied through an
anonymous one-shot descriptor. A credential-free `SSH_ASKPASS` helper remains
a diagnostic fallback. `sshpass -p`, `-e`, and password-file modes are
forbidden. Password bytes must not enter arguments, ordinary environment
variables, files, logs, browser state, workspaces, audit details, or model
input.

Backup, restore, credential rotation, and master-key rotation must preserve the
authenticated encryption and broker boundaries. Exact operational runbooks
land with the schema implementation.

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
3. Add AES-256-GCM persistence, backup, restore, and key-rotation tests.
4. Add the Unix credential broker and one-shot askpass path.
5. Add local and SSH backend handles with filesystem and process support.
6. Add employee-profile refresh and runtime-context projection.
7. Add employee and administrator execution UI.
8. Run a Docker fake-SafeConnect E2E covering isolation, failure, restart, and
   Knox-group bypass.
9. Validate against a real approved enterprise VM without recording secrets or
   internal host details.

## See also

- [PlatformClaw architecture](/platformclaw)
- [Architecture decisions](/platformclaw/decisions)
- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Upstream and migration status](/upstream/status)
