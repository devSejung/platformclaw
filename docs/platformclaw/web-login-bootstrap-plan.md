---
summary: "Implementation plan for PlatformClaw sign-in and the authenticated Control UI shell"
read_when:
  - Implementing the PlatformClaw employee login page
  - Hosting the upstream Control UI behind PlatformClaw browser sessions
  - Changing post-login navigation or session-expiry behavior
title: "Web login bootstrap plan"
---

# Web login bootstrap plan

This slice turns the existing browser-auth and Gateway ingress contracts into a
usable employee web application. It adds a small PlatformClaw-owned login shell
and a narrow adapter around the upstream Control UI. It does not fork the chat
application or add enterprise authentication to the OpenClaw Gateway.

Implementation starts after the Web Gateway proxy and Web ingress runtime
branches are on `main`. Detailed visual design, branding, animation, and final
copy are intentionally deferred. The functional states and security boundary
defined here are not deferred.

Implementation status: the login shell, authenticated application-document
host, Control UI adapter, restricted application shell, and deployable control
process entry point are implemented. Focused Windows Chrome proof covers the
fixed proxy URL, disabled-route fallback, account shell, and session-expiry
redirect. Linux secret/volume composition and deterministic container smoke are
implemented. Final Playwright proof behind the deployment reverse proxy remains
open.

## Outcome

After this slice:

1. An unauthenticated browser sees the PlatformClaw employee login page.
2. A successful password login provisions or reuses the employee's personal
   agent and issues only an opaque `HttpOnly` browser cookie.
3. The browser enters the upstream Control UI on the personal agent's main
   session without seeing a Gateway URL, token, password, or agent selector.
4. The first UI exposes chat and personal session management. Unsupported
   operator routes are absent and direct navigation to them returns to chat.
5. Logout and browser-session expiry close the WebSocket and return the browser
   to the employee login page.
6. A private Gateway restart reconnects the UI without logging the employee
   out.

## Fixed topology

The topology remains the one approved by PC-005 and PC-116:

```text
browser
  -> one platformclaw-control HTTP/WebSocket process
       -> one BrowserGatewayProxy policy instance
       -> one private Gateway client
            -> one OpenClaw Gateway
```

Users do not receive proxy instances or private Gateway connections. Per-user
state consists of the opaque browser session and the agent/session access
context resolved by the shared policy layer.

The login page, application document, authentication APIs, and WebSocket use
one configured public origin. Cross-origin browser deployment is out of scope.

## Browser routes

| Path                             | Owner                    | Behavior                                                          |
| -------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `/platformclaw/login`            | PlatformClaw login shell | Show password login or redirect an active session to the app      |
| `/platformclaw/app/*`            | Control UI host          | Require an active browser session before serving the SPA document |
| `/platformclaw/api/auth/login`   | Browser auth service     | Authenticate, provision, and set the opaque cookie                |
| `/platformclaw/api/auth/logout`  | Browser auth service     | Revoke the session and clear the cookie                           |
| `/platformclaw/api/auth/session` | Browser auth service     | Return current user and expiry state                              |
| `/platformclaw/gateway`          | Web ingress              | Carry the policy-filtered Gateway protocol                        |
| `/platformclaw/health`           | Web ingress              | Report private Gateway readiness                                  |

Static hashed assets may be served without a session because they contain no
employee data. The SPA document and all data APIs remain session-gated. A deep
link under `/platformclaw/app/*` preserves its path through login only when the
return target is a same-origin path under that exact prefix.

## Login flow

The login shell is PlatformClaw-owned and does not load the full Control UI.

1. `GET /platformclaw/login` serves a small HTML, CSS, and JavaScript bundle.
2. The shell calls `GET /platformclaw/api/auth/session` with same-origin
   credentials.
3. An active session redirects to `/platformclaw/app/chat` or a validated
   `returnTo` path.
4. Otherwise the employee enters an account ID and password.
5. The shell posts JSON to `/platformclaw/api/auth/login` with the exact public
   origin and same-origin credentials.
