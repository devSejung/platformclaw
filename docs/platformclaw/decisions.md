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
workspace with `sandbox.mode: "off"`.

### PC-008 Keep Knox room agents outside VM credential policy

A Knox room agent has no VM profile and receives no employee AD credential. It
does not use the `platformclaw-vm` sandbox backend.

### PC-009 Treat room workspaces as operational separation

Each Knox room agent has its own workspace for files, agent identity, and
session organization. This workspace boundary is not a security boundary.
Room agents running on the PlatformClaw server are one trust domain and may be
able to access another room workspace through enabled host tools.

### PC-010 Allow local execution for Knox room agents

Knox room agents may use `exec`, `process`, filesystem tools, and approved
managed skills, including execution-oriented skills loaded from the shared
OpenClaw skills directory. Commands run on the PlatformClaw server because the
room agent uses `sandbox.mode: "off"`. Skill selection and workspace routing do
not provide process or filesystem isolation.

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
contains those fields. Workspace `USER.md` rendering belongs to the provisioner,
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

Initial `USER.md` profile injection is not part of this decision. Whole-file
read/write RPC composition cannot safely preserve concurrent user edits or
enforce the expected workspace before mutation. That feature requires a later
atomic Gateway/plugin contract decision.

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

Because the private Gateway client currently has operator authority, browser
messages use only `chat.send`, with command interpretation and external
delivery forced off. Session creation cannot include an initial message or
task, approval replay is not exposed, and operator command catalogs are not
advertised. Browser commands require a later least-privilege Gateway identity
or a separately approved command policy; they must not inherit the control
process credential.
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

The first post-login surface reuses upstream chat and session components and
shows only chat, new-session, and personal-session routes. A single
PlatformClaw UI adapter owns the fixed same-origin Gateway URL, session-expiry
redirect, route availability, identity summary, and logout. Detailed visual
design is deferred. UI hiding is not authorization; PC-116 remains the
request/event security boundary.

The legacy employee entry is behavioral reference only. Its browser bootstrap
token, browser-provided agent/session routing, and broad per-page employee-mode
branches are not migrated.

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
