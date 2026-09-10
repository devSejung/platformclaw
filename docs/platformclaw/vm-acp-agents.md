---
summary: "Run Claude Code, Codex, and OpenCode ACP sessions inside each employee's assigned development VM account"
read_when:
  - Installing the PlatformClaw ACP adapters on an enterprise development VM
  - Enabling Claude Code, Codex, or OpenCode for personal agents
  - Troubleshooting assigned-VM ACP sessions or per-user Claude paths
title: "Assigned VM coding agents"
---

# Run coding agents in assigned VMs

PlatformClaw can start Claude Code, Codex, and OpenCode ACP sessions in the employee's
assigned Linux account over the existing SafeConnect SSH connection. The
Gateway and ACPX session manager remain on the PlatformClaw server; the adapter,
coding-agent process, working directory, credentials, and filesystem access stay
inside the assigned VM account.

Install each adapter once on the shared VM. Employees keep their own coding-agent
authentication under their Linux home directory. They do not install
their own ACP adapter.

## Before you begin

You need:

- the existing PlatformClaw assigned-VM and SafeConnect setup;
- root access to the shared Ubuntu x64 VM;
- outbound access to GitHub Releases, or an approved way to transfer the assets;
- Claude Code installed and authenticated separately for each employee who uses
  Claude;
- Codex or OpenCode authentication initialized separately for each employee who
  uses that agent.

The existing Claude Code and OpenCode adapter assets are pinned to the
`platformclaw-vm-preview-20260903` release. Do not replace them with an
unverified `npx` download on a production VM.

## Install the VM adapters

Download these files from the PlatformClaw release:

- `platformclaw-claude-agent-acp-0.62.0-linux-x64.tar.gz`
- `platformclaw-opencode-acp-1.18.27-linux-x64.tar.gz`

Verify the checksums before extraction:

```text
f9dd0217fe95c8ee31d914969f6520f164c0513e79962761fecfb5b1377db5e6  platformclaw-claude-agent-acp-0.62.0-linux-x64.tar.gz
a9ad8e7b842c4147888defad62cfecd78f0776ec0053c9390a4374727c847a1f  platformclaw-opencode-acp-1.18.27-linux-x64.tar.gz
```

As root on the VM, extract into versioned, root-owned directories and switch the
stable links atomically:

```bash
claude_adapter_dir=/opt/platformclaw/libexec/versions/claude-agent-acp-0.62.0
opencode_adapter_dir=/opt/platformclaw/libexec/versions/opencode-acp-1.18.27

install -d -m 0755 /opt/platformclaw/libexec/versions
test ! -e "$claude_adapter_dir"
test ! -e "$opencode_adapter_dir"
install -d -m 0755 "$claude_adapter_dir"
install -d -m 0755 "$opencode_adapter_dir"

tar -xzf platformclaw-claude-agent-acp-0.62.0-linux-x64.tar.gz \
  -C "$claude_adapter_dir" --strip-components=1
tar -xzf platformclaw-opencode-acp-1.18.27-linux-x64.tar.gz \
  -C "$opencode_adapter_dir" --strip-components=1

chown -R root:root "$claude_adapter_dir" "$opencode_adapter_dir"
chmod -R go-w "$claude_adapter_dir" "$opencode_adapter_dir"

test -x "$claude_adapter_dir/bin/claude-agent-acp"
test -x "$opencode_adapter_dir/bin/opencode"

ln -sfnT "$claude_adapter_dir" \
  /opt/platformclaw/libexec/claude-agent-acp
ln -sfnT "$opencode_adapter_dir" \
  /opt/platformclaw/libexec/opencode-acp

test "$(readlink -f /opt/platformclaw/libexec/claude-agent-acp)" = "$claude_adapter_dir"
test "$(readlink -f /opt/platformclaw/libexec/opencode-acp)" = "$opencode_adapter_dir"
```

