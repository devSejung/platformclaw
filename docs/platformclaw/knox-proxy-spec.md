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

| Knox surface                  | PlatformClaw behavior                                |
| ----------------------------- | ---------------------------------------------------- |
| `SINGLE`                      | Existing personal agent's `main` session             |
| `GROUP`                       | Idempotently provision or reuse `group-<chatroomId>` |
| Files and images              | Unsupported                                          |
| Threads and replies           | Unsupported                                          |
| Edits, deletes, and reactions | Unsupported                                          |

An unregistered Knox participant may invoke a `GROUP` room agent. This does not
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

For `room`, the plugin ignores caller-supplied agent or session values:

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

Each room message receives its own sender value even though all participants
share the room agent and conversation. This does not grant an unregistered
participant an employee profile, personal binding, credential, or VM target.

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

| Result                                      |  HTTP | Meaning                         |
| ------------------------------------------- | ----: | ------------------------------- |
| New event durably accepted                  | `202` | CDEP may acknowledge Knox       |
| Event already accepted                      | `200` | Duplicate is complete or queued |
| Invalid or unsupported payload              | `400` | Permanent caller error          |
| Missing or invalid authentication           | `401` | Security configuration error    |
| Temporary failure before durable acceptance | `503` | Allow Knox retry                |

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
Authorization: Bearer <PLATFORMCLAW_KNOX_SERVICE_TOKEN>
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
| `requestId`        | Yes      | Stable idempotency key together with `runId`      |
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
`retryAfterSeconds` when known. Explicit `retryable: false` overrides an HTTP
5xx response. CDEP must not report a skipped send as success.

### Cancellation and uncertain delivery

The versioned outbound API adds sibling `/cancel` and `/status` routes under
the same prefix as `/send`, using its existing service authentication. Legacy
authentication mode remains a proxy concern. The required cancellation request is:

```http
POST /api/v1/platformclaw/knox/outbound/cancel
```

```json
{
  "requestId": "cancel:progress:msg_123",
  "runId": "knox:msg_123",
  "targetRequestId": "progress:msg_123",
  "targetRunId": "knox:msg_123",
  "chatroomId": "99343295704997888",
  "conversationType": "room"
}
```

The target is the original send's composite `(requestId, runId)` key. A cancel
request has its own stable composite key. The proxy validates the target room,
persists cancellation before a late send can run, and recalls every delivered
chunk. A successful acknowledgement is `ok: true, state: "cancelled"`, with
an outcome of `recalled`, `suppressed`, or `already_cancelled`. `suppressed`
means transmission was definitely prevented; `already_cancelled` requires a
stored confirmed cancellation. Neither is inferred from a Knox not-found error.

The proxy returns a result or HTTP 202 within eight seconds; the client waits
at most ten seconds for each HTTP response. A 202 acknowledgement can omit
`messageId` and includes `state: "pending"` plus `retryAfterSeconds` when known.
Processing continues in the proxy. The client polls the persisted result using:

```http
GET /api/v1/platformclaw/knox/outbound/status?requestId=progress%3Amsg_123&runId=knox%3Amsg_123
```

The status response requires explicit `state`: `pending`, `sent`, `cancelled`,
or `failed`. A `sent` response requires the confirmed delivery `messageId`.
For cancel status, query the cancellation request's own composite key. HTTP 200
means the lookup succeeded; only the operation's state proves delivery or recall.
An existing send acknowledgement without `state` remains valid when it has
`ok: true` and a non-empty `messageId`. An ID-less duplicate acknowledgement
requires status lookup rather than a fabricated receipt.

Each operation has a bounded 30-second resolution window. After an ambiguous
POST acknowledgement, the client performs status lookups, never another POST.
Unresolved delivery/recall is a non-retryable `DELIVERY_UNKNOWN` or
`CANCEL_UNKNOWN`; an unknown final delivery leaves its previous notice visible.
An abort can interrupt polling, but cleanup uses the original send key and an
independent cancellation deadline. Status lookups must use the proxy's stored
facts and must not resend a native Knox message.

