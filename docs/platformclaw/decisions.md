---
summary: "Accepted and open architecture decisions for the PlatformClaw rebuild"
read_when:
  - Making a PlatformClaw product or security policy decision
  - Reviewing whether implementation may begin for a PlatformClaw phase
title: "PlatformClaw architecture decisions"
---

# PlatformClaw architecture decisions

This log separates approved architecture from decisions that still require
product or security policy. Implementation must not silently resolve an open
decision.

## Accepted

### PC-001 Preserve upstream ownership

PlatformClaw enterprise behavior uses a private control-plane component,
plugins, and existing OpenClaw bindings. Enterprise-specific checks do not get
spread across OpenClaw Gateway methods.

### PC-002 Use opaque sandbox scope keys

The VM sandbox backend stores and looks up the exact `scopeKey` received from
the sandbox contract. It does not parse `agent:<id>` or depend on private
session-key formatting.

### PC-003 Preserve the deployed personal agent ID convention

PlatformClaw keeps an opaque internal user ID, but a new personal agent ID is
derived from the enterprise account ID by replacing `.` with `_` and
canonicalizing case. This preserves the deployed workspace and routing
convention. The control-plane database enforces global agent-ID uniqueness and
fails closed if two account IDs, such as `a.b` and `a_b`, map to the same agent
ID. A later employee-ID or identity-provider change does not rename an existing
agent binding.

### PC-004 Provision personal agents idempotently

The first successful web login reserves and creates at most one personal agent.
Later logins update mutable directory metadata and reuse the existing agent.

### PC-005 Keep the Gateway private

Browser clients connect through `platformclaw-control`. They do not receive an
OpenClaw operator credential or connect directly to an externally exposed
Gateway listener.

### PC-006 Reuse upstream channel bindings

Knox direct and group peers route through upstream OpenClaw `bindings`. The
Knox adapter provides verified stable peer identifiers. PlatformClaw does not
add Knox-specific routing branches to core.

### PC-007 Use dedicated local agents for Knox rooms

Each Knox group room has a dedicated room-owned agent. It does not reuse a
participant's personal agent. The room agent uses a local PlatformClaw server
workspace with upstream Docker sandboxing.

### PC-008 Keep Knox room agents outside VM credential policy

A Knox room agent has no VM profile and receives no employee AD credential. It
uses upstream Docker directly and never enters the personal
`platformclaw-execution` backend.

### PC-009 Treat room workspaces as operational separation

Each Knox room agent has its own workspace for files, agent identity, and
session organization. This workspace boundary is not a security boundary.
Workspace separation is organizational. Docker supplies the process and
filesystem security boundary; room provisioning must not mount another room's
workspace.

### PC-010 Allow local execution for Knox room agents

Knox room agents may use `exec`, `process`, filesystem tools, and approved
managed skills, including execution-oriented skills loaded from the managed
skill root. Commands run in an upstream Docker sandbox through the dedicated
rootless daemon. They never run in Gateway.

### PC-102 Restrict room binding administration

Room-agent creation is automatic under PC-103. Only PlatformClaw
administrators may manually change, disable, or remove a room binding in the
first release.

### PC-103 Automatically provision verified Knox rooms

The first authenticated message from an unbound Knox room idempotently creates
a dedicated room agent and an exact room binding. The agent ID uses the legacy
`group-<chatroomId>` shape after canonical encoding. Initially, verified Knox
chatroom IDs must be globally unique across configured adapter accounts. A
cross-account agent-ID collision fails closed instead of merging rooms;
introducing an account-scoped suffix is a later operator-visible policy change.
Concurrent first messages converge on the same provisioning record.
Caller-supplied agent or session IDs are not routing authority.

### PC-104 Link Knox DMs to the personal main session

The authenticated Knox Proxy resolves the employee's existing personal agent
and supplies its agent ID and main session. The adapter accepts those routing
fields only from the authenticated Proxy contract. A Knox DM therefore reaches
the same agent and `main` session used by PlatformClaw Web.

### PC-105 Use bounded browser sessions