Each archive contains one top-level package directory, so
`--strip-components=1` is required when extracting into these destination
directories. The `test ! -e` checks intentionally stop instead of overwriting a
previous installation. If a failed earlier attempt left either destination in
place, inspect it and choose a new versioned destination before retrying.

PlatformClaw invokes only these stable entry points:

```text
/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp
/opt/platformclaw/libexec/codex-acp/bin/codex-acp
/opt/platformclaw/libexec/opencode-acp/bin/opencode acp
```

Users must not be able to modify adapter directories or symlinks.

### Add the Codex adapter

The earlier release above does not contain the Codex adapter. On a Linux x64
build host with an official Node distribution and npm (including Node's prefix-level
`LICENSE`, as in the PlatformClaw Linux image), build the transfer archive from this checkout:

```bash
bash scripts/platformclaw-package-vm-acp.sh /tmp/vm-acp-artifacts codex
```

The builder pins `@agentclientprotocol/codex-acp` to `1.1.7` and its Codex
runtime to `0.146.1`, matching the repository dependency contract. It bundles
Node, checks the executable and ACP initialization, and emits the archive,
SHA-256 file, and resolved dependency lock. Retain the lock beside the archive;
subsequent builds in that output directory use it. The first build resolves
transitive dependencies from the registry. `claude` and `opencode` are also
accepted to rebuild their pinned adapters.

Transfer the archive and checksum to the VM through the approved transfer path.
Verify against the build checksum before installing as root:

```bash
sha256sum -c platformclaw-codex-acp-1.1.7-linux-x64.tar.gz.sha256
test ! -e /opt/platformclaw/libexec/versions/codex-acp-1.1.7
install -d -m 0755 /opt/platformclaw/libexec/versions/codex-acp-1.1.7
tar -xzf platformclaw-codex-acp-1.1.7-linux-x64.tar.gz \
  -C /opt/platformclaw/libexec/versions/codex-acp-1.1.7
chown -R root:root /opt/platformclaw/libexec/versions/codex-acp-1.1.7
chmod -R go-w /opt/platformclaw/libexec/versions/codex-acp-1.1.7
ln -sfnT /opt/platformclaw/libexec/versions/codex-acp-1.1.7 \
  /opt/platformclaw/libexec/codex-acp
```

## Enable ACP on the PlatformClaw server

The PlatformClaw Docker image already contains the `@openclaw/acpx` Gateway
plugin and its pinned runtime dependencies. Do not run `openclaw plugins
install`, `npm install -g acpx`, or `npx acpx` in the Gateway container; those
runtime changes disappear when the container is recreated and a global `acpx`
CLI is not an OpenClaw plugin installation.

Enable the bundled plugin and allow the installed VM adapters in
`openclaw.json`. If `plugins.allow` is already a non-empty allowlist, add
`"acpx"` and `"platformclaw-execution"` to it as shown here:

```json5
{
  acp: {
    enabled: true,
    backend: "acpx",
    defaultAgent: "claude",
    allowedAgents: ["claude", "codex", "opencode"],
  },
  plugins: {
    allow: ["acpx", "platformclaw-execution"], // Merge with existing entries.
    entries: {
      acpx: {
        enabled: true,
      },
      "platformclaw-execution": {
        enabled: true,
      },
    },
  },
}
```

Before restarting, verify the immutable image can discover and load the plugin:

```bash
docker run --rm --network none \
  --entrypoint bash "$PLATFORMCLAW_IMAGE" -ceu \
  'OPENCLAW_SKIP_ACPX_RUNTIME=1 openclaw plugins inspect acpx --runtime --json |
    jq -e ".plugin.id == \"acpx\" and .plugin.origin == \"bundled\" and
      .plugin.status == \"loaded\"" >/dev/null'
```

This check uses no host state volume and suppresses service startup; it verifies
plugin discovery and runtime imports from the image itself. Restart the Gateway
after changing plugin or ACP configuration. No adapter path, employee home, SSH
credential, or Claude executable path belongs in the shared Gateway
configuration.

## Configure each employee account

