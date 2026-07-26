# PlatformClaw runtime composition

Korean operators should start with
[`OPERATIONS.ko.md`](./OPERATIONS.ko.md) for installation, upgrades, Gateway
configuration, storage, enterprise CA setup, and VM/SafeConnect administration.

This composition runs one OpenClaw Gateway process and one
`platformclaw-control` process from the same Jammy image. Docker Compose owns
process restart and shutdown. It never creates a process or Gateway connection
per employee.

The two containers share a dedicated internal backplane. Gateway port `18789`
binds only inside that backplane and is never published; the host publishes only
PlatformClaw Web port `19001` from the control container. Separate egress
networks let Gateway call model APIs and the control service call employee auth
without exposing the private backplane. Both services bind the canonical host
workspace at the identical `/var/lib/platformclaw/workspaces` path used by the
dedicated rootless Docker daemon. Gateway and control-plane state use separate
persistent volumes. Control owns one memory-backed runtime directory reserved
for the one-shot VM credential channel. It is erased when the Compose stack
stops and is never part of backup or restore.

Required deployment inputs:

- `PLATFORMCLAW_IMAGE`
- `PLATFORMCLAW_SANDBOX_IMAGE`
- `PLATFORMCLAW_SANDBOX_DOCKER_RUNTIME_DIR`
- `PLATFORMCLAW_PUBLIC_ORIGIN`
- `PLATFORMCLAW_EMPLOYEE_AUTH_LOGIN_URL`
- `PLATFORMCLAW_GATEWAY_TOKEN_SECRET_FILE`
- `PLATFORMCLAW_GATEWAY_SERVICE_IDENTITY_SECRET_FILE`
- `PLATFORMCLAW_EXECUTION_SERVICE_TOKEN_SECRET_FILE`
- `PLATFORMCLAW_INITIAL_ADMIN_IDS_SECRET_FILE`
- `PLATFORMCLAW_SSH_CREDENTIAL_MASTER_KEY_SECRET_FILE`

Run Compose through `platformclaw-compose`. It resolves the named service
account with `id`, exports its numeric UID/GID, and derives the rootless socket
directory. No host UID is fixed in the deployment contract:

```bash
./platformclaw-compose --service-user platformclaw environment
./platformclaw-compose --service-user platformclaw config --quiet
./platformclaw-compose --service-user platformclaw up -d
```

Fresh installations create the workspace with the detected service UID/GID.
Changing the service account for an existing non-empty workspace is an explicit
operator action, never a startup side effect. Stop the stack and provide the
previous numeric owner only for the one-shot migration:

```bash
./platformclaw-compose --service-user platformclaw down
sudo env PLATFORMCLAW_PREVIOUS_RUNTIME_UID=1000 \
  PLATFORMCLAW_PREVIOUS_RUNTIME_GID=1000 \
  ./platformclaw-compose --service-user platformclaw \
  --profile owner-migration run --rm platformclaw-workspace-owner-migration
./platformclaw-compose --service-user platformclaw up -d
```

The migration changes only entries owned by the explicitly supplied former
UID/GID, never follows symlinks, and cannot cross the workspace mount.

Compose file-backed secrets preserve host ownership and mode, so prepare the
five files for that service account without making them readable to other
users. Keep their parent directory root-only, for example:

```bash
service_user=platformclaw
runtime_uid="$(id -u "$service_user")"
runtime_gid="$(id -g "$service_user")"
sudo install -d -o root -g root -m 0700 /etc/platformclaw/secrets
sudo install -o "$runtime_uid" -g "$runtime_gid" -m 0400 gateway-token \
  /etc/platformclaw/secrets/gateway-token
openssl genpkey -algorithm ED25519 | sudo install -o "$runtime_uid" -g "$runtime_gid" -m 0400 \
  /dev/stdin /etc/platformclaw/secrets/gateway-service-identity.pem
openssl rand -hex 32 | sudo install -o "$runtime_uid" -g "$runtime_gid" -m 0400 /dev/stdin \
  /etc/platformclaw/secrets/execution-service-token
sudo install -o "$runtime_uid" -g "$runtime_gid" -m 0400 initial-admin-ids \
  /etc/platformclaw/secrets/initial-admin-ids
openssl rand -base64 32 | sudo install -o "$runtime_uid" -g "$runtime_gid" -m 0400 /dev/stdin \
  /etc/platformclaw/secrets/ssh-credential-master-key
```

