---
summary: "Phase 1 design for PlatformClaw identity, sessions, agent provisioning, and web and Knox ingress"
read_when:
  - Implementing PlatformClaw login or user sessions
  - Provisioning user or room agents
  - Routing PlatformClaw Web or Knox conversations to agents
title: "PlatformClaw control plane phase 1"
---

# PlatformClaw control plane phase 1

Phase 1 creates one authoritative path from an authenticated ingress to an
OpenClaw agent. It supports two ingress families from the beginning:

- PlatformClaw Web sessions authenticated through the current enterprise login
  adapter and, later, a SAML adapter.
- Knox direct and group conversations authenticated by the Knox adapter.

Phase 1 does not implement VM execution. It produces the stable identity and
agent binding that the later `platformclaw-vm` sandbox backend will consume.

## Outcome

After Phase 1:

1. A web login resolves one stable PlatformClaw user.
2. The first successful login provisions at most one personal OpenClaw agent.
3. Later logins reuse that agent even if mutable employee attributes change.
4. A browser can access only the agent selected by its server-side session.
5. A Knox message routes through a verified channel binding, not an agent ID
   supplied by message text or other untrusted payload fields.
6. Knox DMs share the personal agent's Web `main` session, while Knox rooms use
   dedicated room agents and room sessions.

## Implementation status

Slices 1 through 4 are implemented in `packages/platformclaw-control-plane`. They
define the identity, browser-session, personal-agent provisioning, Knox room
binding, authenticated Knox DM routing, managed group/part contracts,
employee-auth HTTP adapter, opaque-session login service, and framework-neutral
browser-auth HTTP boundary. The employee browser-auth runtime now assembles the
LDAP-phase adapter and SQLite session store, and the personal-agent provisioner
calls the Gateway Admin HTTP RPC boundary to create or adopt the exact agent and
workspace. The in-memory store covers contract behavior, and the SQLite store
persists the approved schema version 1.

Focused tests cover LDAP metadata refresh, LDAP-to-SAML identity linking,
employee ID correction conflicts, concurrent personal and room provisioning,
room agent ID compatibility, browser session limits and expiry, account
disablement, Knox DM ownership checks, restart persistence, administrator
bootstrap, managed group/part permissions, and audit events.

The LDAP-compatible adapter calls the existing employee-auth HTTP service. The
HTTP boundary exposes login, logout, and current-session handlers, but still
requires its host process to inject bounded JSON parsing, a trusted client IP,
TLS state, and an auth rate limiter.

These slices do not contain credential encryption, SAML protocol handling,
Knox transport code, or the deployable HTTP listener/Gateway proxy. OpenClaw
agent creation now occurs only through the private Admin HTTP RPC plugin;
PlatformClaw still does not import OpenClaw core. Initial `USER.md` profile
injection remains deferred until an atomic, ownership-aware Gateway/plugin
contract is approved.

## Process boundary

`platformclaw-control` is the externally reachable web process. The name
describes one deployable component, not three separate services.

```text
Browser ────────────────┐
                       │ HTTPS / WebSocket
Knox adapter ──────────┤ verified ingress
                       ▼
              platformclaw-control
              - auth adapters
              - server sessions
              - provisioning
              - ingress authorization
              - Gateway proxy
                       │ private operator connection
                       ▼
                OpenClaw Gateway
                       │
                       ▼
                 selected agent
```

The OpenClaw Gateway binds only to a private interface available to
`platformclaw-control`. Browser clients never receive the Gateway operator
credential.

## Identity model

Authentication adapters normalize provider-specific results into one shape:

```ts
type EnterprisePrincipal = {
  provider: "ldap" | "saml";
  subject: string;
  accountId?: string;
  employeeId: string;
  displayName?: string;
  email?: string;
  department?: string;
  groups?: string[];
};
```

`provider` and `subject` identify the authentication record. They do not become
the OpenClaw agent ID. PlatformClaw creates an opaque internal user ID and one
opaque agent ID on first provisioning. This prevents an LDAP-to-SAML migration,
employee ID correction, or department transfer from changing the agent's
workspace and session identity.

Mutable directory attributes are refreshed after successful authentication.
They are metadata and policy inputs, not ownership keys.

Each linked identity also records the last employee ID verified by its provider.
One provider may advance the canonical employee ID only while it agrees with the
current value. A lagging linked provider fails closed until it reports the new
canonical value, preventing LDAP/SAML login order from reverting a correction.
Authentication results also carry a per-identity version timestamp. Older
results and equal-version employee-ID disagreements fail closed. The persistent
store must reread and compare that version in the same write transaction before
changing the canonical employee ID.