Browser sessions expire after 12 hours of inactivity or seven days absolutely,
whichever comes first. One user may have at most three concurrent sessions.
Logout and account disablement revoke applicable sessions immediately.

### PC-106 Use a dedicated control-plane store and encrypt credentials

`platformclaw-control` owns a dedicated SQLite database. Schema version 1 does
not store AD or VM passwords. When credential storage is approved in a later
schema, passwords are encrypted before storage with a master key supplied
outside the database as a Docker secret. Browser-session signing keys and
credential-encryption keys are separate.

### PC-107 Restrict remaining Knox room tools

Knox room agents do not receive `elevated`, Gateway administration,
cross-agent session, or browser-control capabilities by default. Browser
control may be approved later for a named workflow. PC-010 continues to allow
local execution, process management, filesystem tools, and approved managed
skills.

### PC-108 Use PlatformClaw control schema v1

The approved initial database is `state/platformclaw-control.sqlite` with
SQLite schema version 1. It stores users, LDAP/SAML identities, directory group
claims, personal and Knox-room agent bindings, server-side browser sessions,
managed group/part hierarchy and memberships, and control-plane audit events.
Runtime access uses Kysely-compiled queries over synchronous `node:sqlite`
transactions. The database uses WAL, foreign keys, a five-second busy timeout,
and owner-only permissions on Linux.

### PC-109 Start without legacy data migration

The rebuild does not read or import the legacy `platformclaw.sqlite` database
or employee-activation JSON at runtime. Users and bindings are provisioned into
the new database. If migration becomes necessary later, it must be an explicit
one-time import rather than a fallback reader or dual-write path.

### PC-110 Preserve managed group and part administration

Managed organizational groups and parts remain distinct from LDAP/SAML
directory group claims. Administrators create and archive groups and parts,
assign leaders, and change global user role or status. A group leader may
manage member assignments in that group and its child parts but cannot assign
leaders or remove their own leadership. Changes are audited, and the last
active administrator cannot be disabled or demoted.

### PC-111 Bootstrap administrators from deployment configuration

A new control-plane database requires at least one initial administrator
account ID supplied by deployment configuration backed by a Docker secret.
There is no source-code fallback administrator. After bootstrap, administrator
role changes use the control-plane management API and audit log.

### PC-112 Reject a fourth browser session

When a user already has three active browser sessions, a new login returns a
session-limit response and does not silently terminate another device. Expired
and revoked sessions do not count toward the limit. This policy needs no schema
migration if product policy later changes.

### PC-113 Normalize employee authentication outside OpenClaw core

`platformclaw-control` calls the current employee authentication service using
the URL in `PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL`. The optional service bearer
uses `PLATFORMCLAW_EMPLOYEE_AUTH_BEARER_TOKEN`. LDAP results normalize into the
provider-independent principal contract; SAML can replace the adapter later.
External `agentId` and `sessionKey` fields are ignored because the control-plane
binding is routing authority.

The directory profile passed to personal-agent provisioning includes employee
ID, display name, email, department, part, Confluence space, notes, directory
groups, and explicitly supplied extensible attributes. The session cookie never
contains those fields. Profile payload rendering belongs to the provisioner,
not the authentication adapter.

### PC-114 Use a dedicated private-downstream CI workflow

PlatformClaw uses GitHub-hosted Ubuntu workflows with read-only repository
tokens. The required fast workflow classifies changed paths: private overlay
changes run focused owner checks, while any OpenClaw-owned path falls back to
the upstream changed-surface gate. Control-plane changes always run the entire
control-plane package test suite, typecheck, lint, and build. Lightweight
repository policy guards remain mandatory on the fast path. A separate full
workflow runs broad changed-surface validation after `main` pushes, on manual
dispatch, and before merging `sync/upstream-*` pull requests. OpenClaw workflows
that require OpenClaw organization runners, GitHub Apps, release secrets,
external services, or private-repository CodeQL licensing remain disabled in
the private origin. Workflow enablement is audited after every upstream sync;
OpenClaw credentials are never copied into PlatformClaw merely to satisfy
unrelated upstream automation.