6. While the request runs, the page shows a workspace preparation state. The
   current login service completes personal-agent provisioning before returning
   success, so a separate browser polling protocol is not needed.
7. Success clears the password field and redirects to the app. Failure keeps
   the account ID, clears the password, and shows a bounded product message.

The browser never stores the password. The authentication service URL and its
optional bearer remain server-side deployment configuration. Authentication
responses cannot select the PlatformClaw agent or session.

Initial error mapping:

| HTTP status  | UI state                                                     |
| ------------ | ------------------------------------------------------------ |
| `400`, `415` | Invalid request; allow correction                            |
| `401`        | Invalid credentials                                          |
| `403`        | Account disabled or request origin denied                    |
| `409`        | Browser session limit reached                                |
| `429`        | Rate limited; respect `Retry-After`                          |
| `503`        | Authentication or agent provisioning temporarily unavailable |

Exact wording and visual treatment remain part of the later UI design pass.

## Authenticated app bootstrap

The BFF validates the browser cookie before serving an application document.
The document includes a non-secret, PlatformClaw-owned runtime descriptor with:

- the fixed same-origin Gateway WebSocket path;
- the login, logout, and session paths;
- the initial functional route allowlist;
- a flag that enables PlatformClaw browser-session behavior.

The descriptor contains no employee profile, agent ID, session key, Gateway
credential, or internal service URL. User identity comes from the session API;
agent and main-session defaults come from the filtered Gateway hello.

The initial descriptor contract is deliberately small:

```ts
type PlatformClawWebDescriptor = {
  mode: "platformclaw";
  gatewayPath: "/platformclaw/gateway";
  loginPath: "/platformclaw/login";
  logoutPath: "/platformclaw/api/auth/logout";
  sessionPath: "/platformclaw/api/auth/session";
  enabledRoutes: ["chat", "new-session", "sessions"];
};
```

The host emits only these literal route values. The browser parser rejects
unknown fields and values instead of treating the descriptor as arbitrary
configuration.

A small UI adapter reads this descriptor before the normal Control UI runtime
starts. It supplies the same-origin `/platformclaw/gateway` URL directly to the
existing application Gateway store with empty token and password fields. The
adapter must disable persisted remote-Gateway selection and cached device-token
fallback for this mode. Cookie authentication is the only browser authority.

The normal Gateway hello then supplies `defaultAgentId` and `mainSessionKey`.
The existing Control UI session resolver uses those server-projected values;
the browser does not construct or choose another agent binding.

## First post-login surface

The initial surface reuses the upstream Control UI chat and session components.
It does not recreate chat rendering, streaming, attachments, tool cards, model
selection, or session history.

The first functional route allowlist is:

- Chat, including the personal main session.
- New session, constrained by the BFF to the owned personal agent.
- Sessions, constrained by the BFF to owned session keys.

The shell adds only a compact employee identity and logout control. Agent,
channel, plugin, node, configuration, approvals, usage, and other operator
navigation is hidden. Direct navigation to a disabled route is replaced with
the chat route. This is presentation only; `BrowserGatewayProxy` remains the
authorization boundary for every request and event.

The route list may expand only after the matching Gateway method and parameter
policy has been reviewed. A hidden route never implies that an RPC is safe, and
an advertised upstream method never automatically enables a route.

## Session and connection state

The adapter uses these states:

```text
checking-session
  -> unauthenticated -> login
  -> authenticated -> connecting -> ready
                              -> gateway-unavailable -> reconnecting
ready -> logging-out -> login
ready -> session-expired -> login
```

Behavior is deterministic:

- WebSocket close `1012` means the private Gateway restarted. Keep the app
  mounted and use the existing bounded reconnect behavior.
- WebSocket close `1008` from an inactive browser session triggers one session
  API check. An inactive result redirects to login. An active result is treated
  as a protocol or policy error and does not create a login loop.
