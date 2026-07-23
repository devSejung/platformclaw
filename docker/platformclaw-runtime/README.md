# PlatformClaw runtime composition

This composition runs one OpenClaw Gateway process and one
`platformclaw-control` process from the same Jammy image. Docker Compose owns
process restart and shutdown. It never creates a process or Gateway connection
per employee.

The two containers share a dedicated internal backplane. Gateway port `18789`
binds only inside that backplane and is never published; the host publishes only
PlatformClaw Web port `19001` from the control container. Separate egress
networks let Gateway call model APIs and the control service call employee auth
without exposing the private backplane. Both services share the
personal-workspace volume, while Gateway and control-plane state use separate
persistent volumes. Control owns one memory-backed runtime directory reserved
for the one-shot VM credential channel. It is erased when the Compose stack
stops and is never part of backup or restore.

Required deployment inputs:

- `PLATFORMCLAW_IMAGE`
- `PLATFORMCLAW_PUBLIC_ORIGIN`
- `PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL`
- `PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE`
- `PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE`
- `PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE`
- `PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE`

Both containers intentionally run as UID/GID `1000:1000`. Compose file-backed
secrets preserve host ownership and mode, so prepare the four files as UID 1000
readable without making them readable to other users. Keep their parent
directory root-only, for example:

```bash
sudo install -d -o root -g root -m 0700 /etc/platformclaw/secrets
sudo install -o 1000 -g 1000 -m 0400 gateway-token \
  /etc/platformclaw/secrets/gateway-token
openssl rand -hex 32 | sudo install -o 1000 -g 1000 -m 0400 /dev/stdin \
  /etc/platformclaw/secrets/execution-service-token
sudo install -o 1000 -g 1000 -m 0400 initial-admin-ids \
  /etc/platformclaw/secrets/initial-admin-ids
openssl rand -base64 32 | sudo install -o 1000 -g 1000 -m 0400 /dev/stdin \
  /etc/platformclaw/secrets/ssh-credential-master-key
```

Point the four `*_SECRET_FILE` inputs at those installed files. Do not store
their values in Compose YAML or an environment file. Back up the SSH credential
master key separately; losing it makes stored AD credentials undecryptable.
Back up the control database and its matching master key together. Do not back
up the credential-broker runtime volume.

The operator still starts and stops one Compose project; the two containers are
an internal process boundary, not two separately configured products. The host
publishes only Control port `19001`. Normal health checks require both
`openclaw-gateway` and `platformclaw-control` to be healthy. Control-only
restarts create a fresh broker socket automatically and do not require deleting
runtime files.

Control also listens on port `19002` only inside the private backplane. A later
privileged executor will use that listener to resolve a prepared execution
target and request a short-lived credential grant. The employee-facing Gateway
does not receive the execution-service token or credential-broker socket. The
listener is never published to the host. Once the executor is deployed, rotate
the token by replacing its secret file and restarting Control and the executor;
the first release does not keep an old-token grace period.

The Jammy runtime includes OpenSSH and `sshpass`. PlatformClaw permits only
`sshpass -d <fd>` for SafeConnect password delivery; password arguments,
environment variables, and password files remain forbidden.

The first Gateway start seeds a canonical config that enables the private
`admin-http-rpc` plugin. Its entry point reads Gateway authentication from the
mounted Docker secret before starting OpenClaw. An existing `openclaw.json` is
never overwritten.

Build and run deterministic smoke:

```bash
pnpm test:docker:platformclaw-runtime
```

The smoke uses synthetic employee records. It proves login, personal-agent
provisioning, authenticated app hosting, internal execution-target handoff,
session lookup, logout, private Gateway restart, port isolation, and absence of
deployment secrets from logs and browser HTML.
