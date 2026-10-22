---
summary: "Contract between the CDEP Knox relay and the PlatformClaw Knox channel plugin"
read_when:
  - Implementing or changing the PlatformClaw Knox channel
  - Changing CDEP Knox Proxy authentication, payloads, retries, or delivery
  - Debugging Knox direct, group, progress, or outbound behavior
title: "Knox Proxy integration contract"
---

# Knox Proxy integration contract

PlatformClaw connects to Samsung Knox Teams through the CDEP Knox Proxy. CDEP
owns Knox-facing transport and cryptography. The private `knox` channel plugin
owns PlatformClaw ingress, routing, and reply delivery. No Knox-specific branch
belongs in OpenClaw core.

This page is the shared contract for both repositories. Update it whenever
CDEP changes the request shape, authentication, identity facts, retry behavior,
message format, or deployment boundary.

## Architecture

The legacy deployment used a standalone adapter:

```text
Knox Server <-> CDEP Knox Proxy <-> Knox Adapter <-> PlatformClaw
```

The target deployment terminates the relay contract in the channel plugin:

```text
Knox Server <-> CDEP Knox Proxy <-> PlatformClaw extensions/knox
```

The plugin replaces the adapter's HTTP receiver, manual Gateway client, session
queue, and outbound bridge. It does not copy manual agent or session-key
construction. OpenClaw channel routing and PlatformClaw bindings remain
authoritative.

## Ownership

| Surface                                                     | Owner                      |
| ----------------------------------------------------------- | -------------------------- |
| Knox webhook registration and receipt                       | CDEP                       |
| Knox device registration and encryption-key retrieval       | CDEP                       |
| Knox payload encryption, decryption, and upstream API calls | CDEP                       |
| Knox commands, notice retrieval, opt-out, and opt-in        | CDEP                       |
| CDEP request authentication and schema validation           | `extensions/knox`          |
| Durable PlatformClaw ingress and replay handling            | `extensions/knox`          |
| DM identity and personal-agent binding                      | PlatformClaw control plane |
| Group-room provisioning and binding                         | PlatformClaw control plane |
| Session routing and reply lifecycle                         | OpenClaw channel runtime   |
| Knox reply formatting, chunking, and upstream delivery      | CDEP                       |

## Supported scope

The first release supports text only.

| Knox surface                  | PlatformClaw behavior                                  |
| ----------------------------- | ------------------------------------------------------ |
| `SINGLE`                      | Existing personal agent's `main` session               |
| `GROUP`, version 1            | Idempotently provision or reuse `group-<chatroomId>`   |
| `GROUP`, version 2            | Authorized personal Space session; disabled by default |
| Files and images              | Unsupported                                            |
| Threads and replies           | Unsupported                                            |
| Edits, deletes, and reactions | Unsupported                                            |

An unregistered Knox participant may invoke a version 1 `GROUP` room agent. This does not
grant personal-agent access, employee context, VM credentials, or a personal
execution target. The authenticated room ID remains routing authority, and the
room agent remains inside the server Docker policy.

A `SINGLE` sender must have completed PlatformClaw Web login and already have
an active personal binding. CDEP sends its existing login guidance and does not
forward the DM when that prerequisite is missing.

Knox `BROADCAST` is a CDEP-to-Knox feature and is outside this integration
contract. CDEP does not send it to the plugin.

## Implementation readiness

The version 1 design is complete enough to implement. No additional inbound
body field or product-routing decision is open. The accepted assumptions are:

- raw `knoxUserId` identifies the same account as the canonical Web-login
  `accountId` after lookup normalization;
- `conversationId` is the stable Knox `chatroomId` for both DM and group;
- CDEP continues to own login guidance, Knox commands, and Knox-only broadcast;
- version 1 is text-only;
- every accepted turn injects the raw `knoxUserId` as
  `SENDER_ID` into external subprocess environments;
- legacy production remains active while the new schema is developed and
  tested, then CDEP switches to the plugin in a coordinated cutover rather than
  fan-out delivery.

Implementation may begin against this contract. Production cutover still
requires live proof of one activated DM identity, one group-room round trip,
both authentication directions, restart-safe deduplication, and isolated
request-scoped sender environment injection.

## Inbound contract

CDEP sends normalized JSON to the HTTP route registered by `extensions/knox`.
The route is plugin-owned and fixed at
`/api/v1/platformclaw/knox/inbound`. Every request uses these HTTP fields:

| HTTP field                 | Required | Contract                                    |
| -------------------------- | -------- | ------------------------------------------- |
| Method                     | Yes      | `POST`                                      |
| `Content-Type`             | Yes      | `application/json`                          |
| `x-platformclaw-timestamp` | Yes      | Unix epoch milliseconds as a decimal string |
| `x-platformclaw-signature` | Yes      | `sha256=<lowercase hexadecimal HMAC>`       |