- A session API response with `authenticated: false` clears browser-only UI
  state and redirects to login.
- Logout first posts to the logout API, then stops the Gateway client, clears
  browser-only session selection, and redirects even if the response fails.
- Refreshing or opening a deep link repeats the server-side app-document gate;
  the browser cannot render stale employee data before authentication.

## Minimal upstream divergence

The implementation must keep PlatformClaw UI behavior in one adapter module
and one PlatformClaw-owned login bundle. Expected upstream touch points are:

1. one startup call before `bootstrapApplication` starts the Gateway;
2. one route-availability input consumed by the existing sidebar and router;
3. one identity/logout presentation hook in the application shell.

Do not add `employeeMode` conditionals across individual pages. Do not copy the
legacy employee UI, fork the chat view, or add PlatformClaw policy to upstream
Gateway methods. If an existing generic Control UI hook can satisfy a touch
point at implementation time, use it instead of adding a PlatformClaw-specific
core branch.

The legacy system is evidence for the separate employee entry, workspace
preparation state, identity summary, and logout behavior. Its browser bootstrap
token, browser-supplied agent/session routing, and broad per-page employee mode
are explicitly not migration targets.

## Hosting and deployment composition

The deployable `platformclaw-control` entry point will assemble the existing
Web ingress runtime and the UI asset host. Deployment supplies:

- public origin and listen address;
- persistent control-plane database path;
- employee-auth login URL and optional service bearer;
- initial administrator account IDs from a Docker secret;
- private Gateway URL and operator credential from a Docker secret;
- the built Control UI and PlatformClaw login asset roots.

Exact new environment-variable names are chosen in the deployment slice only
after existing configuration surfaces are checked. Secret values never appear
in generated HTML, process arguments, logs, health responses, or browser
configuration.

The final authority is an Ubuntu Linux container. The production image runs one
control process and one OpenClaw Gateway process under supervision; it does not
start a process for each employee.

## UI development and validation loop

Use Windows for the short visual feedback loop and Ubuntu Docker for release
authority. Rebuilding the production image after each layout or copy adjustment
is not required.

The implementation loop is:

1. Start `scripts/mock_employee_auth.py`, the local PlatformClaw Web runtime,
   and the Control UI development server on Windows. Use only synthetic mock
   accounts and credentials.
2. Open the login and authenticated app routes in a Windows browser. Adjust the
   layout, responsive states, copy, loading behavior, and errors while observing
   the actual page. Check at least the login, preparing-workspace, chat-ready,
   session-expired, and unavailable states affected by the change.
3. During iteration, run formatting, UI typecheck, and only the focused Vitest
   or mocked Playwright scenario covering the changed state. Keep visual
   iteration independent from the production image build.
4. At the end of each functional slice, run the complete focused control-plane
   and UI test set, then build the UI assets. Record screenshots when a review
   needs visual comparison.
5. After all four slices are integrated, build the Ubuntu image with
   `pnpm platformclaw:build` and run the final Playwright E2E against the
   containerized Web runtime, mock employee-auth service, and private Gateway.

Windows proves development behavior and visual intent. The container E2E proves
Linux path casing, asset hosting, process composition, cookie behavior,
WebSocket routing, and browser flows in the deployable artifact. A Windows-only
pass cannot replace that final proof, and UI implementation must not introduce
Windows-only paths or runtime dependencies.

## Non-goals

This slice does not implement SAML, Knox routing, VM selection, SafeConnect
credential storage, or sandbox execution. Those capabilities consume the same
identity and agent binding later but do not change browser bootstrap.

The follow-on PC-115 profile slice uses an immutable, agent-ID-keyed plugin
SQLite entry and prompt hook. It does not mutate `USER.md` or another workspace
file; the UI must not reintroduce the legacy whole-file mutation path.

## Security requirements

- Keep `HttpOnly`, `Secure`, and `SameSite=Lax` on the browser cookie in
  production.
- Require the exact configured public origin for login, logout, and WebSocket
  upgrade.
