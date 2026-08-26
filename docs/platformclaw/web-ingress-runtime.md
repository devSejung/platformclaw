---
summary: "PlatformClaw browser authentication and Gateway WebSocket ingress runtime"
read_when:
  - Hosting PlatformClaw Web in front of an OpenClaw Gateway
  - Testing employee login and browser-to-agent isolation
title: "Web ingress runtime"
---

# Web ingress runtime

The PlatformClaw Web ingress is a thin backend for the upstream Control UI. It
hosts employee browser authentication and a policy-filtered Gateway WebSocket
without replacing the OpenClaw Gateway or copying its agent runtime.

The runtime lives in `packages/platformclaw-control-plane`. It is intentionally
separate from OpenClaw `src/gateway/**` so upstream Gateway and Control UI
updates remain practical to merge.

## Request flow

1. The browser signs in through the PlatformClaw authentication endpoints.
2. The server stores an opaque browser session in the control-plane database
   and returns an `HttpOnly` session cookie.
3. The browser opens `/platformclaw/gateway` with the same-origin cookie.
4. The ingress resolves the active user and personal-agent binding.
5. The ingress forwards only the Gateway methods and parameters approved by
   the browser policy proxy.
6. Gateway results and events are filtered to the owned agent and sessions
   before they return to the browser.

The ingress holds one private operator Gateway connection through the public
`@openclaw/gateway-client` package. Operator credentials never enter a browser
frame, cookie, response, or projected Gateway hello.

That private connection owns the connection-scoped `sessions.subscribe`
lifecycle. Each Gateway hello or reconnect must acknowledge the subscription
before ingress reports ready, so current, externally started, and reconnected
session tool activity all use the upstream `session.tool` path. Browser
`sessions.subscribe` receives a local capability acknowledgement; browser
`sessions.unsubscribe` is not exposed because one tab must not disable the
process-wide subscription for every other tab.

The projected method list must match the current Control UI RPC names and
capability checks. Session companion access uses `sessions.companion.ask`,
`sessions.companion.state`, and `sessions.companion.reset`; the retired
`sessions.observer.ask` name is not a compatibility surface. Companion
questions are checked against the owned session before forwarding. Because one
private Gateway connection multiplexes personal Agents, the Gateway applies
its connection-local companion limit per resolved Agent while retaining the
process-wide limit.

Session list filters such as `boardFace` and `creatorId` may narrow the
server-pinned personal-Agent result. Fork and rewind are writes restricted to
sessions owned by that personal Agent; rewind cannot select another employee's
session. Unsupported Control UI actions are hidden through projected method
advertisement instead of being rendered as dead controls.

The Session Files rail exposes only `sessions.files.list` and
`sessions.files.get`. The proxy pins the personal Agent, validates the session
key, and returns relative browser paths without the Gateway workspace root or
other host-absolute paths. `sessions.files.set`, `sessions.files.reveal`, and
`sessions.diff` remain blocked. This read-only Session Files surface is
separate from the Agent page's bounded Core Files editor.

The Settings > Memory > Memories view can search the personal Agent's
long-term memory with `memory.search` and open a result with
`agents.workspace.get`. The proxy pins both calls to the browser binding,
removes session-transcript search hits, and permits file reads only for
`MEMORY.md` and Markdown files below `memory/`. Gateway workspace roots and
search-provider metadata are not projected. Selecting an assigned VM does not
change this ownership: long-term memory remains in the Gateway-hosted personal
Agent workspace, while VM project files stay behind the sandbox file tools.

The Settings > Memory > Dreams view uses the bundled personal Memory Wiki. The
deployment keeps `memory-wiki` in agent-scoped bridge mode and exposes bounded
`doctor.memory.status`, `doctor.memory.dreamDiary`, `wiki.importInsights`,
`wiki.overview`, `wiki.status`, `wiki.search`, and `wiki.get` reads, plus the
native personal Dreaming backfill, dedupe, reset, and repair actions. The BFF
pins every call to the browser binding, caps search and page reads, and removes
workspace, vault, database, archive, warning, and source-host paths from
results. Destructive reset actions require browser confirmation. Wiki
mutation, local ingest, Obsidian command, and global config RPCs remain
unadvertised; the personal Agent writes through native Wiki tools. Assigned-VM
selection does not move this state because Agent memory remains Gateway-owned.