### PC-115 Provision personal agents through Admin HTTP RPC

`platformclaw-control` uses the private authenticated `admin-http-rpc` plugin
for existing `agents.list` and `agents.create` methods. It does not import
OpenClaw core or write agent configuration directly. Agent adoption requires
the reserved control-plane agent ID and exact expected workspace. The Gateway
operator bearer stays in the deployment secret store and never enters browser
or workspace state.

Profile synchronization uses the plugin-owned
`platformclaw.profile.seed` method. It verifies the configured agent and exact
workspace, validates the bounded JSON payload, and atomically updates an
agent-ID entry in the shared plugin SQLite store. It never writes `USER.md` or
another workspace file. The original employee owner remains immutable while
approved directory fields refresh after successful authentication. Malformed
state or a different employee owner fails closed.

The enabled `admin-http-rpc` plugin looks up the profile by the run's agent ID
and adds it as explicitly data-only prompt context. Agents without a profile
entry, including Knox room agents, receive no employee profile context.
Workspace moves cannot strand profile data in an old user directory because
profile state is not workspace-owned. The
namespace uses the plugin-state backend's 50,000-row plugin ceiling with
`reject-new`, well above the initial 150-user operating target; reaching that
ceiling fails provisioning rather than evicting another employee's identity.

### PC-116 Proxy browser Gateway access through fail-closed policy

Browsers never receive an OpenClaw operator credential and never connect to the
private Gateway directly. `platformclaw-control` resolves the opaque browser
session on every request and event, requires its active personal agent binding,
and uses its own private Gateway client behind the control-plane package.

The proxy maintains explicit method and per-method parameter allowlists. New
upstream methods or parameters are denied until reviewed, preventing an
upstream operator feature from silently becoming browser-accessible. Agent IDs
are pinned server-side, session keys are checked against the owned agent, and
agent/session collections, direct session results, and asynchronous events are
filtered again on return. Denials are audited without request payloads or
credentials. The HTTP/WebSocket listener is a separate hosting slice and uses
this policy boundary rather than reimplementing authorization. It speaks the
upstream Gateway frame protocol, reuses the public Gateway client for the
private connection, replaces the operator hello with a browser-safe projection,
and regenerates event sequence numbers after filtering.
Events without an owned session key, including raw agent-run events, are
dropped; session-scoped chat and tool events are the browser streaming surface.

The listener requires one configured public origin and does not infer external
authority from forwarded headers. Operator secret resolution, persistent path
selection, process supervision, reverse-proxy routing, and Control UI login
bootstrap remain deployment composition responsibilities.

Because the private Gateway client has operator read/write/admin authority required for trusted
chat provenance controls, browser
messages use only `chat.send`, with command interpretation and external
delivery forced off. Session creation cannot include an initial message or
task, approval replay is not exposed, and operator command catalogs are not
advertised. Browser commands require a later least-privilege Gateway identity
or the separately enforced browser command policy; browsers never receive or
inherit the control-process credential or its admin scope.
Model selection is limited to the configured catalog and cannot carry a raw
model/auth-profile override. Browser session patches cannot archive sessions
because the operator path would also disable bound administrator cron jobs.
Abort requests target the authenticated session only; browsers cannot select a
run ID because the shared operator connection cannot prove ownership of it.

### PC-117 Bootstrap Web through a narrow Control UI adapter

PlatformClaw serves a separate employee login shell and the upstream Control UI
from the same public origin as `platformclaw-control`. The authenticated app
uses the opaque browser cookie and the shared Web Gateway policy proxy. It does
not receive a Gateway credential or use a per-user proxy or Gateway client.

The first post-login surface reuses upstream chat, session, task, and Agent
components. Browser users can open chat, new-session, personal-session,
agent-scoped background-task, and their bound Agent page. Personal Agent access
is limited to the upstream allowlisted workspace files and a read-only skill
inventory. Session model selection is limited to models returned by the
configured catalog. Background task reads and cancellation are forced to the
authenticated Agent, and task results are revalidated before they cross the
shared Gateway boundary. Filesystem paths, cross-agent results, system
configuration, Agent policy mutations, and operator surfaces stay behind the
BFF policy.