The proxy owns durable single-instance storage across restart, including each
chunk's native `msgId`, original `sentTime`, and `msgKey`. Native packet
`requestId` is generated by the proxy and is distinct from the logical string
idempotency keys above. Native cancellation uses the stored
`chatroomId + msgId + sentTime`; it never substitutes the cancellation time.
For delivery whose native acknowledgement was lost, the proxy may attempt
recall using its persisted timestamp immediately before the original send.
The measured tolerance is +/-10 seconds, and 11 seconds fails. A native
not-found reply still cannot prove whether that uncertain send happened.

Proxy success requires native `result.code = 1000`, not HTTP 200 alone. Native
4001 maps to `MESSAGE_NOT_FOUND` only when `msg` is exactly
`Not exist message.`; other 4001 responses map to `KNOX_API_ERROR`.
`MESSAGE_NOT_FOUND` is a failed recall, not a confirmed cancellation. The
observed recall window reaches 40 minutes; its upper bound is unconfirmed.
This integration is validated with a mock proxy, not a production Knox call.

## Progress and terminal messages

Knox cannot edit a temporary draft in place. Progress replacement sends a new
notice, waits for confirmed delivery, then recalls the previous temporary notice.

PlatformClaw uses this bounded policy:

1. Start a fifteen-second delay after the turn adopts its request. An explicit
   `channels.knox.progressDelayMs` still overrides this first delay.
2. Suppress progress if the final response arrives before the delay.
3. Send an English digest: up to five recently completed tool calls, oldest
   first, followed by current activity or approval state. No history heading,
   cumulative count, random wording, or additional model call is needed. Use
   `⏳ Processing request` only when neither history nor current status is
   available. A digest containing only completed history has no generic status
   line. The fallback stays English for Korean requests too.
4. Sample request-correlated runtime events every fifteen seconds. Send only
   when the rendered digest changes. Identical latest-five content makes no
   additional relay call, even when different call IDs produced it. More than
   five results between samples retains only the newest five.
5. Limit each complete item line to 50 Unicode graphemes, including symbol and
   tool name; shorten overflow with `…`. Prefer file basenames. Allow only
   redacted command, file, browser action, or URL hostname details. Never forward
   command output, arbitrary arguments, URL credentials/query, model reasoning,
   or compaction events. The digest body is bounded to leave room for the DM
   execution indicator within 400 characters.
6. Approval takes priority over running calls at the bottom. A tool result does
   not mean the request or its background work finished. Resolved approval does
   not imply approval was granted.
7. Stop timers and abort pending digest sends immediately on completion or
   cancellation. Recall temporary digests only after a confirmed final reply,
   or immediately on cancellation. Real question prompts, intermediate answer
   blocks, and final/error replies are never recalled as temporary progress.
   A failed recall is recorded; further replacements stop to avoid accumulation.

These cleanup guarantees apply to the adopted request's process lifetime.
Recovering temporary-notice keys after an abrupt Gateway crash needs a durable
PlatformClaw outbox follow-up; proxy persistence alone does not recover them.

Example digest:

```text
✓ exec · pnpm build
✓ read · config.ts
✗ exec · pnpm test
⏳ browser · open · example.com
```

CDEP adds `progress` to its outbound schema and sends its text as a normal Knox
message. It also sends user-safe `error` and `timeout` text instead of silently
returning success without delivery.

For DM replies only, PlatformClaw prepends the selected execution target at the
final outbound boundary:

- `🟢 VM 사용 중` / `🟢 Using VM` for an assigned personal VM;
- `🟠 PlatformClaw 서버 사용 중` / `🟠 Using PlatformClaw server` for the server.

The execution indicator retains its raw-request language rule: any Hangul
character, including Jamo, selects Korean; otherwise it uses English. The
temporary tool digest itself always uses English.

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

CDEP forwards PlatformClaw commands as ordinary authenticated text. The plugin
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
- fast runs suppress progress; slow runs emit the first digest after fifteen
  seconds and only changed rendered digests on later fifteen-second samples;
- identical latest-five results make no extra send/cancel calls; more than five
  results in thirteen seconds retains the latest five;
- long real commands, paths, emoji, and multiline inputs respect the 50-grapheme
  item bound and 400-character notice budget without exposing output or secrets;
- replacement delivery precedes previous-notice recall; confirmed final delivery
  precedes latest-notice cleanup; cancellation suppresses late sends;
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