The Approvals view can page through the personal Agent's 30-day terminal
approval history with `approval.history`. The BFF pins the source-Agent filter
before dispatch, rejects any returned row outside that binding, and removes
optional host, plugin, session, and resolver identifiers from the browser
projection. Pending approvals continue through the separate live session
ownership flow. Assigned-VM approvals record the same personal Agent owner, so
their terminal history appears here without exposing VM connection metadata.

Transcript attachments and other downloadable session artifacts use
`artifacts.list` and `artifacts.download` with an owned `sessionKey`.
Browser-supplied `runId` and `taskId` scopes are rejected, returned artifact
metadata is revalidated against the same Agent boundary, and `artifacts.get`
remains unadvertised because the Control UI does not require it.

Attachment bytes use a separate same-origin HTTP bridge. Managed artifact URLs
must carry the short-lived capability minted by `artifacts.download`. User
uploads and assistant-generated files require an active browser cookie, an owned
session key, and an exact structured media fact in that session's user or
assistant transcript before the BFF mints a short-lived ticket. The private
Gateway validates each file against the owning Agent's allowed media roots.
Plain-text file claims do not grant access. Browser cookies, Gateway
credentials, redirects, and unapproved response headers never cross the bridge.

Inline Canvas widgets use an independent BFF capability. The browser hello
contains only a short-lived, employee-bound PlatformClaw surface URL; the
private Gateway capability is never projected. Canvas documents record their
creating Agent, and the relay sends that owner constraint to the Gateway for
every HTML or asset read. A valid browser cookie, matching employee capability,
and matching document owner are all required. `plugin.surface.refresh` rotates
only the employee's BFF capability.

Inline `show_widget` rendering remains available when the employee selects an
assigned VM. The agent loop and widget document owner stay on the Gateway; only
project shell and file tools move through the assigned-VM sandbox backend. A
widget may show results computed on that VM, but HTML must be passed as
`widget_code` even when the same document was saved as a downloadable file.
Images must use inline SVG, `data:` URLs, or `blob:` URLs; local paths, relative
paths, remote URLs, `file://` URLs, and VM paths do not become browser URLs.

PlatformClaw disables the separate paired-node Canvas plugin and the
`group:nodes` agent tool family (`nodes`, `computer`, and `mobile_ui`). Assigned
VMs are execution backends, not paired display nodes, and
the shared Gateway has no employee-owned node authorization boundary. The core
Canvas document host remains enabled for `show_widget` and its BFF relay.

The browser WebSocket payload ceiling matches the upstream Gateway at 25 MiB.
Because composer attachments are base64 inside a JSON request, the practical
single-file limit is below 18.75 MiB after envelope overhead. Supporting 100 MB
files requires a future streaming HTTP upload surface; increasing the WebSocket
limit alone would create roughly 133 MB frames and bypass the upstream ceiling.

## HTTP and WebSocket surfaces

| Path                                                  | Method        | Purpose                                                      |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------------ |
| `/platformclaw/api/auth/login`                        | `POST`        | Authenticate an employee and issue the opaque session cookie |
| `/platformclaw/api/auth/logout`                       | `POST`        | Revoke the active browser session and clear its cookie       |
| `/platformclaw/api/auth/session`                      | `GET`, `HEAD` | Return the current browser authentication state              |
| `/platformclaw/api/skill-hub/*`                       | `GET`, `POST` | Search, publish, and install registry skills                 |
| `/platformclaw/app/__openclaw__/assistant-media`      | `GET`, `HEAD` | Download transcript-owned user or assistant attachments      |
| `/api/chat/media/outgoing/*`                          | `GET`, `HEAD` | Download an owned artifact with its Gateway media ticket     |
| `/__openclaw__/cap/*/__openclaw__/canvas/documents/*` | `GET`, `HEAD` | Render an Agent-owned Canvas document through a BFF lease    |
| `/platformclaw/gateway`                               | WebSocket     | Expose the policy-filtered OpenClaw Gateway protocol         |
| `/platformclaw/health`                                | `GET`, `HEAD` | Report whether the private Gateway connection is ready       |