A single PlatformClaw UI adapter owns the fixed same-origin Gateway URL,
personal-agent access mode, session-expiry redirect, route availability,
identity summary, and logout. Detailed visual design is deferred. UI hiding is
not authorization; PC-116 remains the request/event security boundary.

Personal users may open upstream Appearance preferences for browser-local
theme, text, chat, and language choices. This page must not read or mutate the
operator Gateway configuration. Other Settings routes remain hidden unless
their BFF capability and user ownership policy are explicitly approved.

Administrator Control UI remains a separate private deployment surface. It
must not share the employee BFF endpoint, cookie authority, or browser method
allowlist; its listener and administrator authentication are deployment work.

The legacy employee entry is behavioral reference only. Its browser bootstrap
token, browser-provided agent/session routing, and broad per-page employee-mode
branches are not migrated.

### PC-118 Reconcile incomplete provisioning before public ingress

`platformclaw-control` reconciles every binding left in `provisioning` before
its public listener accepts traffic. A personal binding becomes active only
when the Gateway still has the exact agent and workspace and the plugin-owned
profile claim matches the binding owner. Missing agent or profile state becomes
an explicit failed binding so the next authenticated login can retry with fresh
directory data. Workspace or profile ownership conflicts fail closed and are
never overwritten or deleted automatically.

A transient Gateway or profile-store failure leaves the current binding
unchanged and fails process startup; container supervision retries later.
Existing active bindings are not scanned during this startup pass. Until the
Knox room runtime owns room retry, an incomplete room binding becomes failed
with a distinct reason instead of being guessed active. This policy uses SQLite
schema v1 unchanged.

### PC-119 Freeze personal execution-target policy before upstream sync

The [VM execution policy](/platformclaw/vm-execution-policy) is the canonical
product and security contract for personal execution on the PlatformClaw basic
workspace or one employee-selected, administrator-approved VM/Linux account. It approves a static
private `platformclaw-execution` backend, run-boundary atomic target changes,
split Agent-owned and execution-owned workspace files, mutable managed
employee-profile projection,
credential-free per-run runtime context, no automatic VM fallback, independent
target workspaces, and environment-scoped background-process reconciliation.

Administrators publish the active VM catalog but do not type every employee's
Linux account. The account defaults to the authenticated account ID and remains
editable. Candidate SSH validation must succeed before an allocation is
atomically replaced. Users can release their allocation; administrators can
revoke it. VM and endpoint removal is soft-disable only and respects dependency
order. No arbitrary employee-supplied network target is accepted.

It also approves SQLite schema version 2 for execution profiles, hosts,
allocations, and AES-256-GCM credentials; a Docker-secret master key; and a
private Unix-domain one-shot credential broker. The latest upstream must be
synchronized and its sandbox, filesystem, process, prompt-hook, plugin-state,
and Control UI contracts rechecked before implementation. Upstream integration
and VM implementation remain separate changes.

### PC-120 Detect the Linux deployment service account

Linux deployment does not reserve numeric UID/GID 1000. The operator names a
dedicated non-root service account and the PlatformClaw Compose wrapper resolves
its current numeric UID/GID and rootless Docker runtime directory. Gateway,
Control, persistent state, secrets, workspace ownership, and the rootless
sandbox daemon use that same account boundary. A state-init container may
repair persistent-volume ownership when the configured account changes, but it
has no network and receives only the minimum ownership capabilities. Windows
preview and Linux smoke fixtures keep their internal UID 1000 because that UID
belongs to their disposable rootless-Docker fixture, not the host deployment
contract.

### PC-121 Expose bounded employee profile and skill self-service

Employee browsers may open Profile, Notifications, About, and Skills. Profile
identity comes from the authenticated directory principal and is read-only;
usage queries are forced to the employee's bound Agent. Notifications remain
browser-local and do not expose the shared Web Push registry. About has no
additional Gateway authority.