Point the five `*_SECRET_FILE` inputs at those installed files. Do not store
their values in Compose YAML or an environment file. Back up the SSH credential
master key separately; losing it makes stored AD credentials undecryptable.
Back up the control database and its matching master key together. Do not back
up the credential-broker runtime volume. Keep the Gateway service identity
stable across Control restarts; replacing it creates a new trusted Gateway
device and requires the normal device-pairing path again.

## Sandbox Docker daemon

Run a dedicated rootless Docker daemon as the same service account. Never give
Gateway the host/rootful Docker socket. Its socket directory is normally
`/run/user/<service-uid>` and the wrapper derives that path automatically.
Configure Docker rootless prerequisites, including subordinate UID/GID ranges,
for the service account before starting PlatformClaw.

Create the canonical workspace with the same numeric owner:

```bash
sudo install -d -o "$runtime_uid" -g "$runtime_gid" -m 0700 /var/lib/platformclaw/workspaces
```

Deployments upgrading from the earlier Compose layout must migrate the legacy
`platformclaw-workspaces` named volume before starting the new services. Stop
the stack, create the empty host directory above, then run the one-shot profile:

```bash
./platformclaw-compose --service-user platformclaw down
./platformclaw-compose --service-user platformclaw --profile migration run --rm platformclaw-workspace-migration
./platformclaw-compose --service-user platformclaw up -d
```

The migration refuses to overwrite a non-empty target. It copies all workspace
content, preserves metadata, and changes ownership to the runtime UID/GID. Keep
the old named volume until the copied workspaces have been verified and backed
up; normal startup never mounts or modifies it.

The transfer tar contains both `platformclaw` and `platformclaw-sandbox`.
Load it through the deployment Docker daemon and the dedicated rootless daemon,
then select the versioned sandbox tag with `PLATFORMCLAW_SANDBOX_IMAGE`:

```bash
docker load --input platformclaw-<version>-<sha>.tar
sudo -u "$service_user" env \
  XDG_RUNTIME_DIR="/run/user/$runtime_uid" \
  DOCKER_HOST="unix:///run/user/$runtime_uid/docker.sock" \
  docker load --input platformclaw-sandbox-<version>-<sha>.tar
```

Sandbox commands use Docker `bridge` networking. They may make outbound
requests but cannot share the host network namespace. `host` networking and
the host Docker socket remain forbidden. Model API and Knox transport traffic
stay in Gateway and do not traverse the sandbox network.

Sandbox processes run as container UID/GID `0:0`. Under rootless Docker this
maps to the unprivileged host service account, not host root. This
mapping lets the sandbox write its one mounted workspace without granting host
root or another employee workspace.

The operator still starts and stops one Compose project; the two containers are
an internal process boundary, not two separately configured products. The host
publishes only Control port `19001`. Normal health checks require both
`openclaw-gateway` and `platformclaw-control` to be healthy. Control-only
restarts create a fresh broker socket automatically and do not require deleting
runtime files.

The credential-broker volume is transient and includes the detected UID/GID in
its deployment name. Changing the service account therefore creates a fresh
owner-correct broker volume instead of reusing immutable Docker volume options.
Old broker volumes contain no durable credential state and may be removed after
the old stack has stopped.

Control exposes execution handoff only through an owner-only Unix socket in the
same memory-backed runtime directory as the credential broker. It never opens a
TCP handoff listener. Gateway receives that directory and the execution-service
token. Neither enters an agent sandbox. Personal agents use the static
`platformclaw-execution` backend: the basic workspace delegates to upstream
Docker, while an assigned VM delegates to upstream SSH. Knox room provisioning
must explicitly select upstream Docker and may never select a VM. Rotate the token by replacing its secret file
and restarting Control and Gateway; the first release has no old-token grace
period.

The Jammy runtime includes OpenSSH and `sshpass`. PlatformClaw permits only
`sshpass -d <fd>` for SafeConnect password delivery; password arguments,
environment variables, and password files remain forbidden.

The first Gateway start seeds a canonical config that enables the private
`admin-http-rpc` and `platformclaw-execution` plugins and selects bridge-networked
Docker sandboxing. Its entry point reads Gateway authentication from the mounted
Docker secret before starting OpenClaw. An existing `openclaw.json` is never
overwritten; operators upgrading an existing state volume must apply the same
managed sandbox settings before exposing traffic.

Build and run deterministic smoke:

```bash
pnpm test:docker:platformclaw-runtime
```

The smoke uses synthetic employee records. It proves login, personal-agent
provisioning, authenticated app hosting, internal execution-target handoff,
session lookup, logout, private Gateway restart, port isolation, and absence of
deployment secrets from logs and browser HTML.
