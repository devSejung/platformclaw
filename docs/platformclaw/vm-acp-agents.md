---
summary: "Run Claude Code and OpenCode ACP sessions inside each employee's assigned development VM account"
read_when:
  - Installing the PlatformClaw ACP adapters on an enterprise development VM
  - Enabling Claude Code or OpenCode for personal agents
  - Troubleshooting assigned-VM ACP sessions or per-user Claude paths
title: "Assigned VM coding agents"
---

# Run coding agents in assigned VMs

PlatformClaw can start Claude Code and OpenCode ACP sessions in the employee's
assigned Linux account over the existing SafeConnect SSH connection. The
Gateway and ACPX session manager remain on the PlatformClaw server; the adapter,
coding-agent process, working directory, credentials, and filesystem access stay
inside the assigned VM account.

Install each adapter once on the shared VM. Employees keep their own Claude Code
or OpenCode authentication under their Linux home directory. They do not install
their own ACP adapter.

## Before you begin

You need:

- the existing PlatformClaw assigned-VM and SafeConnect setup;
- root access to the shared Ubuntu x64 VM;
- outbound access to GitHub Releases, or an approved way to transfer the assets;
- Claude Code installed and authenticated separately for each employee who uses
  Claude;
- OpenCode authentication initialized separately for each employee who uses
  OpenCode.

The adapter assets are pinned to the
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
install -d -m 0755 /opt/platformclaw/libexec/versions
install -d -m 0755 /opt/platformclaw/libexec/versions/claude-agent-acp-0.62.0
install -d -m 0755 /opt/platformclaw/libexec/versions/opencode-acp-1.18.27

tar -xzf platformclaw-claude-agent-acp-0.62.0-linux-x64.tar.gz \
  -C /opt/platformclaw/libexec/versions/claude-agent-acp-0.62.0
tar -xzf platformclaw-opencode-acp-1.18.27-linux-x64.tar.gz \
  -C /opt/platformclaw/libexec/versions/opencode-acp-1.18.27

chown -R root:root /opt/platformclaw/libexec/versions/claude-agent-acp-0.62.0 \
  /opt/platformclaw/libexec/versions/opencode-acp-1.18.27
chmod -R go-w /opt/platformclaw/libexec/versions/claude-agent-acp-0.62.0 \
  /opt/platformclaw/libexec/versions/opencode-acp-1.18.27

ln -sfnT /opt/platformclaw/libexec/versions/claude-agent-acp-0.62.0 \
  /opt/platformclaw/libexec/claude-agent-acp
ln -sfnT /opt/platformclaw/libexec/versions/opencode-acp-1.18.27 \
  /opt/platformclaw/libexec/opencode-acp
```

PlatformClaw invokes only these stable entry points:

```text
/opt/platformclaw/libexec/claude-agent-acp/bin/claude-agent-acp
/opt/platformclaw/libexec/opencode-acp/bin/opencode acp
```

Users must not be able to modify either directory or symlink.

## Enable ACP on the PlatformClaw server

The PlatformClaw Docker image already contains the `@openclaw/acpx` Gateway
plugin and its pinned runtime dependencies. Do not run `openclaw plugins
install`, `npm install -g acpx`, or `npx acpx` in the Gateway container; those
runtime changes disappear when the container is recreated and a global `acpx`
CLI is not an OpenClaw plugin installation.

Enable the bundled plugin and allow only the two VM adapters in
`openclaw.json`. If `plugins.allow` is already a non-empty allowlist, add
`"acpx"` to it as shown here:

```json5
{
  acp: {
    enabled: true,
    backend: "acpx",
    defaultAgent: "claude",
    allowedAgents: ["claude", "opencode"],
  },
  plugins: {
    allow: ["acpx"], // Merge with existing entries; do not replace them.
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
state. OpenCode uses the same employee home and workspace but does not need a
separate executable-path setting.

## Test the setup

From the employee's personal browser chat, `/acp doctor` should report an
isolated process transport and `healthy: unverified`. It intentionally does not
probe or install an adapter on the Gateway host. The assigned VM, employee
credentials, and adapter are validated only when that employee starts a session.

From a chat owned by that employee's personal agent, ask it to start one ACP run
with `runtime: "acp"` and `agentId: "claude"`, then repeat with `agentId:
"opencode"`. Ask each coding agent to report `pwd` and create a harmless file.
Both should report the assigned VM workspace, and the file should appear only in
that employee's VM account.

## Troubleshoot failures

- **Claude Code was not found:** save its canonical absolute executable path in
  **Coding agents**. Shell aliases and functions are not executable paths.
- **Claude Code is not executable:** fix file ownership or execute permission in
  the employee account, then detect it again.
- **Assigned VM ACP target changed:** close the old ACP session and start a new
  one. PlatformClaw intentionally pins allocation and credential revisions.
- **Adapter file not found:** verify the two stable `/opt/platformclaw/libexec`
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
- Never put Claude, OpenCode, or AD credentials in `openclaw.json`.
- Validate both agents with a non-privileged employee account after VM image or
  SafeConnect changes.
- Treat adapter or employee executable replacement as a new runtime revision;
  existing sessions must be restarted.

See [VM execution policy](/platformclaw/vm-execution-policy) for the execution
and isolation contract.