Login, logout, and WebSocket upgrade requests require the exact configured
public origin. The listener does not trust forwarded headers when calculating
origin, client identity, or cookie security; deployments provide the external
origin explicitly. A deployment behind a trusted reverse proxy may inject a
`resolveClientIp` function; the default uses the direct socket peer and never
accepts arbitrary forwarding headers.

## Runtime assembly

`createPlatformClawWebIngressRuntime` constructs the runtime from deployment
options:

- `BrowserAuthService`, backed by the SQLite control-plane store;
- `BrowserGatewayProxy`, backed by the same store and audit writer;
- `PlatformClawGatewayRuntimeClient`, configured with a private Gateway URL and
  operator credential from the deployment secret store.

`MemoryBrowserLoginRateLimiter` provides a bounded process-local default for
password attempts. A deployment may inject another implementation of the same
interface when rate limits must be shared across several ingress replicas.

The host process supplies `publicOrigin`, the persistent database path,
session-key helpers, personal-agent provisioner, employee authentication
configuration, and private Gateway client credentials as typed options. The
composition owns the login limiter, persistent authentication runtime,
one shared `BrowserGatewayProxy` policy layer, one private Gateway client, and
the listener. It does not add another environment-variable or `openclaw.json`
surface.

There is no proxy instance or upstream Gateway connection per user. Each
browser WebSocket connection carries only its opaque browser session token.
The shared proxy resolves that token to the current user, personal-agent
binding, and allowed session keys for every request or event. The agent access
context is per connection/request; the BFF, policy proxy, and Gateway client
are process-wide single instances.

The listener uses the upstream Gateway request, response, event, connect, and
hello frame shapes. Browser event sequence numbers are regenerated after
filtering so dropped operator events do not create false sequence gaps in the
Control UI.

## Test employee authentication

Start the repository mock on a loopback-only random port:

```bash
python3 scripts/mock_employee_auth.py --port 0
```

The first output line contains the selected `loginUrl` and the matching
`PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL` value. The default development account
is `person.one` with password `test-password`.

The mock returns the full normalized employee profile, including `accountId`,
department, part, groups, notes, and directory attributes. It deliberately does
not return an agent ID or session key. PlatformClaw derives the personal agent
ID from the authenticated account ID and owns all session routing.

Use `--accounts-file <path>` to supply additional non-sensitive test accounts.
Never put real employee records or passwords in a committed fixture.

## Security invariants

- A valid browser cookie is required before WebSocket upgrade and again during
  the Gateway connect frame.
- Session validity is rechecked without extending idle expiry for every
  forwarded Gateway event.
- A revoked or expired session closes its existing WebSocket and cannot
  reconnect.
- Browser-supplied Gateway credentials, roles, scopes, agent IDs, and device
  identity do not establish authority.
- The browser hello contains only approved methods and events, its owned agent
  defaults, non-admin scopes, and a synthetic connection ID.
- Presence, provider health, device tokens, config paths, state directories,
  operator capabilities, and upstream connection IDs are not projected.
- Event sequence numbers and state versions from the private operator stream
  are not exposed.
- The private Gateway connection is not ready until its session event
  subscription is active; stale acknowledgements from replaced connections
  cannot restore readiness.
- Unknown methods and newly added upstream parameters fail closed until the
  browser policy is reviewed.
- Every visible Control UI action must either use an advertised method or be
  hidden; policy denials must not leave clickable controls that always fail.
- Background task list, detail, cancellation, and live upsert events are
  restricted to the authenticated personal Agent. Ownership-free task deletion
  and registry restoration events are not forwarded through the shared Gateway
  stream; reconnect or explicit refresh rebuilds the Agent-scoped snapshot.

## Deployment entry point

The private control-plane package exposes `platformclaw-control`. From a source
checkout, the equivalent development command is:

```bash
pnpm platformclaw:control
```

The process requires these deployment-owned values:

