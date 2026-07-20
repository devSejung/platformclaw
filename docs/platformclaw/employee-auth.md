---
summary: "PlatformClaw employee authentication, browser session, and profile provisioning contract"
read_when:
  - Integrating the current LDAP-compatible employee login service
  - Implementing the PlatformClaw web BFF or USER.md provisioning
title: "PlatformClaw employee authentication"
---

# PlatformClaw employee authentication

The current login adapter preserves the deployed employee-auth service boundary
without copying enterprise authentication into OpenClaw core. The login service
URL is deployment configuration:

```text
PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL=http://127.0.0.1:18080/login
PLATFORMCLAW_EMPLOYEE_AUTH_BEARER_TOKEN=<optional secret>
```

The bearer belongs in the deployment secret store. Neither value belongs in
source control. There is no fallback to the legacy `OPENCLAW_*` variable names;
deployment explicitly moves to the PlatformClaw-owned names.

The production URL must use HTTPS because the request contains the employee
password and may contain the service bearer. Plain HTTP is accepted only for a
loopback mock (`localhost`, `127.0.0.0/8`, or `::1`).

## Password login contract

The adapter sends a JSON `POST` with `identifier`, `password`, and optional
request context (`clientIp`, `gatewayUrl`, and `userAgent`). The password exists
only for that request and is never stored by the control-plane.

An authenticated response requires:

```json
{
  "authenticated": true,
  "employeeId": "account.name"
}
```

The deployed response may additionally provide `accountId`, `subject`, `name`,
`displayName`, `email`, `department`, `part`, `confluenceSpace`, `notes` (or
legacy `note`), `groups`, and a nested `attributes` object containing string or
string-array values. Missing optional fields do not fail login.

During the LDAP phase, `accountId` falls back to `employeeId`, and `subject`
falls back to the normalized account ID. A future SAML adapter must provide a
stable `subject`; it may not use the LDAP fallback implicitly.

Legacy `agentId` and `sessionKey` response fields are deliberately ignored.
The personal agent binding derives `agentId` from the canonical account ID by
replacing `.` with `_`, and current OpenClaw routing owns the session key.

## Profile provisioning

Successful authentication produces two different objects:

- `EnterprisePrincipal`: stable identity plus mutable authorization metadata
  used by the control-plane store.
- `EmployeeDirectoryProfile`: approved workspace bootstrap input, including
  part, Confluence space, notes, groups, and explicit extensible attributes.

The personal-agent provisioner receives the profile after the binding is
reserved. It owns OpenClaw `agents.create`, workspace validation, and the
managed block in `USER.md`. Authentication code does not write workspaces.
Provisioning failure marks a new binding `failed` and does not issue a browser
session. A later login retries the failed binding idempotently.

## Browser BFF contract

The framework-neutral HTTP boundary currently handles:

- `POST /platformclaw/api/auth/login`
- `GET /platformclaw/api/auth/session`
- `POST /platformclaw/api/auth/logout`

The host process must inject bounded JSON parsing, a trusted client IP, TLS
state, an exact same-origin allowlist, and an authentication rate limiter.
Login accepts only `application/json`; login and logout reject disallowed
origins. Production TLS state must produce a
`Secure`, `HttpOnly`, `SameSite=Lax` cookie named `platformclaw_session`.

The cookie contains a random opaque token. Only its SHA-256 hash is stored in
SQLite. It contains no directory profile, agent ID, VM credential, or Gateway
operator credential. The server enforces the 12-hour idle timeout, seven-day
absolute timeout, three-session limit, logout revocation, and account-disable
revocation.

Schema v1 has not shipped as a tagged PlatformClaw release. Development
databases created before the employee-auth adapter introduced a distinct
`accountId` contract must be recreated; PC-109 deliberately provides no runtime
legacy reader or migration. A migration requires a separate approved schema
change after deployment begins.

## Legacy mock smoke

Until the mock is moved into this repository, start the legacy fixture from the
adjacent `platform-agent` checkout:

```powershell
python ..\platform-agent\scripts\mock_employee_auth.py --bind 127.0.0.1 --port 18080
$env:PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL = "http://127.0.0.1:18080/login"
```

That mock intentionally implements only a subset of the production profile.
Use an `--accounts-file` fixture when testing optional profile fields. Tests
must use fake employees and must never copy a production auth response into the
repository.