Target version 1 envelope:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_123",
  "messageId": "msg_123",
  "occurredAt": "2026-07-30T12:00:00.000Z",
  "sender": {
    "knoxUserId": "user.name",
    "displayName": "Example User"
  },
  "conversation": {
    "type": "dm",
    "providerType": "SINGLE",
    "conversationId": "99343295704997888",
    "displayName": null
  },
  "message": {
    "type": "text",
    "text": "Hello"
  }
}
```

| JSON field                    | Required | Contract                                                               |
| ----------------------------- | -------- | ---------------------------------------------------------------------- |
| `schemaVersion`               | Yes      | Integer contract version; version 1 requires the shape shown here      |
| `eventId`                     | Yes      | CDEP-generated ID for tracing one inbound processing event             |
| `messageId`                   | Yes      | Stable original Knox message ID and inbound deduplication key          |
| `occurredAt`                  | Yes      | Original message time as an ISO 8601 UTC timestamp                     |
| `sender.knoxUserId`           | Yes      | Original opaque Knox user ID, preserved byte-for-byte                  |
| `sender.displayName`          | Yes      | Presentation metadata; never identity or routing authority             |
| `conversation.type`           | Yes      | Normalized type: `dm` or `room`                                        |
| `conversation.providerType`   | Yes      | Original Knox type: `SINGLE` or `GROUP`                                |
| `conversation.conversationId` | Yes      | Stable string form of Knox `chatroomId`, for both DM and group rooms   |
| `conversation.displayName`    | No       | Room display name when Knox provides one; otherwise omit or use `null` |
| `message.type`                | Yes      | `text` in version 1                                                    |
| `message.text`                | Yes      | Non-empty normalized user text                                         |

Rules:

- `eventId`, `messageId`, `knoxUserId`, and `conversationId` are required
  strings. Knox identifiers can exceed JavaScript's safe-integer range and must
  never cross this boundary as JSON numbers.
- The Knox webhook `sender` value is not a separate identity from
  `knoxUserId`. CDEP sends only `knoxUserId` in the version 1 identity contract.
- CDEP copies the original Knox `knoxUserId` byte-for-byte into the normalized
  envelope. It does not replace `.` with `_`, escape path characters, derive an
  agent ID from it, or attempt any reverse transformation.
- The plugin treats `knoxUserId` as opaque channel identity. It never applies
  `_` to `.` recovery heuristics. Filesystem-safe agent IDs are derived only at
  the room-binding boundary and never overwrite the original sender identity.
- `displayName` is presentation metadata only.
- `conversation.type` is `dm` or `room`; `providerType` preserves the source
  value without making PlatformClaw infer it.
- CDEP does not supply `agentId`, `sessionKey`, or session mode. PlatformClaw
  derives them from identity and room bindings.
- Empty `message.text` is rejected. Non-text events are not converted into
  synthetic text.

### Migration compatibility

The production CDEP currently serves the legacy adapter, so the plugin migration
does not require an immediate destructive payload change. Cut over in this
order:

1. Build and deploy the Knox plugin with both legacy and version 1 inbound
   parsers while production CDEP continues to target the legacy adapter.
2. Develop and test CDEP's version 1 superset through a development route or a
   disabled production rollout path. Retain every legacy field; this phase does
   not require both consumers to receive the same request.
3. At cutover, point CDEP at the plugin and enable the version 1 superset,
   including the byte-for-byte `knoxUserId`, as one coordinated change.
4. After migration telemetry confirms version 1 delivery, remove legacy fields
   from CDEP.
5. Remove the plugin's legacy parser in a later bounded cleanup after production
   confirms no legacy payloads remain.

While the legacy adapter remains the production target, CDEP keeps its existing
legacy sender representation on that route. Raw `knoxUserId` test traffic goes
only to the development plugin route. No production fan-out contract is
required.

During step 3, CDEP sends this superset. This is the complete reference request
for a registered group sender; optional legacy fields whose value is `null`
remain omitted because the legacy adapter serializes with `exclude_none=True`:

```http
POST <KNOX_PLUGIN_INBOUND_URL> HTTP/1.1
Content-Type: application/json
x-platformclaw-timestamp: 1785488400123
x-platformclaw-signature: sha256=<lowercase-hex-hmac>
```

```json
{
  "schemaVersion": 1,
  "eventId": "evt_123",
  "messageId": "1234567890",
  "occurredAt": "2026-07-31T12:00:00.123Z",
  "sender": {
    "knoxUserId": "user.name",
    "employeeId": "user.name",
    "employeeEmail": "user.name@example.invalid",
    "displayName": "Example User",
    "department": "Example Department"
  },
  "conversation": {
    "type": "room",
    "providerType": "GROUP",
    "conversationId": "99343295704997888",
    "displayName": "Example Room",
    "threadId": null
  },
  "message": {
    "type": "text",
    "text": "Hello"
  },
  "text": "Hello",
  "preferredSessionMode": "shared_main",
  "agentId": "group-99343295704997888",
  "clientInfo": {
    "id": "knox-adapter",
    "mode": "backend"
  },
  "senderId": "user.name"
}
```

Migration rules:

- Version 1 fields are `schemaVersion`, `conversation.providerType`,
  `conversation.displayName`, and `message`.
- Legacy fields are `sender.employeeId`, `sender.employeeEmail`,
  `sender.department`, top-level `text`, `preferredSessionMode`, `agentId`,
  `sessionKey`, `clientInfo`, and top-level `senderId`.
- The plugin accepts but ignores legacy routing and policy fields. It never
  trusts caller-supplied `agentId`, `sessionKey`, `preferredSessionMode`,
  `clientInfo`, or top-level `senderId`.
- When both shapes are present, `message.text` is authoritative. Legacy
  duplicates are ignored even when they differ; this permits the old group-text
  wrapper to coexist during migration.
- A legacy-only request maps top-level `text` to `message.text` at the HTTP
  boundary. No other runtime compatibility branch is permitted.
- A legacy-only `knoxUserId` may still contain CDEP's lossy `.` to `_`
  rewriting. The plugin treats it as opaque and never guesses the original.
  CDEP starts sending the byte-for-byte Knox value when it adds version 1
  fields.
- CDEP signs the exact serialized superset body. It must not sign one JSON
  representation and send another.

### Direct messages

For `dm`, the plugin resolves the enterprise identity through the control
plane:

```text
knoxUserId -> Web-login account identity -> personal binding
           -> agent:<personalAgentId>:main
