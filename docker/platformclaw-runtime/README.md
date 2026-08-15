# PlatformClaw runtime composition

Korean operators should use [`OPERATIONS.ko.md`](./OPERATIONS.ko.md). It is the
canonical install, configuration, upgrade, backup, enterprise CA, VM, and
SafeConnect runbook.

The stack runs `openclaw-gateway` and `platformclaw-control` in rootful Docker.
Agent sandboxes run in a separate rootless Docker daemon owned by the service
account. Gateway receives only that rootless socket; it never receives the host
Docker socket. The host publishes only Control port `19002`, bound to all host
interfaces for VM access. Restrict that port with the host firewall or an
approved reverse proxy before connecting the host to an untrusted network.

## Home-managed state

`platformclaw-compose` derives the service account home and defaults
`PLATFORMCLAW_DEPLOY_ROOT` to `/home/<service-user>/platformclaw`. Persistent
host paths are bind-mounted at the identical absolute path inside Gateway and
Control. This invariant lets the nested rootless daemon resolve workspace and
materialized-skill bind sources correctly.

```text
~/platformclaw/
├── deployment.env
├── data/
│   ├── gateway-home/.openclaw/openclaw.json
│   ├── control/platformclaw-control.sqlite
│   └── workspaces/
├── secrets/
├── certs/employee-auth-ca.pem
└── releases/
```

Gateway, Control, and workspace state are ordinary service-user-owned host
files. The credential broker remains a memory-backed Docker volume and must not
be backed up. The legacy `platformclaw-workspaces` volume remains declared only
for the explicit migration profile.

The runtime image accepts any numeric service UID/GID selected by
`platformclaw-compose`. When that identity is not present in the image's static
user database, the runtime entrypoint supplies a process-local NSS identity
before starting Gateway or Control. This keeps OpenSSH, Git, and other Unix
tools working without rebuilding the image for each server account.

## Home development disk maintenance

Local builds remove their SHA-scoped intermediate images on both success and
failure. They retain the newest final image plus one rollback image per
repository and the newest three release tar archives. The manual or explicitly
installed weekly maintenance also bounds the shared BuildKit cache to 20 GB;
normal builds do not prune caches belonging to other projects. Preview or run
the bounded cleanup manually:

```powershell
pnpm platformclaw:dev-cleanup
pnpm platformclaw:dev-cleanup --apply
```

Install the current-user weekly cleanup task with
`powershell -File scripts/platformclaw-dev-maintenance.ps1 -Action Install`.
VHDX compaction is intentionally separate because it stops Docker Desktop and
WSL and requires elevation; preview it with
`powershell -File scripts/platformclaw-docker-vhdx-compact.ps1`.

## Operator entry points

After the one-time Docker/rootless prerequisites and Docker-group setup:

```bash
sudo ./platformclaw-deploy --service-user platformclaw host-setup
# log out and back in once
./platformclaw-deploy setup \
  --main-image platformclaw:<sha12> \
  --sandbox-image platformclaw-sandbox:<sha12> \
  --public-origin https://<platformclaw-host> \
  --employee-auth-login-url https://<employee-auth-host>/login
```

`setup` writes and validates the required deployment values, creates the home
layout, then starts and health-checks a fresh stack. It stops before generating
secrets or starting containers if placeholders remain.
For an existing named-volume or `/var/lib/platformclaw` installation, run
`sudo ./platformclaw-deploy --service-user platformclaw migrate-home` once,
inspect the copy, then run `./platformclaw-deploy up` as the service user. The
privileged migration never starts the new stack. Existing non-empty targets are
accepted only with matching component completion markers. Compose always uses project name
`platformclaw`; set `PLATFORMCLAW_LEGACY_COMPOSE_PROJECT` when importing a
differently named legacy project. Migrated Gateway or Control state requires
all five matching legacy secrets and never falls through to replacement key
generation.
For a fresh install it generates stable random secrets and prompts once for the
initial admin account ID. Non-interactive installs set
`PLATFORMCLAW_INITIAL_ADMIN_IDS_SOURCE` to an owner-readable file. Routine
operations need no sudo.

