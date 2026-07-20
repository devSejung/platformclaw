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

## HTTP and WebSocket surfaces

| Path                             | Method        | Purpose                                                      |
| -------------------------------- | ------------- | ------------------------------------------------------------ |
| `/platformclaw/api/auth/login`   | `POST`        | Authenticate an employee and issue the opaque session cookie |
| `/platformclaw/api/auth/logout`  | `POST`        | Revoke the active browser session and clear its cookie       |
| `/platformclaw/api/auth/session` | `GET`, `HEAD` | Return the current browser authentication state              |
| `/platformclaw/gateway`          | WebSocket     | Expose the policy-filtered OpenClaw Gateway protocol         |
| `/platformclaw/health`           | `GET`, `HEAD` | Report whether the private Gateway connection is ready       |

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
- Unknown methods and newly added upstream parameters fail closed until the
  browser policy is reviewed.

## Current boundary

The package now provides the runtime composition, Gateway adapter, protocol
listener, mock auth service, and focused tests. Production is not ready until
the host deployment supplies secrets and persistent paths, process supervision,
reverse-proxy routing, and the Control UI employee-login bootstrap. Knox ingress
and VM sandbox execution remain separate capabilities.

## See also

- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Employee authentication](/platformclaw/employee-auth)
- [Architecture decisions](/platformclaw/decisions)