```

`employeeNumber` is not part of this lookup. The current Web login contract's
legacy `employeeId` field contains an account-style login ID such as
`user.name`, not a numeric employee number. The plugin resolves the canonical
Web-login `PlatformUser.accountId` from the raw `knoxUserId`, then reads that
user's active personal binding. It never derives the personal agent ID directly
from the Knox value.

The accepted identity invariant is that `knoxUserId` and the canonical Web-login
account ID identify the same account. Before production cutover, prove this with
at least one activated real account. If that proof fails, PlatformClaw needs an
explicit persisted Knox-to-user alias created by an authenticated identity flow;
underscore reversal or another runtime guess is forbidden.

Missing, disabled, or unbound users fail closed. CDEP owns the Web-login
guidance before it calls the plugin.

### Group messages

For version 1 `room`, the plugin ignores caller-supplied agent or session values:

```text
accountId + conversationId -> room binding -> group-<chatroomId>
```

The first message provisions the room agent idempotently. Concurrent first
messages converge on one binding. An unregistered sender receives no
employee-derived context or credentials.

### Requester sender identity

The plugin sets the trusted request-scoped sender identity for every inbound
turn to the original `knoxUserId`. Registration state does not change this
value. Display names and legacy employee fields are never sender authority.

PlatformClaw propagates that trusted value to external subprocess-based skills
as `SENDER_ID`. This variable is runtime context, not deployment
configuration:

- remove any inherited case variant of `SENDER_ID` before injection;
- inject the exact request-scoped `knoxUserId` after host or sandbox environment
  assembly for the current turn;
- never accept it from an LLM tool argument or static skill environment;
- keep internal TypeScript tools on the request-scoped `requesterSenderId`
  field, also set to `knoxUserId`, instead of reading `process.env`.

Each ordinary room message receives its own sender value even though all participants
share the room agent and conversation. This does not grant an unregistered
participant an employee profile, personal binding, credential, or VM target.

## Personal Space requests with version 2

Version 2 runs the sender's personal Agent in a connected Space page and returns
its final answer to the original Knox group. PlatformClaw implements this backend
with `selfInSpaceEnabled` defaulting to `false`. CDEP parsing and live Knox
delivery remain separate integration work. Production enablement requires both
implementations and CDEP durable outbound idempotency.

The room Agent is not invoked. Questions and answers are not automatically copied
into Main, Shared Q&A posts, or Shared Notes. Their registered personal conversation
still contributes questions and final answers to authorized Space shared recall.

### Input and command ownership

Use the existing public inbound endpoint and authentication. Only this version 2
combination is accepted:

```json
{
  "schemaVersion": 2,
  "executionMode": "self_in_space",
  "eventId": "evt_example",
  "messageId": "msg_example",
  "occurredAt": "2026-10-22T01:00:00.000Z",
  "sender": { "knoxUserId": "user.name", "displayName": "Example User" },
  "conversation": {
    "type": "room",
    "providerType": "GROUP",
    "conversationId": "99343295704997888"
  },
  "message": { "type": "text", "text": "Inspect the code in my work location." }
}
```

Ordinary groups and DMs keep version 1. Version 2 with a missing or unsupported
mode or a DM combination is rejected. Version 1 containing `executionMode` is also
rejected. Never downgrade a rejected version 2 request to ordinary group execution.
Version 2 `messageId` is limited to 256 UTF-16 code units, matching the private
admission request identity limit. Oversized IDs receive `400` before admission.

CDEP must recognize `/my` only in the actual author's command position in an
explicitly mentioned group message, remove it, and preserve the remaining question
including code and newlines. Quotes, code blocks, URLs, and `/myfoo` are not
commands. Empty questions and DM use need CDEP guidance without an Agent call.
These are CDEP requirements, not claims about its current implementation.

PlatformClaw treats the entire version 2 body as question data. It does not extract
slash commands or match pending-question choices. A body ending in `/compact`,
`/stop`, or `/approve` cannot execute that command. `/my` personal control commands
are unsupported; use the owner's web controls. Version 1 commands are unchanged.
Keep exact-body HMAC, freshness, string IDs, and the original raw Knox identity.
CDEP supplies no internal user, Space, Agent, session, VM, or Credential authority.
Internal `PlatformUser.id` supplies verified Q&A attribution; the separate raw
`knoxUserId` remains request-scoped `SENDER_ID`.

### Enablement and acknowledgement

Set `channels.knox.selfInSpaceEnabled`, or its account override at
`channels.knox.accounts.<accountId>.selfInSpaceEnabled`. Omission and `false` both
disable new v2 admission. Turning it off keeps accepted requests in their own
queue and allows recovery while the Knox account continues running.

| Public inbound result                                              |  HTTP | Meaning                                          |
| ------------------------------------------------------------------ | ----: | ------------------------------------------------ |
| Authenticated v2 while disabled                                    | `409` | `self_in_space_disabled`, `retryable: false`     |
| Account/message ID reused with changed normalized identity or mode | `409` | `message_identity_conflict`, `retryable: false`  |
| Invalid payload, version, or mode                                  | `400` | `invalid_payload`; no admission                  |
| Invalid HMAC or freshness                                          | `401` | `invalid_signature`; no admission                |
| Admission infrastructure unavailable                               | `503` | `admission_unavailable`; retry the same identity |
| New durable admission                                              | `202` | Accepted for processing, not execution success   |
| Existing durable admission                                         | `200` | Duplicate confirmation, not execution success    |

An unconnected Space, Viewer, disabled room, or revoked request can be accepted
durably and then end with a generic terminal reply. Its delivery uses the
authenticated original group destination without exposing hidden Space content,
internal paths, or credentials, even when personal execution is denied.

### Manage room connections

Room provisioning and Space connection are separate. Use an existing active Knox
room, Space page, and manually authorized employees. Management uses
`GET /platformclaw/api/admin/knox-space-bindings` and POST on the same path.
Both require an active administrator's `platformclaw_session` cookie; POST also
requires the configured same-origin check. Connecting additionally requires that
the administrator is an Owner of the selected Space and the page belongs to it.
There is no dedicated connection manager UI.

GET returns `bindings` and a bounded `admissions` snapshot with durable states and
`cancellationPending`. For an initial connection, POST:

```json
{
  "action": "connect",
  "accountId": "default",
  "roomId": "99343295704997888",
  "spaceId": "<space-id>",
  "pageId": "<page-id>",
  "expectedGeneration": 0
}
```

Change the Space or page with `connect` and the current `expectedGeneration`.
Disconnect with `disconnect`, `accountId`, `roomId`, and `expectedGeneration`.
Every change advances the generation and permanently revokes the old pending
requests. Stale generations return `409`; read again before retrying. Missing
authentication returns `401`, missing authority or rejected origin `403`, invalid
input `400`, and infrastructure failure `503`.

The connection commits before cancellation. If cancellation fails, inspect the
snapshot and POST `{"action":"retry-cancellation"}`. Cancellation targets exact
`knox-my:<admissionId>` runs, preserving a later independent web turn in the same
session.

### Pin authority and sessions before execution

The existing private `/platformclaw/internal/knox/route` supports three operations:

- `reserve` registers the verified user, binding ID/generation, Space/page,
  personal conversation, and execution-target identity before queue admission.
  Registration needs no live Gateway.
- `validate` checks that same admission. Default `phase: "execute"` also provisions
  its native session. `phase: "publish"` validates disclosure without provisioning.
- `settle` retains a terminal receipt after delivery processing.

Calls include `executionMode`, original message ID as `requestId`, and the
lowercase SHA-256 `requestFingerprint` of the normalized envelope. Validation and
settlement also require `admissionId`; settlement uses `outcome: "finished"` or
`"failed"`. A resolved response has `agentId`, `sessionKey`, `executionTarget`, and
`selfInSpace`: admission/request/user/Space/page/binding/conversation IDs, numeric
`bindingGeneration` and `targetRevision`, and verified `senderAttribution`.
This service is not a CDEP-accessible session-creation API.

Shared JSON fixtures live in `extensions/knox/test-fixtures/my/`. Authentication,
schema, outbound retry, delivery-recovery, and rollback tests read them directly.
`resolved-route.json` is a private control-plane/durable-state fixture, never a
CDEP-supplied routing authority.

Internal product failures use HTTP `200`, `ok: true`, an `admissionId`, and one of:
`agent-unavailable`, `login-required`, `permission-denied`, `request-conflict`,
`request-revoked`, `request-settled`, `room-disabled`, `space-unavailable`, or
`target-changed`. They grant no execution authority. Internal authentication,
input, and infrastructure errors remain `401`, `400`, and `503`. Version 1 keeps
its existing behavior, including transient `agent-unavailable` HTTP `503`.

One conversation per binding generation and employee is registered through the
existing Space registry. Concurrent creation and restart converge; existing
private sessions are never adopted. The 200-conversation limit per Space still
applies. Unavailable targets never fall back to personal main or room sessions.

New control-plane tables are additive in its existing SQLite database without a
schema version bump. The plugin retains the real account ID and selects
`queueNamespace: "self-in-space-v2"`, payload version 2, and the pinned session as
its execution lane. Its queue key is `["knox", accountId, "self-in-space-v2"]`;
ordinary consumers retain `["knox", accountId]`. These identities cannot collide
even when another account ID contains the namespace text. Ordinary room requests
and other employees do not share that execution lane.
Gateway ordering still serializes work on the same actual session.

Member removal/downgrade, disabled user/Agent/room, Space deletion, connection
changes, and personal target changes permanently revoke affected pending admissions. Re-granting access cannot
revive them. Another member's unrelated role change does not revoke everyone.
Native tool checks and final publication recheck authority. The personal target
identity remains pinned; a VM failure cannot select the server instead. Before
backend creation, the private execution-target endpoint checks the original
admission, session, and Agent, then checks the exact returned target snapshot.
Space tool and approval checks also compare the allocation and Credential revision;
switching away and back cannot release an older admission.
Approval resumption also rechecks the original admission after the wait. Restored
membership alone cannot release a tool parked under a revoked request.
For a Knox personal admission, the host forces `exec.required: true` so an approval
wait and its completion remain in that owner turn. A model-supplied `false` cannot
detach execution into a separate later reply. Ordinary web and v1 runs keep their
existing execution policy.

Until detached work can inherit the original admission, pinned target, and result
ledger, `/my` rejects `sessions_spawn`, `sessions_send`, `conversations_send`,
`conversations_turn`, the independent `openclaw` operator delegate, automation
creation/change/run/wake, and image, music, or video generation. Direct `message`
writes are also rejected so public output
cannot bypass final publication checks. Read/status/history actions, automation
removal, and `subagents` list/cancel remain available; independent owner web and
v1 turns keep their existing behavior. This policy uses the host-resolved original
admission identity, including derived runs; tool arguments cannot enable or
disable it. Continue unsupported detached work from the owner's independent web
session.

### Shared recall and private inputs

`/my` is not private chat: its final answer is visible in the Knox group and its
questions/final answers follow [Space shared recall](/platformclaw/spaces#session-ownership-and-shared-context).
An owner-only Space tab still shares ordinary question and answer text.
Use existing structured Credential and approval paths for secrets; never ask for
passwords or tokens in ordinary Space chat. Structured question responses must be
assessed by their actual storage path, not all treated as ordinary user messages.

Only generic waiting notices and the final public answer reach the group. Tool
payloads, reasoning, approvals, and private attachments do not. PlatformClaw adds
`[개인 Agent]` once at the final outbound boundary; CDEP must not add another label.
The label never enters the transcript or prompt. A resumed web approval continues
the original request, while an independent web question, DM, or scheduled turn
does not inherit its group reply route. Natural-language answers cannot be
perfectly scrubbed for every private fact.

### Recover result delivery

PlatformClaw commits each final fragment before acknowledging it internally, then
combines the fragments after the originating turn settles. Recovery
resends the saved result with `my-final:<messageId>` instead of executing VM work
again. Native correlation is `knox-my:<admissionId>`. Rejection, revocation, and
unknown-execution notices have separate stable request IDs. Unknown execution
after a crash does not cause automatic execution replay.

The `my-requests-v2` blob namespace uses shared host SQLite with 1 MiB per item,
64 MiB per namespace, 1,000 entries, and `reject-new` overflow. Fully delivered,
settled results expire after 30 days and may be compacted earlier near capacity.
Compaction preserves active, partial, and unknown work. If protected work alone
fills the quota, new admission fails before ACK and requires operator settlement.
The cross-mode `inbound-identities` fingerprint cache allows 40,000 entries with
60-day expiry and oldest-entry eviction. Both native queue owners are checked
for conflicting modes independently of this cache, including pre-upgrade v1 rows.
These bounded replay windows are not an unlimited exactly-once guarantee.
Capacity failure does not authorize deleting unresolved work.

For v2, legacy `chatMsgId` is the lowercase hexadecimal SHA256 of UTF-8
`JSON.stringify([accountId, requestId])`. It is stable across delivery retries;
v1 retains its existing random UUID. The authoritative delivery idempotency key
is still `requestId` scoped to the authenticated account. Proxy must not turn a
changed payload for that key into a second send.

A valid CDEP failure envelope's explicit `retryable` boolean takes precedence over
HTTP fallback. Thus `502` with `ok: false`, nonempty `errorCode`, and
`retryable: false` is terminal. Without that envelope, `429` and `5xx` are
retryable. `KNOX_PARTIAL_DELIVERY` and `KNOX_DELIVERY_UNKNOWN` distinguish partial
and unknown outcomes. Terminal partial/unknown delivery is retained for operator
investigation without automatic whole-message resend. Retryable transport errors
reuse the saved body and request ID.

CDEP must durably track request IDs and per-chunk outcomes across restarts and
replicas. It must resume or report partial/unknown state without blindly restarting
chunk one. Mock CDEP tests establish PlatformClaw behavior; they do not prove those
guarantees in the live company Proxy.

### Enable and roll back safely

Prepare the v2 receiver and approved room connections, validate with mock CDEP,
then cross-check both real builds before enabling CDEP `/my` and the plugin flag.
Automatic membership synchronization and Main room-Agent Space search authority
remain separate dependencies. Existing members' personal Agents can use Space
search; this does not grant the Main Agent that capability.

Rollback order:

1. Stop CDEP producing `/my`; turn off new plugin admission.
2. Keep the new consumer running to settle accepted execution, stored results,
   failure notices, and cancellations.
3. Inspect CP admission states and `cancellationPending` alongside plugin delivery
   state. Preserve unresolved v2 queue/blob records for a compatible recovery
   consumer; do not pass them to the v1 queue owner.
4. Downgrade after isolating unresolved work and recording its recovery owner.
   There is no automatic conversion or quarantine-management UI.

Old consumers open the ordinary account queue, so they cannot reinterpret v2
records as room work. They also cannot complete those records. Do not delete
pending state to make a rollback appear complete.

## CDEP request authentication

CDEP authenticates each inbound call with:

```text
x-platformclaw-timestamp: <Unix epoch milliseconds>
x-platformclaw-signature: sha256=<lowercase hex HMAC>
```

Canonical input:

```text
<timestamp>.<exact UTF-8 request body>
```

The algorithm is HMAC-SHA256. CDEP serializes the JSON body once, signs those
exact UTF-8 bytes, and sends the same bytes without reformatting. The plugin
verifies the untouched request bytes with a timing-safe comparison before
parsing JSON and rejects timestamps outside a five-minute window. HTTP header
names are case-insensitive. Missing secret, timestamp, or signature fails
closed.

This differs from Knox-to-CDEP webhook authentication. CDEP must not reuse the
Knox canonical string on this hop.

## Inbound acknowledgement and replay

The plugin durably accepts an event before acknowledging CDEP:

| Result                                      |  HTTP | Meaning                               |
| ------------------------------------------- | ----: | ------------------------------------- |
| New event durably accepted                  | `202` | CDEP may acknowledge Knox             |
| Event already accepted                      | `200` | Duplicate is complete or queued       |
| Invalid or unsupported payload              | `400` | Permanent caller error                |
| Missing or invalid authentication           | `401` | Security configuration error          |
| Disabled personal mode or changed identity  | `409` | Permanent rejection; no new admission |
| Temporary failure before durable acceptance | `503` | Allow Knox retry                      |

CDEP must not mark an inbound message complete before `202` or `200`. The
observed legacy order marked it before calling the adapter and could lose a
message if CDEP crashed between those operations.

PlatformClaw owns per-conversation execution ordering after acceptance. CDEP
does not construct an agent session queue.

## Outbound contract

The plugin sends replies to CDEP's versioned outbound endpoint. CDEP requires a
service credential; an internal HTTP network is not an authentication
boundary.

Target request headers:

```http
Content-Type: application/json
Authorization: Bearer <PLATFORMCLAW_SERVICE_TOKEN>
```

CDEP applies its existing `verify_platformclaw_auth` dependency to the outbound
route and compares the configured token without logging it. Missing or invalid
credentials return HTTP `401`:

```json
{
  "ok": false,
  "errorCode": "UNAUTHORIZED",
  "message": "Invalid service token",
  "retryable": false
}
```

Recommended request:

```json
{
  "requestId": "delivery_123",
  "runId": "run_123",
  "messageId": "msg_123",
  "chatroomId": "room_123",
  "conversationType": "room",
  "status": "final",
  "text": "Completed."
}
```

| Field              | Required | Contract                                          |
| ------------------ | -------- | ------------------------------------------------- |
| `requestId`        | Yes      | Stable idempotency key for this visible message   |
| `runId`            | Yes      | PlatformClaw run correlation ID                   |
| `messageId`        | No       | Original inbound correlation ID                   |
| `chatroomId`       | Yes      | String Knox target; never use a JavaScript number |
| `conversationType` | Yes      | `dm` or `room`; never infer from `agentId`        |
| `status`           | Yes      | `progress`, `final`, `error`, or `timeout`        |
| `text`             | Yes      | Non-empty user-visible text                       |

During the CDEP migration, the plugin also sends the existing required fields:
`conversationId`, `threadId: null`, `agentId`, `sessionKey`, `chatMsgId`,
`msgType: "text"`, `final`, `errorCode`, `errorMessage`, and
`senderDisplayName`. CDEP may remove those requirements later; routing does not
depend on them. The target fields above remain authoritative.

Success response:

```json
{
  "ok": true,
  "provider": "knox",
  "messageId": "cdep_delivery_123",
  "conversationId": "room_123",
  "acceptedAt": "2026-07-30T12:00:01.000Z"
}
```

Failure returns `ok: false`, a stable error code, `retryable`, and
`retryAfterSeconds` when known. CDEP must not report a skipped send as success.

## Progress and terminal messages

Knox cannot edit a temporary draft in place like some other channels. Every
progress update is a new visible message.

PlatformClaw uses this bounded policy:

1. Start a ten-second delay after the turn adopts its request. An explicit
   `channels.knox.progressDelayMs` still overrides this first delay.
2. Suppress progress if the final response arrives before the delay.
3. Otherwise send `Processing your request.` or the current approval wait when
   approval is already pending. Use Korean notices when the raw request contains
   any Hangul character, including Jamo; use English otherwise.
4. On subsequent ten-second ticks, send a new notice only when the displayed
   tool name or observed state changes. Pending approval takes priority over
   running calls. A completed call does not imply its background work finished;
   ending an approval wait does not imply approval was granted.
5. Do not forward token chunks, tool arguments, command output, model reasoning,
   or compaction events. State comes from request-correlated runtime events.
6. Stop timers, unsubscribe observers, and abort pending notice delivery on
   completion or cancellation. Send the final response separately. A relay
   message already accepted before cancellation cannot be recalled.

CDEP adds `progress` to its outbound schema and sends its text as a normal Knox
message. It also sends user-safe `error` and `timeout` text instead of silently
returning success without delivery.

For DM replies only, PlatformClaw prepends the selected execution target at the
final outbound boundary:

- `🟢 VM 사용 중` / `🟢 Using VM` for an assigned personal VM;
- `🟠 PlatformClaw 서버 사용 중` / `🟠 Using PlatformClaw server` for the server.

The indicator uses the same raw-request language rule as progress notices.

A blank line separates the indicator from the reply. The indicator applies to
`progress`, `final`, `error`, and `timeout` delivery, but not room messages or
proactive sends. It is presentation-only: the prefix is never added to the
inbound user message, agent context, generated answer, or session transcript.

## Text rendering and limits

CDEP owns Knox-compatible RTF rendering and chunking. The observed operational
limit is 3,000 Python characters per chunk and at most 50 chunks. Before
production use, CDEP must:

- escape `&`, `<`, and `>` in every plain-text and display-name path;
- enforce limits after rendering or split only at markup-safe boundaries;
- stop and return a partial-delivery error when a chunk fails;
- preserve Unicode and newlines;
- avoid treating a visual `@name` prefix as a native mention;
- return its delivery ID when Knox does not return a provider message ID.

## CDEP-owned commands

CDEP owns `/공지`, `/수신거절`, and `/수신허용`. Command messages terminate in
CDEP and are not forwarded to the plugin.

The observed `/공지` path retrieves the latest stored notice for the requesting
user; it is not a PlatformClaw agent command. Notice storage, eligible-recipient
lookup, and opt-out persistence remain CDEP concerns.

## PlatformClaw commands

CDEP forwards version 1 PlatformClaw commands as ordinary authenticated text. The plugin
examines only the final non-empty line after normalized ingress. It accepts a
standalone command such as `/compact` and a transport-added mention prefix such
as `@PlatformClaw /compact`; the mention token is structural and need not match
a hard-coded display name. Prose that merely contains `/...` elsewhere remains
normal agent input.

The extracted line enters the existing OpenClaw command registry, so core,
plugin, and skill commands keep their normal authorization and availability
rules. Knox does not maintain a duplicate command list. `/stop` uses a dedicated
control lane so it can interrupt an active room or DM run instead of waiting
behind that run. See [Slash commands](/tools/slash-commands) and
[Skill Hub integration](/platformclaw/skill-hub#knox-commands).

## Deployment configuration and secrets

Production currently injects these settings through deployment-controlled
environment configuration outside source and container images:

| Variable                                | Class         | Purpose                                                  |
| --------------------------------------- | ------------- | -------------------------------------------------------- |
| `KNOX_ENCRYPTION_KEY`                   | Secret        | Knox message payload cryptography                        |
| `KNOX_AUTHORIZATION_HEADER`             | Secret        | Knox upstream authorization                              |
| `KNOX_API_BASE_URL`                     | Configuration | Knox upstream service base URL                           |
| `KNOX_SYSTEM_ID`                        | Configuration | Knox service identity metadata                           |
| `KNOX_DEVICE_TYPE`                      | Configuration | Knox device registration metadata                        |
| `PLATFORMCLAW_KNOX_CDEP_URL`            | Configuration | Versioned CDEP outbound endpoint                         |
| `PLATFORMCLAW_KNOX_WEBHOOK_SECRET_FILE` | Secret file   | Verifies CDEP inbound HMAC                               |
| `PLATFORMCLAW_KNOX_SERVICE_TOKEN_FILE`  | Secret file   | Authenticates plugin-to-CDEP and plugin-to-control calls |

Never record their values or production injection paths in this repository.
Readiness fails when a required value or initialized crypto dependency is
unavailable.

`platformclaw-deploy init` creates the deployment layout and records the Knox
secret-file paths. The first `platformclaw-deploy up` generates a complete secret
set for a new installation. An image update requires all foundational deployment
secrets to exist and may generate only missing `knox-webhook-secret` and
`knox-service-token` files before Compose stops services. The operator copies
their values into CDEP's deployment
secret store and sets `PLATFORMCLAW_KNOX_CDEP_URL` in `deployment.env`; secret
values never belong in `openclaw.json`.

CDEP sends inbound requests to
`<PLATFORMCLAW_PUBLIC_ORIGIN>/api/v1/platformclaw/knox/inbound`. The public BFF
preserves the signed bytes while relaying only this route to the private
Gateway. The Gateway itself remains unexposed.

## Security and durability requirements

Production cutover requires:

- verify Knox-to-CDEP webhook authentication when Knox supplies signature
  headers; payload encryption alone is not request authentication;
- require CDEP-to-PlatformClaw HMAC and freshness checks;
- require authentication on PlatformClaw-to-CDEP outbound requests;
- store outbound idempotency durably across CDEP restart and replica changes;
- avoid process-local dedupe as the only replay protection;
- keep secrets outside images, source, logs, and this document;
- use deployment-owned service discovery instead of an image-baked private IP.

## Health contract

CDEP exposes versioned health and readiness routes. Container healthchecks call
the exact registered route, including router prefix. Readiness fails when Knox
cryptography, outbound credentials, or PlatformClaw relay configuration is
unusable. A listening HTTP server without usable encryption is not ready.

## Known legacy gaps

The 2026-07-30 source audit found these legacy behaviors. They are repair work,
not target behavior:

- standalone adapter with manual Gateway WebSocket and Responses API calls;
- CDEP-supplied agent IDs and adapter-local session policy;
- lossy `.` to `_` sender-ID rewriting followed by heuristic `_` to `.`
  recovery in the adapter;
- no explicit, verified DM mapping from raw `knoxUserId` to the Web-login
  account identity;
- inbound dedupe marked before adapter acceptance;
- process-local inbound and outbound dedupe;
- unauthenticated CDEP outbound endpoint;
- no outbound `progress` status;
- group formatting inferred from `agentId == "group-chat"`;
- error and timeout statuses skipped visible Knox delivery;
- incomplete RTF escaping, length enforcement, and partial-failure handling;
- container healthcheck missing the router prefix.

The audit did not include a CDEP commit SHA. Reconfirm these observations
against the exact revision before repair.

## Verification matrix

Before cutover, prove:

- large Knox IDs survive both directions byte-for-byte as strings;
- dotted and underscored `knoxUserId` values survive CDEP normalization without
  collision, escaping, or reverse-rewrite heuristics;
- valid, missing, invalid, and stale HMAC requests behave as specified;
- a DM uses the existing personal agent and `main` session;
- a DM without Web activation gets CDEP login guidance and never reaches the
  plugin;
- an unregistered group participant can invoke only the room agent;
- DM and room subprocess skills receive the exact request-scoped `knoxUserId`
  as `SENDER_ID`, with dots and underscores preserved and no value
  leaking between senders;
- concurrent first group messages create one room binding;
- CDEP commands never reach an agent;
- restart and duplicate inbound delivery cannot lose an accepted event;
- restart and duplicate outbound delivery cannot create two Knox messages;
- fast runs suppress progress; slow runs emit the first notice after ten seconds
  and only changed observed states on later ten-second ticks;
- approval waits override running state, concurrent calls remain independent,
  and completion/cancellation stops notices without cross-request leakage;
- final, error, timeout, rate-limit, and partial-chunk results remain visible;
- RTF respects size limits and escapes hostile display/text input;
- health and readiness probes call real routes and fail when dependencies are
  unusable;
- the full path works in the Linux Docker deployment.

## Maintenance checklist

Update this page in both implementation reviews whenever CDEP changes:

- webhook or outbound path;
- request or response field, type, enum, or limit;
- identity resolution or Web-activation policy;
- HMAC canonicalization, timestamp, header, or secret behavior;
- command ownership;
- acknowledgement, retry, ordering, or idempotency semantics;
- RTF, chunking, files, threads, or progress behavior;
- health, readiness, networking, or deployment configuration.

Also update [Control plane phase 1](/platformclaw/control-plane-phase-1) and
[Architecture decisions](/platformclaw/decisions) when routing, identity,
provisioning, or product policy changes.