To promote an existing active employee account after its first successful
login, run this as the service user:

```bash
./platformclaw-deploy admin add <account-id>
```

The command changes only that user's global role, records a deployment-operator
audit event, and is idempotent. It does not rerun setup, replace secrets, reset
state, or restart containers. The user must reconnect or sign in again before
an already-open browser connection receives the new role.

Run raw Compose only through the wrapper. It detects UID/GID and home, derives
the rootless runtime directory, forces the main daemon socket to
`unix:///var/run/docker.sock`, and reads the stable
`~/platformclaw/deployment.env` file:

```bash
./platformclaw-compose --service-user platformclaw environment
./platformclaw-compose --service-user platformclaw config --quiet
./platformclaw-compose --service-user platformclaw up -d --wait
```

Required deployment inputs live in `deployment.env.example`. Secret values do
not belong in that environment file; only paths to owner-readable files do.
Keep the SSH credential master key stable and back it up with the Control DB.
Keep the Gateway service identity stable across restarts.

Set `PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_URL` to the employee-auth ADSSO base or
login endpoint. Install the PlatformClaw 1.0 handoff signing secret at the path
named by `PLATFORMCLAW_EMPLOYEE_AUTH_ADSSO_SECRET_SECRET_FILE`; the deployment
does not generate this shared secret. The Control container receives it as a
read-only Docker secret and exposes neither the value nor its host path to the
browser.

### Optional web relay

The bundled `platformclaw-web-relay` plugin preserves normal OpenClaw web tool
behavior until an endpoint is configured. Add either or both URLs to
`~/platformclaw/deployment.env`:

```dotenv
WEB_FETCH_RELAY_URL=https://relay.example/fetch
WEB_SEARCH_RELAY_URL=https://relay.example/search
```

`WEB_FETCH_RELAY_URL` routes `web_fetch` through the relay before any direct
HTTP request. `WEB_SEARCH_RELAY_URL` selects the relay search provider. The two
variables are independent; an omitted or empty variable leaves that tool on its
normal direct/provider path. Restart Gateway after changing them:

```bash
./platformclaw-compose --service-user platformclaw up -d --wait --force-recreate openclaw-gateway
```

Public relay endpoints need no token. The client omits `x-token` when the
matching `WEB_FETCH_RELAY_TOKEN` or `WEB_SEARCH_RELAY_TOKEN` process variable is
absent. Do not put tokens in `deployment.env`; authenticated deployment must
inject them through an owner-controlled secret mechanism.

Gateway rejects private and special-use `web_fetch` targets before calling the
relay. The relay service must enforce the same SSRF policy at its own egress
boundary, including redirects and DNS resolution.

The service account's CA bundle is mounted into both runtime services and set
through `NODE_EXTRA_CA_CERTS`. `platformclaw-deploy up` seeds a missing file
from the Ubuntu system bundle and never overwrites an existing file. Replace
`~/platformclaw/certs/employee-auth-ca.pem` with the approved enterprise bundle,
then run `./platformclaw-deploy ca apply` to restart both Node services and wait
for health.

## Configuration and images

The active `openclaw.json` is directly editable on the host or inside Gateway:

```bash
./platformclaw-deploy config path
EDITOR=nano ./platformclaw-deploy config edit
./platformclaw-deploy config shell
./platformclaw-deploy config validate
./platformclaw-deploy config apply
```

Safe edit creates a timestamped backup, validates the canonical config, and
restarts Gateway only after validation succeeds. PlatformClaw-managed sandbox
and private-plugin policy remains enforced at startup.

### Global MCP servers

Administrators own the shared MCP registry. Add or inspect an upstream
OpenClaw `mcp.servers` entry from the Gateway config shell, then restart the
Gateway so every employee Agent sees the updated registry:

```bash
./platformclaw-deploy config shell
node /app/openclaw.mjs mcp add docs \
  --url https://mcp.example.com/mcp \
  --transport streamable-http
node /app/openclaw.mjs mcp doctor docs --probe
exit
./platformclaw-deploy config apply
```