| Environment variable                           | Purpose                                    |
| ---------------------------------------------- | ------------------------------------------ |
| `PLATFORMCLAW_PUBLIC_ORIGIN`                   | Exact browser HTTP(S) origin               |
| `PLATFORMCLAW_LISTEN_HOST`                     | Listener host; defaults to `127.0.0.1`     |
| `PLATFORMCLAW_LISTEN_PORT`                     | Listener port; defaults to `19001`         |
| `PLATFORMCLAW_DATABASE_PATH`                   | Persistent control-plane SQLite path       |
| `PLATFORMCLAW_CONTROL_UI_ROOT`                 | Built Control UI asset directory           |
| `PLATFORMCLAW_JIRA_VOC_CONFIG_FILE`            | Optional Jira VOC JSON secret file         |
| `PLATFORMCLAW_PERSONAL_WORKSPACE_ROOT`         | Parent directory for personal workspaces   |
| `PLATFORMCLAW_INITIAL_ADMIN_ACCOUNT_IDS_FILE`  | Initial administrator IDs secret file      |
| `PLATFORMCLAW_GATEWAY_URL`                     | Private Gateway WS(S) origin               |
| `PLATFORMCLAW_GATEWAY_TOKEN_FILE`              | Private Gateway operator-token secret file |
| `PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_FILE`  | 32-byte Base64 SSH credential key file     |
| `PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS`       | Unix socket or Windows named-pipe address  |
| `PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL`         | Employee-auth login endpoint               |
| `PLATFORMCLAW_EMPLOYEE_AUTH_BEARER_TOKEN`      | Optional employee-auth service bearer      |
| `PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL`         | External ADSSO base or login endpoint      |
| `PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_FILE` | ADSSO handoff signing-secret file          |
| `PLATFORMCLAW_SKILL_HUB_URL`                   | Optional pinned SkillHub service URL       |
| `PLATFORMCLAW_SKILL_HUB_TOKEN_FILE`            | SkillHub server API-token secret file      |
| `PLATFORMCLAW_SKILL_HUB_NAMESPACES`            | Comma-separated authorized namespaces      |
| `PLATFORMCLAW_SKILL_HUB_MAX_PACKAGE_BYTES`     | Optional archive and expansion byte limit  |

The Gateway token is shared with the private `admin-http-rpc` endpoint used for
personal-agent provisioning. The control process derives that HTTP endpoint
from the Gateway origin on the internal Docker backplane. It does not accept a
second endpoint or token that could drift from the WebSocket connection.

Initial administrator IDs, the Gateway operator token, and the SSH credential
master key are read from bounded regular files. Production mounts those files
as Docker secrets. No default administrator, operator credential, or encryption
key exists.

When `PLATFORMCLAW_JIRA_VOC_CONFIG_FILE` is set, the employee UI exposes a VOC
form and the BFF creates the Jira issue with the authenticated employee as
reporter metadata. The file is a bounded regular JSON secret with this shape:

```json
{
  "baseUrl": "https://jira.example.com",
  "projectKey": "VOC",
  "parentIssueKey": "VOC-1",
  "issueType": "Task",
  "assignee": "voc.owner",
  "components": ["PlatformClaw"],
  "coworkerField": "customfield_12345",
  "defaultCoworkers": ["voc.watcher"],
  "authorization": "Bearer <deployment-secret>"
}
```

Only `baseUrl`, `projectKey`, `issueType`, and `authorization` are required.
The file stays server-side; the browser descriptor receives only a capability
flag and never receives the Jira URL or credential.

## Current boundary

The package now provides the runtime composition, deployment configuration,
executable control listener, Gateway adapter, protocol listener, mock auth
service, Control UI employee-login bootstrap, and focused tests. The Linux
composition supplies Docker secret mounts, separate persistent state volumes,
a shared personal-workspace volume, Compose process supervision, and a
deterministic container smoke. Gateway binds to an internal backplane with no
published port; only PlatformClaw Web is published. Separate egress networks
preserve model API and employee-auth access without exposing the backplane.
Final browser Playwright proof behind the deployment reverse proxy remains open.
Knox ingress and VM sandbox execution remain separate capabilities.

## See also

- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Employee authentication](/platformclaw/employee-auth)
- [Architecture decisions](/platformclaw/decisions)