The Skills page follows the active personal execution target. In the Basic
workspace, an employee may install ClawHub skills and use Skill Workshop only
for their bound Agent workspace. Global enablement, API keys, dependency
installation, managed/shared skill roots, and Gateway configuration remain
unavailable. On an assigned VM, the page shows the existing remote skill
catalog and supports explicit refresh only. Installation and Workshop writes
remain blocked until a dedicated, reviewed VM write contract exists. Changing
execution target never copies or deletes skills from either environment.

Plugin lifecycle operations remain administrator-only and use the existing
upstream plugin RPCs. The employee BFF adds role and Agent checks without
changing upstream Gateway protocol or skill/plugin ownership boundaries.

### PC-122 Expose Agent-scoped activity, usage, and cron self-service

Employee browsers may open Activity, Usage, and Automations. Activity and
usage queries are forced to the authenticated employee's personal Agent.
Automation job queries are forced to that same Agent, and every
mutation of an existing job is pinned to the inspected config revision and
rechecked under the cron store lock before it commits or runs.

Browser-created jobs support only `at`, `every`, and `cron` schedules with
`agentTurn` or `systemEvent` payloads. The BFF rejects process-backed schedules,
shell/script payloads, cross-Agent session references, webhooks, explicit
outbound targets, and configurable failure alerts. Existing process-backed or
shell jobs are excluded from employee reads, history, and mutations even when
they name the employee's Agent. Browser-created jobs use no delivery, and the
employee editor does not present outbound delivery controls; conversational
cron creation continues through the upstream `cron` tool, whose signed
agent-runtime caller scope owns Agent, session, account, and delivery
provenance. Scheduled `agentTurn` runs use the normal personal
execution backend, so an assigned VM does not need the OpenClaw CLI.
Employee reads additionally require the immutable authenticated owner envelope
(Agent, owner session, and account); ownerless legacy jobs fail closed before
pagination, regardless of their current delivery or payload fields.
Automation list and derived status reads always disable delivery previews;
resolved routing labels and details are not part of the employee surface.

Employee cron run history remains hidden. Existing history rows do not carry
immutable Agent, schedule, payload, and session provenance, so authorizing them
from a job's mutable current definition could disclose an earlier privileged
run. A future history surface must persist and filter on execution-time
provenance rather than reconstructing authority from the current job.

Bootstrap remains deferred. The upstream `BOOTSTRAP.md` currently instructs
the agent to execute host control-plane CLI commands such as
`openclaw agents set-identity`. Those commands are incorrectly routed through
the assigned-VM shell backend. Bootstrap must move identity, recommendation,
plugin, and acknowledgement mutations to typed host/Gateway operations before
it is enabled for VM-backed employees; installing the OpenClaw CLI in employee
VMs is not an accepted workaround.

PC-127 resolves this deferral with typed, Gateway-owned Agent workspace and
bootstrap operations. Bootstrap remains disabled until that contract is
implemented end to end.

### PC-123 Expose the bounded personal session surface

Employee browsers may create and continue sessions only for their authenticated
personal Agent. New-session attachments use the upstream attachment composer,
but the BFF removes them from `sessions.create` and relays the initial turn
through the already authorized `chat.send` path after validating the returned
session key. Attachment-only initial turns are supported. A rejected initial
turn keeps the created session and uses the upstream draft handoff so the user
can retry without selecting the files again.

Incognito, session sharing, cross-Agent sessions, and global or unknown
sessions remain unavailable. The BFF does not advertise sharing visibility
policy, and the personal-Agent UI hides incognito and sharing controls. Session
and usage selectors show the concrete personal Agent rather than a misleading
all-Agents option. UI hiding is not authorization: request parameters, returned
rows, direct results, and events remain pinned and revalidated by PC-116.

This slice is based on PlatformClaw's upstream sync through `053384fa01d2`.
Upstream `c092ec437c7` later moved the unchanged chat sharing control from
`chat-pane-header-render.ts` to `chat-pane-header.ts`; the next sync must carry
the personal-Agent visibility guard to that owner without retaining a compat
wrapper.

### PC-124 Share administrator-managed MCP servers with every employee Agent