Credential-free servers and administrator-configured shared credentials use
the same global registry. Any configured credential grants shared authority to
every employee Agent, so restrict server-side permissions and exposed tools to
the intended organization-wide scope. Employees cannot read or mutate MCP
configuration through the employee BFF. Personal MCP registries are not part
of this phase.

Before upgrading an existing deployment, inspect global and per-Agent
`tools.sandbox.tools.deny` values. Remove `bundle-mcp`, `group:plugins`, and
wildcards matching `bundle-mcp`, then run `./platformclaw-deploy config
validate`. The new image rejects these conflicting policies during managed
config reconciliation instead of silently widening access to other plugins.
`platformclaw-deploy image update` restores the previous image pair and Gateway
state if this migration requirement is missed.

The transfer archive contains the main and sandbox images plus the exact
SkillHub v0.2.16 server/scanner and pinned PostgreSQL/Redis object images. The
Hub services have no host ports and share only an internal network with
Control. Existing two-image archives remain usable by deployments whose
`PLATFORMCLAW_SKILL_HUB_ENABLED` is absent or `false`. New deployments enable
the bundled Hub and keep its database, Redis AOF, and package storage under
`~/platformclaw/data/skillhub/`. Initial startup requires 4 GiB RAM and 20 GiB
free space; later restarts retain a 5 GiB free-space floor.

The deployment
helper loads it into rootful and rootless daemons, switches both refs, waits for
health, recreates existing agent sandboxes with the new image, and restores the
prior environment on failure. Before startup it stops the stack, saves a full
Gateway-state snapshot, and runs `openclaw doctor --fix --yes --non-interactive`
with the new image. If Doctor or health validation fails, it restores both the
old image refs and the pre-migration Gateway and SkillHub state before restarting the old
stack. Compose never pulls these private image names from a registry, and
update refuses to start unless the current rollback pair exists locally.
Previous images and the reported state snapshot remain available for an
explicit rollback:

```bash
./platformclaw-deploy image update \
  platformclaw-<version>-<sha12>.tar \
  platformclaw:<sha12> \
  platformclaw-sandbox:<sha12>
./platformclaw-deploy image rollback
```

Preview image cleanup after the new deployment is stable, then apply it
explicitly:

```bash
./platformclaw-deploy image cleanup
./platformclaw-deploy image cleanup --apply
```

Cleanup is scoped to the exact `platformclaw` repository in the main daemon and
`platformclaw-sandbox` in the rootless daemon. It preserves the current image
IDs and every image still referenced by a container; it never runs a global
Docker prune or forces deletion. Applying cleanup removes older rollback images,
so reload the older transfer archive before using `image rollback` afterward.

Changing the service account for an existing workspace remains an explicit
owner migration. Stop the stack and supply the former numeric owner:

```bash
PLATFORMCLAW_PREVIOUS_RUNTIME_UID=1000 \
PLATFORMCLAW_PREVIOUS_RUNTIME_GID=1000 \
./platformclaw-compose --service-user platformclaw \
  --profile owner-migration run --rm platformclaw-workspace-owner-migration
```

The migration uses `--profile owner-migration`, changes only entries owned by
the supplied UID/GID, does not follow symlinks, and cannot cross the workspace
mount.

## Runtime boundaries

The Gateway and Control share a private backplane. Separate egress networks let
Gateway call model APIs and Control call employee auth without publishing the
backplane. Sandbox commands use bridge networking; host networking and the host
Docker socket remain forbidden. Rootless container UID/GID `0:0` maps to the
unprivileged service account on the host.

Control exposes execution handoff through an owner-only Unix socket in the
memory-backed credential-broker directory. The execution token and deployment
secrets never enter agent sandboxes. SafeConnect passwords use only
`sshpass -d <fd>`; password arguments, environment variables, and files remain
forbidden.

## Verification

```bash
pnpm test:docker:platformclaw-runtime
```

The deterministic Linux smoke proves rootless sandbox startup, employee login,
personal-agent provisioning, app hosting, execution handoff, VM/SafeConnect
boundaries, private Gateway restart, port isolation, and absence of deployment
secrets from logs and browser HTML.