## Server session model

The browser receives an opaque, random session cookie. The cookie contains no
employee attributes, agent ID, VM profile, or credential material.

```text
browser cookie -> server session -> user -> personal agent
```

Required cookie properties are `HttpOnly`, `Secure`, and an explicit
`SameSite` policy. Logout and account disablement revoke the server session.
Authorization reads current ownership from the control-plane store instead of
trusting mutable claims embedded in a long-lived browser token.

Sessions expire after 12 hours of inactivity or seven days absolutely,
whichever comes first. One user may hold at most three concurrent browser
sessions.

## Idempotent personal-agent provisioning

Provisioning uses a state machine because database reservation and OpenClaw
agent creation cannot be one database transaction.

```text
NEW -> PROVISIONING -> ACTIVE
                    -> FAILED
ACTIVE -> DISABLED
```

The control-plane store enforces one personal agent per user and one owner per
agent. Concurrent first logins converge on the same provisioning record.

Provisioning performs these steps:

1. Upsert the enterprise principal and resolve the internal user ID.
2. Reserve an opaque agent ID under a uniqueness constraint.
3. Call the upstream `agents.create` Gateway method through the private admin
   HTTP RPC plugin.
4. Verify the created agent ID and workspace path.
5. Seed only approved profile fields into the agent workspace.
6. Mark the binding active and issue the browser session.

If a retry observes an existing OpenClaw agent, it adopts that agent only when
the control-plane ownership record matches. Name collision alone is not proof
of ownership.

Upstream evidence:

- `src/gateway/server-methods/agents.ts` owns `agents.create`.
- `extensions/admin-http-rpc/src/methods.ts` exposes the method to an
  authenticated operator HTTP caller.
- `docs/concepts/multi-agent.md` defines the per-agent workspace and session
  boundary.

## Web Gateway proxy

The browser connects to `platformclaw-control`, not directly to the OpenClaw
Gateway. For every accepted request the proxy resolves the server session and
uses its owned agent binding.

The proxy must:

- ignore browser-supplied agent IDs when the operation is user-scoped;
- construct or validate session keys against the owned agent;
- expose an explicit allowlist of user-facing Gateway methods;
- deny configuration, channel administration, node administration, Gateway
  lifecycle, and other operator-only methods;
- filter response rows and asynchronous events by the owned agent and session;
- record an audit event for denied cross-agent attempts.

UI hiding is not authorization. The proxy enforces the rule even when a client
sends a hand-crafted Gateway frame.

## Knox ingress

Knox remains a channel plugin and adapter integration. PlatformClaw does not add
a Knox special case to OpenClaw routing core.

A verified Knox envelope supplies stable transport identifiers:

```text
channel = knox
accountId = <configured adapter account>
peer.kind = direct | group
peer.id = <stable Knox user or room ID>
```

The adapter must authenticate the Knox Proxy request before using routing
fields. Display names, room names, and message text are never routing
authority. For DMs, the authenticated Proxy supplies the existing personal
agent ID and its `main` session. For rooms, PlatformClaw resolves the verified
room ID through the room binding and ignores inbound agent or session
overrides.

OpenClaw already routes channel peers through `bindings`, with exact peer
matches taking precedence. Group sessions remain isolated from web main
sessions:

```text
Web:        agent:<personalAgentId>:main
Knox DM:   agent:<personalAgentId>:main
Knox room: agent:<roomAgentId>:knox:group:<roomId>
```

Exact key formatting is owned by current OpenClaw channel routing helpers; the
PlatformClaw adapter must not construct session keys by string concatenation.

Upstream evidence:

- `src/routing/resolve-route.ts` owns deterministic binding precedence.
- `src/routing/session-key.ts` owns channel session-key construction.
- `docs/channels/channel-routing.md` documents peer-to-agent bindings.
- `extensions/feishu/src/dynamic-agent.ts` is an existing plugin-owned example
  of guarded channel-driven agent creation and binding.

## Knox room agents

Each Knox group conversation receives a dedicated room-owned agent. A room is
not bound to an employee's personal agent. This preserves a separate workspace,
identity, and session history for the shared conversation.

```text
verified Knox room ID -> room binding -> dedicated room agent
```

The legacy deployment has been observed to route rooms with an agent ID shaped
like `group-<chatroomId>`. The current `devSejung/knox-adapter` source does not
derive that ID or create the agent. It accepts an explicit inbound `agentId` and
`sessionKey`, verifies only that the session key starts with the matching agent
prefix, and forwards them to the Gateway. Therefore the legacy Knox Proxy or
another component before the adapter supplies the `group-<chatroomId>` value.