Phase 1 uses upstream OpenClaw `mcp.servers` as one administrator-owned global
registry. Credential-free servers and administrator-configured shared
credentials are available to every employee Agent. Shared credentials therefore
must carry only organization-wide authority. PC-125 adds personal credentials
without adding personal server registries.

PlatformClaw's managed sandbox policy admits the upstream `bundle-mcp` plugin
for every sandboxed Agent. Existing installs receive the same gate during
managed-config reconciliation, while normal upstream tool profiles, per-server
filters, and MCP runtime isolation remain authoritative.

An existing sandbox deny that blocks `bundle-mcp` is an explicit operator
migration. PlatformClaw does not remove broad wildcard or `group:plugins`
denials automatically because doing so could expose unrelated plugin tools.
Reconciliation reports the conflicting global or Agent policy, and the image
update path rolls back if the operator did not remove it before rollout.

Registration uses the existing server-side OpenClaw MCP CLI or **Settings >
MCP** in the private administrator Control UI. That page uses a narrow
administrator-only BFF which projects only non-secret MCP server metadata and
accepts bounded server actions. The employee browser Gateway and employee BFF
still expose no generic Gateway config reads, writes, credentials, or lifecycle
methods. This preserves PC-117 and keeps upstream MCP UI/core unchanged.

### PC-125 Store personal MCP credentials in PlatformClaw Control

Administrators continue to own the global `mcp.servers` registry. A server is
either credential-free or uses one administrator-configured shared credential
under PC-124, or an administrator marks it for personal credentials through the
private `platformclaw-user-mcp` plugin. Employees cannot register arbitrary MCP
servers or change server URLs, transport, OAuth scope, or API-key header names.

Personal servers allow every discovered tool by default. Administrators may
block individual tools with the existing server `toolFilter`, and session tool
denials remain authoritative. Server registration approval and tool denial are
separate decisions: approving a server does not prevent later tool-level
restriction, and tool policy does not grant access to an unapproved server.

The employee BFF exposes a same-origin personal-credential UI for bearer
tokens, administrator-pinned API keys, and MCP OAuth. OAuth uses PKCE, a
single-use state with a ten-minute lifetime, SDK discovery and dynamic client
registration, and encrypted refresh-token persistence. Credential-free servers
need no employee setup and never produce a missing-credential prompt.
Bearer-token and API-key servers may use plaintext HTTP when an administrator
accepts the prominent Control UI warning; HTTPS remains strongly recommended.
OAuth server, authorization, discovery, and token endpoints require HTTPS.
Control applies DNS-pinned SSRF checks to discovery, registration, token, and redirect hops,
bounds each network request and response, and serializes refresh-token rotation
per user and server with revision-checked persistence.
The same **Settings > MCP** route is visible to employees, but it lists only
administrator-approved servers that require a personal credential. An
administrator sees the global server registry first and their own personal
credential section below it. Credential-free and shared-credential servers are
shown in the administrator registry but never create employee setup work.
PlatformClaw opts into the generic Control UI Settings navigation shell for
personal-agent sessions, so MCP stays in Settings instead of becoming a raw
product footer shortcut. The work-location control remains a downstream footer
accessory; upstream receives only the product-agnostic navigation opt-in.
The approved URL, credential kind, API-key header, and OAuth scope are part of
the credential binding and fail closed after a mismatch. MCP policy is
process-stable; changing it requires a coordinated Gateway and Control restart.

`platformclaw-control` stores personal MCP credentials as AES-256-GCM envelopes
in the control SQLite database. It reuses the deployment credential master key
with an MCP-specific authenticated-data domain and binds ciphertext to user,
server, format, and key ID. The additive tables do not advance schema version 2.
Secrets never enter OpenClaw config, browser responses, Gateway state, logs, or
agent workspaces.

At run time, the Gateway supplies only its host-selected `agentId` to the exact
server-name resolver. Control resolves the active personal binding and returns
transient headers over the existing authenticated owner-only local execution
handoff socket. Missing, disabled, mismatched, expired, or undecryptable state
fails closed. The employee browser Gateway allowlist remains unchanged.