- Add `Cache-Control: no-store` to login, app documents, and auth responses.
- Apply a restrictive CSP to both documents; allow only the built asset origin
  and the same-origin WebSocket.
- Validate `returnTo` as a path, never as an absolute or protocol-relative URL.
- Do not trust forwarding headers unless a deployment-owned trusted-proxy
  resolver is explicitly configured.
- Do not log login bodies, cookies, employee profiles, Gateway frames, or
  secrets.
- Keep UI route filtering separate from BFF authorization tests.

## Implementation slices

### Slice A: UI hosting contract

- Add typed runtime descriptor and strict parser.
- Add authenticated SPA document gate and safe `returnTo` handling.
- Serve built static assets with path traversal and cache-control tests.
- Prove that no descriptor field can carry a credential or routing identity.

### Slice B: Login shell

- Add the minimal login bundle and session check.
- Implement login states and status mapping.
- Implement active-session and validated-return redirects.
- Test with `scripts/mock_employee_auth.py` and multiple mock accounts.

### Slice C: Control UI adapter

- Set the fixed same-origin Gateway URL without token persistence.
- Consume server-projected agent and main-session defaults.
- Apply route allowlisting and direct-route fallback.
- Add identity, logout, expiry redirect, and Gateway-restart behavior.

### Slice D: deployable runtime and proof

- Add the Linux container entry point and secret-backed composition.
- Run focused control-plane and UI tests.
- Run Control UI Playwright proof for login, chat bootstrap, logout, expiry,
  cross-agent denial, deep links, and private Gateway restart.
- Build and smoke-test the Ubuntu image with an isolated mock auth service.

Each slice should be a reviewable commit. Heavy Linux build and browser proof
runs in the background after the Windows visual loop and focused local tests
pass. Routine CSS, layout, and copy changes stay in the Windows loop until a
functional checkpoint is ready.

## Verification matrix

| Scenario                      | Required result                                            |
| ----------------------------- | ---------------------------------------------------------- |
| No cookie opens app deep link | Redirect to login with a bounded same-origin return path   |
| Valid login                   | One session cookie, one personal agent, main session opens |
| Concurrent first login        | One personal-agent binding is created                      |
| Forged agent or session input | BFF denies and audits the request                          |
| Fourth active browser login   | Login page shows session-limit state                       |
| Logout                        | Session revoked, WebSocket stopped, login shown            |
| Idle or absolute expiry       | Existing WebSocket closes and login is shown               |
| Private Gateway restart       | UI reconnects without employee reauthentication            |
| Disabled route deep link      | UI returns to chat; no operator RPC is sent                |
| Stale browser device token    | It is neither sent nor used as PlatformClaw authority      |
| Personal Agent page           | Only owned files and read-only Skills are available        |
| Workspace file response       | Host filesystem paths are removed by the BFF               |
| Session model selection       | Only a model in the configured catalog is accepted         |

## Deferred UI decisions

These do not block functional implementation:

- exact layout, colors, typography, logo, mascot, and animation;
- Korean or English final copy and localization policy;
- announcement, documentation, and release-note presentation;
- administrator screen placement;
- additional user-facing routes after their BFF policy exists;
- SAML redirect and callback presentation;
- VM profile, SafeConnect credential, and sandbox status presentation.

Any later `design.md` rules apply to those surfaces without changing the
identity, session, Gateway, or authorization boundary in this plan.

PlatformClaw visual rules belong in `ui/src/platformclaw/` and in narrow shell
inputs consumed by upstream components. Do not copy upstream views or spread
PlatformClaw CSS and product conditionals through individual Control UI pages.
If a design needs a missing shared primitive, add the smallest generic upstream
hook and keep the PlatformClaw theme, assets, and composition in the overlay.

## See also

- [Web ingress runtime](/platformclaw/web-ingress-runtime)
- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Employee authentication](/platformclaw/employee-auth)
- [Architecture decisions](/platformclaw/decisions)