In the rebuild, PlatformClaw owns this provisioning step. The first
authenticated message from an unbound room creates the room agent and exact
binding idempotently. The agent ID retains the legacy `group-<chatroomId>` shape
after canonical encoding. Initially, authenticated Knox chatroom IDs must be
globally unique across configured adapter accounts. A cross-account collision
fails closed; PlatformClaw does not silently merge rooms or introduce an account
suffix without an explicit operator policy change. Concurrent first messages
converge on the same record, and inbound agent or session IDs do not override
the verified room binding.

Room agents use a local workspace on the PlatformClaw server and set
`sandbox.mode: "off"`. They do not resolve a VM profile, use SafeConnect, or
receive an employee AD credential. Web personal agents continue to use the
later `platformclaw-vm` backend.

Room agents may use `exec`, `process`, filesystem tools, and approved managed
skills on the PlatformClaw server. Most managed skills require execution, so
host execution is part of the accepted room-agent contract rather than an
exception.

Each room still receives a distinct workspace for organization, agent identity,
and session history. The workspace is not a security boundary. With sandboxing
off, enabled host tools may reach the Gateway container and another room's
workspace. PlatformClaw therefore treats all local room agents as one trust
domain and must not represent workspace separation as filesystem or process
isolation.

Only PlatformClaw administrators may manually change, disable, or remove a room
binding. Room agents do not receive `elevated`, Gateway administration,
cross-agent session, or browser-control capabilities by default.

## Data ownership

PlatformClaw owns these records:

- enterprise users and authentication identities;
- LDAP/SAML directory group claims;
- administrator/member roles and active/disabled status;
- managed group/part hierarchy and leader/member assignments;
- browser sessions and revocation state;
- user-to-personal-agent ownership;
- Knox peer-to-agent ownership and approval metadata;
- provisioning state and audit records;
- VM profiles, credentials, and agent-to-VM bindings in a later phase.

OpenClaw owns:

- the configured agent entry;
- agent workspaces and agent state directories;
- session history;
- channel routing execution;
- sandbox backend execution after a backend is selected.

The control-plane store does not duplicate OpenClaw transcripts or runtime
state. OpenClaw configuration does not store employee passwords, VM passwords,
or mutable PlatformClaw session records.

`platformclaw-control` stores schema version 1 in
`state/platformclaw-control.sqlite`. It uses WAL, foreign keys, a five-second
busy timeout, Kysely-compiled runtime queries, synchronous write transactions,
and owner-only file permissions on Linux. New personal agents preserve the
deployed account-ID convention: replace `.` with `_`, canonicalize case, and
fail closed on collisions. The legacy database and activation JSON are not
runtime fallback sources.

AD and VM passwords remain outside schema version 1. A later approved schema
stores them encrypted with a master key supplied as a Docker secret. The
credential-encryption key is separate from browser-session signing keys.

## Implementation slices

Phase 1 should land in bounded slices:

1. Define control-plane identity, session, provisioning, and ingress-binding
   contracts with an in-memory test implementation.
2. Add the approved SQLite v1 persistent store for identity, management,
   bindings, sessions, and audit records. Credential encryption remains a
   later schema decision.
3. Implement the LDAP adapter behind the normalized principal contract.
4. Implement idempotent `agents.create` provisioning.
5. Implement the web session and Gateway proxy allowlist.
6. Implement verified Knox direct ingress and dedicated room-agent bindings.
7. Add restart reconciliation for records left in `PROVISIONING`.
8. Add SAML without changing the downstream identity or provisioning contract.

Each slice requires focused tests for duplicate login, cross-agent denial,
revoked sessions, forged Knox identifiers, binding changes, and recovery after
partial provisioning failure.

## Phase 1 exit criteria

Phase 1 is complete only when:

- two simultaneous first logins create one user and one agent;
- a second user cannot read, write, invoke, or subscribe to the first user's
  agent or sessions;
- a revoked browser session cannot reconnect;
- an authenticated Knox DM reaches the same personal agent and `main` session
  as PlatformClaw Web;
- a forged Knox room, sender, or agent field cannot select an agent;
- one approved Knox room binding reaches only its dedicated local-workspace
  agent and distinct room session;
- a Knox room agent cannot resolve a VM profile or employee credential;
- Gateway operator credentials never reach browser storage or browser frames;
- restart reconciliation resolves or reports every incomplete provisioning
  record;
- no enterprise authentication or Knox ownership logic is added to OpenClaw
  core.