Replacing or deleting a credential disposes that Agent's requester-scoped MCP
runtime before the update is reported complete. Browser logout also requests
runtime disposal but preserves the encrypted credential. Account disablement
revokes browser sessions and deletes all personal MCP credentials. The
administrator path invalidates requester-scoped MCP connections for every
configured Agent after a server, credential mode, or tool filter changes.
Normal runtime expiry is secondary cleanup, not revocation authority.

### PC-126 Bind Skill Workshop apply to the proposal's execution target

PlatformClaw reuses upstream Skill Workshop for both Basic and assigned-VM
work. It does not add a second proposal service, proposal file store, or VM-side
OpenClaw CLI. Proposal state stays in the existing Gateway SQLite tables. An
optional target binding inside the canonical proposal record names only the
private backend, stable VM allocation, and user-visible target label; this is
an additive record field and does not change the SQLite schema version.

The private execution plugin owns VM tree reads and mutations through the
generic sandbox filesystem bridge. Core Workshop receives only a narrow,
process-local target capability. The agent may draft VM proposals, while the
employee must evaluate/apply/reject them in Skill Workshop. Apply re-resolves
the current target and requires the original allocation identity, exact
proposal revision, and exact evaluated tree. Concurrent or external edits fail
closed. Interrupted writes reconcile from SQLite rollback facts before a retry.

Administrators own global skills under `/opt/platformclaw/skills`. PlatformClaw
VM images own built-in skills under `/opt/platformclaw/bundle`, including the
canonical bundled `skill-creator`. Users own only workspace skills. This avoids copying server
paths into a VM, avoids split bundle versions, and keeps normal PlatformClaw
server users on the unchanged upstream Workshop path. Future upstream syncs
must prefer a native remote Workshop target contract if it satisfies these
allocation, approval, CAS, recovery, and no-fallback invariants.

The Workshop tab remains visible in both personal work locations. A
PlatformClaw UI overlay shows the current work location and each proposal's
bound target without changing the upstream proposal store or Gateway protocol.
Proposals remain visible after a location change, but evaluate, revise, and
apply are disabled when the visible target does not match; reject remains
available. This is guidance only: the server-side allocation and target checks
above remain authoritative. A target revision change invalidates and reloads
the Workshop target and proposal snapshots.

### PC-127 Split Agent state from execution-project instructions

`SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, and durable memory are
Agent-owned Gateway state. `AGENTS.md` is project-owned state discovered from
the selected execution environment. This matches Codex's native environment
filesystem discovery and prevents an assigned VM from silently overriding an
Agent profile or a Gateway file from masquerading as VM project policy.

Assigned-VM backends advertise one generic split-workspace capability. Core
then supplies exact-file Agent workspace operations and an explicit bootstrap
completion operation. General file tools keep their normal active-workspace
meaning. There is no basename routing, mirroring, dual-write, fallback reader,
or compatibility migration. Memory search, read, and append target the
canonical per-Agent corpus; wiki and combined-search corpus selection remain
unchanged.

Bootstrap completion first parses the canonical `IDENTITY.md` and commits its
name, theme, emoji, and avatar to the selected Agent's Gateway config. Only
after that control-plane write succeeds does it record the per-Agent SQLite
state and best-effort remove canonical `BOOTSTRAP.md`; a failed identity write
therefore remains retryable. Tool presence alone is not proof of access.
Subagents may receive active-project instructions but never the parent Agent
profile or bootstrap mutation tools. The UI labels Agent files as shared
across work locations and keeps identity saves on the same Gateway owner path.

This adds no SQLite schema version. It reuses the canonical Agent database and
the existing setup/attestation rows. Because assigned-VM execution was not
released, same-named files created during development are not imported,
deleted, or read as compatibility state; new runs simply stop creating them.

## Open operational decisions

No remaining decision blocks the SQLite v1 store. Deployment work still needs
backup frequency and retention and any named workflow that requires browser
control.

## Decision procedure

For each open decision:

1. Record the chosen option and rationale here.
2. Record migration impact if the choice may change later.
3. Update the Phase 1 contracts and tests.
4. Only then implement the affected persistent schema or runtime behavior.