Sign in as the employee, open **Settings > Work location**, and select a ready
development VM. Under **Coding agents**:

1. Choose **Detect Claude Code** to use `claude` from that Linux account's
   `PATH`.
2. If detection does not find it, enter its absolute path, such as
   `/home/alice/.local/bin/claude`, and save.
3. Confirm that the detected version appears in the UI.

PlatformClaw resolves symlinks on the VM, verifies that the file is executable,
runs `--version`, and stores the canonical path against that employee's current
VM allocation. Changing the allocation, credential, work location, or Claude
path invalidates existing ACP SSH processes. A stale ACP session never falls
back to the Gateway host or Basic workspace.

The Claude adapter receives the selected path as `CLAUDE_CODE_EXECUTABLE`. It
runs with the employee's `HOME`, `PATH`, workspace, and authenticated Claude
state. Codex and OpenCode use the same employee home and workspace and do not
need a separate executable-path setting. Their cards provide **Check VM
installation**, which runs the managed executable version check in the assigned
account. This does not verify provider authentication or model access.

Open the VM terminal as the employee and authenticate the selected agent:

```bash
/opt/platformclaw/libexec/codex-acp/bin/codex-acp cli login --device-auth
/opt/platformclaw/libexec/opencode-acp/bin/opencode auth login
```

Use Codex's `cli` passthrough so login uses the same bundled Codex runtime as
ACP. Keep each employee's authentication in their VM home, never in shared
Gateway configuration. Select the VM work location, then ask in chat to use
Claude Code, Codex, or OpenCode for the task.

## Test the setup

From the employee's personal browser chat, run `/acp doctor claude`, `/acp doctor
codex`, and `/acp doctor opencode`. The transport diagnostic checks that employee's assigned VM,
SSH route, fixed adapter path, and (for Claude) configured executable. It never
probes or installs an adapter on the Gateway host. A `ready` result covers launch
prerequisites; coding-agent authentication and ACP initialization are validated
when the employee starts a session. `/acp doctor` uses `acp.defaultAgent` when
configured, otherwise it asks for an agent name instead of guessing.

From a chat owned by that employee's personal agent, ask it to start one ACP run
with `runtime: "acp"` and `agentId: "claude"`, then repeat with `agentId:
"codex"` and `agentId: "opencode"`. Ask each coding agent to report `pwd` and create a harmless file.
Each should report the assigned VM workspace, and the file should appear only in
that employee's VM account.

## Troubleshoot failures

- **Claude Code was not found:** save its canonical absolute executable path in
  **Coding agents**. Shell aliases and functions are not executable paths.
- **Claude Code is not executable:** fix file ownership or execute permission in
  the employee account, then detect it again.
- **Assigned VM ACP target changed:** close the old ACP session and start a new
  one. PlatformClaw intentionally pins allocation and credential revisions.
- **Adapter file not found:** verify the selected stable `/opt/platformclaw/libexec`
  links and root ownership on the VM.
- **`plugins.entries.acpx: plugin not installed`:** upgrade to a PlatformClaw
  image that bundles `acpx`, run the image-only inspection above, and recreate
  the Gateway container. Do not install the plugin into the running container.
- **Authentication prompt or failure:** open a shell as the same Linux user and
  complete that coding agent's login. Authentication is per employee home.
- **Session limit reached:** close an existing ACP session. PlatformClaw reserves
  one of the four SafeConnect channels for normal execution or the browser
  terminal and allows at most three concurrent ACP processes per employee.

## Production checks

- Keep adapter directories root-owned and non-writable by employees.
- Promote new adapter versions by checksum and atomic symlink change.
- Never put Claude, Codex, OpenCode, or AD credentials in `openclaw.json`.
- Validate each enabled agent with a non-privileged employee account after VM image or
  SafeConnect changes.
- Treat adapter or employee executable replacement as a new runtime revision;
  existing sessions must be restarted.

See [VM execution policy](/platformclaw/vm-execution-policy) for the execution
and isolation contract.
