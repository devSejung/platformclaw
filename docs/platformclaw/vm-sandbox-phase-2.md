---
summary: "Phase 2 design and implementation status for personal-agent VM sandbox execution"
read_when:
  - Implementing PlatformClaw personal-agent VM execution
  - Reviewing SafeConnect credential handling or Knox sandbox policy
title: "PlatformClaw VM sandbox phase 2"
---

# PlatformClaw VM sandbox phase 2

Phase 2 routes personal-agent tools into an assigned Linux account over
SafeConnect SSH. It reuses the upstream sandbox backend contract. It does not
create a Gateway, proxy, or Gateway client per employee.

This phase is in design and prerequisite implementation. The generic backend
contract now carries the resolved agent ID alongside the opaque sandbox scope
key. VM allocation persistence, credential encryption, and the
`platformclaw-vm` backend remain blocked on the schema and credential-broker
approval below.

## Fixed policy

| Ingress or agent                | Agent and session                      | Execution target                                      |
| ------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| PlatformClaw Web personal agent | Personal agent, selected owned session | Active personal target: PlatformClaw server or VM     |
| Knox direct message             | Same personal agent and `main` session | Same active target as PlatformClaw Web                |
| Knox group                      | `group-<chatroomId>`, room session     | PlatformClaw server workspace, no personal VM profile |

Knox room workspaces provide organization, not security isolation. Room agents
never receive a VM allocation or employee credential. Their per-agent
`sandbox.mode: "off"` override remains the enforcement point; no Knox branch is
added to sandbox core.

Personal agents use one explicit execution target. `platform_server` runs
commands with `exec` and `process` in the personal workspace on the
PlatformClaw server. `assigned_vm` keeps the same tool policy but runs commands
through SafeConnect in the assigned Linux account. PlatformClaw-server personal
workspaces are also operational separation, not security isolation.

VM registration is separate from target selection. A user with an assigned VM
may select the PlatformClaw server, and a server user may select an assigned VM
after its allocation and credential are ready. Only one target is active for a
personal agent at a time. Workspaces at the two targets remain independent and
are not copied or synchronized automatically.

PlatformClaw Web continues to use one `platformclaw-control` BFF, one shared
`BrowserGatewayProxy` policy layer, and one shared private Gateway client. VM
sandbox selection happens inside the one Gateway process after normal agent and
session routing.

## Execution target UI and reconciliation

Login authenticates the employee and reads the current execution target. It
does not ask for, infer, or change the target. The authenticated application
provides a separate execution-settings surface with the user-facing choices
"PlatformClaw server" and "Personal VM". The term "local mode" is not used.

An explicit change checks for an active run and, for a VM target, requires an
active administrator-approved allocation, a current employee credential, and a
successful SafeConnect connection check. The change commits atomically; any
failed prerequisite leaves the previous target active. The UI always shows the
active target and, when applicable, the assigned VM and Linux account.

The control plane is the target source of truth. Its reconciler projects only
the required generic agent policy:

```text
platform_server -> sandbox.mode: off
assigned_vm     -> sandbox.mode: all, backend: platformclaw-vm, scope: agent
```

Operators do not hand-edit agent configuration. VM address, SafeConnect
gateway, Linux account, and credential never enter the agent configuration;
the backend resolves them from the prepared `agentId` through the private
allocation client.

## Verified upstream execution boundary

The latest inspected `upstream/main` was `8d3d472cbeb68f00cdae9df411b5cb0d6b4fab42`
on 2026-07-22. The sandbox backend contract was unchanged from PlatformClaw's
current upstream ancestor `0acece45912de43a7c29638babcb70afce59652c`.

The current call flow is:

```text
agent/session route
  -> resolveSandboxRuntimeStatus
  -> resolveSandboxConfigForAgent
  -> resolveSandboxWorkspaceLayoutPaths
       returns exact scopeKey
  -> registered SandboxBackendFactory
       receives resolved agentId + exact scopeKey
  -> SandboxBackendHandle
       buildExecSpec for exec/process
       runShellCommand/createFsBridge for file tools
  -> child SSH process and remote Linux workspace
```

Evidence:

- `src/agents/embedded-agent-runner/run/attempt-setup.ts` resolves sandbox
  context before tool construction.
- `src/agents/sandbox/runtime-status.ts` applies global and per-agent sandbox
  mode. This already supports personal `mode: "all"` and Knox room
  `mode: "off"` without enterprise-specific core logic.
- `src/agents/sandbox/shared.ts` creates the lifecycle `scopeKey`.
- `src/agents/sandbox/context.ts` passes the scope to the selected backend and
  installs its exec and filesystem bridges.
- `src/agents/sandbox/backend.ts` owns the process-wide backend registry.
- `src/plugin-sdk/sandbox.ts` exposes `registerSandboxBackend` and the backend
  contracts to plugins.
- `src/agents/agent-tools.ts` and `src/agents/bash-tools.exec-runtime.ts` route
  `exec` and `process` through `SandboxBackendHandle.buildExecSpec`.
- `src/agents/sandbox/fs-bridge.ts` routes file operations through the backend
  shell bridge.
- `extensions/openshell/index.ts` and `extensions/mxc/src/plugin.ts` prove that
  optional sandbox implementations can remain plugin-owned.

The backend must treat `scopeKey` as an opaque lifecycle value. It may store,
compare, hash, or return the exact value. It must not split it or infer an agent
from its text. The separately prepared `agentId` is the control-plane ownership
lookup key.

## Why the bundled SSH backend is not the implementation

The bundled `ssh` backend already provides remote-canonical workspaces, remote
file tools, command execution, lifecycle inspection, and strict host-key
checking. Its transport writes `BatchMode yes` and supports key or certificate
material. SafeConnect requires keyboard-interactive AD password authentication,
so changing its configured command alone cannot enable the required login.

The minimum implementation is a private `platformclaw-vm` plugin that registers
one backend through `openclaw/plugin-sdk/sandbox`. It should reuse upstream
remote command, path, and filesystem helpers where their contracts fit, while
owning allocation lookup and SafeConnect authentication.

## Credential transport

Password bytes may exist only in the control-plane credential owner, the
short-lived broker response, and the SSH authentication process memory. They
must never enter model input, workspace files, browser state, logs, audit event
details, command arguments, or environment variables.

Recommended transport is OpenSSH `SSH_ASKPASS` with
`SSH_ASKPASS_REQUIRE=force`. The helper contains no credential and reads one
password from an inherited file descriptor or equivalent one-shot IPC channel.
The SSH command line contains only paths, option names, the target, and the
remote command.

`sshpass` is an acceptable fallback only with its `-d <fd>` input. The `-p`,
`-e`, and password-file modes are rejected because they expose or materialize
the credential outside the one-shot process channel. `sshpass -d` also adds a
runtime package and prompt-matching dependency, so the validated native
OpenSSH askpass path remains preferred.

Every connection must keep strict host-key verification, allow one password
attempt, disable agent/key fallback, and return redacted typed failures. Tests
must use fake credentials and assert that the password is absent from argv,
environment, logs, workspace trees, registry rows, and error text.

## Proposed runtime boundary

The first runtime slice should contain:

1. A private `platformclaw-vm` plugin registered at Gateway startup.
2. A process-wide allocation client, not one client per user or scope.
3. A backend factory that receives `agentId` and exact `scopeKey`, then fails
   closed unless an active personal binding has one active allocation.
4. A remote-canonical workspace rooted below the administrator-selected remote
   root. `scopeKey` selects lifecycle state without being parsed.
5. A one-shot credential channel into OpenSSH askpass.
6. Backend lifecycle and filesystem behavior through the existing sandbox
   handle, registry, and remote filesystem contracts.

The allocation client should talk to `platformclaw-control` over one private
Unix-domain socket shared by the two containers. This keeps the control-plane
database and encryption master key out of the Gateway container. The socket is
runtime IPC, not persisted state. Its exact request/response protocol and
socket path land with the approved schema slice.

## Approval required before persistence

Schema version 1 cannot represent execution-target selection, VM hosts,
Linux-account allocation, or encrypted AD passwords. The recommended schema
version 2 adds:

```text
personal_execution_profiles
  id, personal_binding_id UNIQUE,
  active_target, revision, updated_by_user_id, created_at, updated_at

vm_sandbox_hosts
  id, host, port, known_hosts_entry, remote_workspace_root, state,
  created_at, updated_at

vm_sandbox_allocations
  id, personal_binding_id UNIQUE, host_id, linux_account, credential_id UNIQUE,
  state, created_by_user_id, created_at, updated_at,
  UNIQUE (host_id, linux_account)

vm_sandbox_credentials
  id, cipher, key_id, nonce, ciphertext, auth_tag, created_at, rotated_at
```

Recommended encryption is AES-256-GCM with a fresh 96-bit nonce per write. The
credential row stores ciphertext and authentication tag only. Additional
authenticated data binds the ciphertext to the credential ID, personal binding
ID, and encryption format version. A separate 256-bit master key is mounted
into `platformclaw-control` as a Docker secret. It is not stored in SQLite,
Compose YAML, environment variables, Gateway config, or the Gateway container.

Alternative: store only an external secret reference per allocation and keep
password bytes in a deployment secret provider. This avoids encrypted password
rows but requires a provider and lifecycle contract for up to one credential
per personal agent.

Do not implement either option until the operator approves:

- schema version 2 and its execution-profile and VM tables;
- encrypted-database credentials or external secret references;
- Unix-domain credential broker ownership and master-key placement;
- backup, restore, key rotation, and credential rotation policy.

## Test plan

The implementation checkpoint requires:

- two personal agents resolve different allocations and cannot reuse each
  other's backend handle, scope, Linux account, workspace, or credential;
- login reads but never changes the active execution target;
- a target change fails atomically while a run is active or a VM prerequisite
  is unavailable, leaving the previous target active;
- server and VM targets retain equal `exec` and `process` policy while commands
  execute in the selected location;
- switching targets never copies, merges, or deletes either workspace;
- concurrent allocation cannot assign one `(host_id, linux_account)` pair to
  more than one personal binding;
- Web and Knox DM calls for one personal agent resolve the same allocation;
- Knox group agents keep `sandbox.mode: "off"`, execute locally, and never call
  the allocation or credential broker;
- caller-controlled session or scope text cannot select another allocation;
- opaque scope keys containing unexpected separators remain exact values;
- disabled users, bindings, hosts, allocations, and revoked credentials fail
  closed before SSH launch;
- password bytes are absent from argv, environment, logs, errors, workspaces,
  browser frames, and audit details;
- SSH host-key mismatch and keyboard-interactive rejection return redacted
  failures;
- restart and concurrent first-use behavior do not create duplicate allocation
  or runtime state.

Focused unit tests should cover policy, lookup, and redaction. Linux Docker
proof must exercise the plugin, broker, fake keyboard-interactive SSH server,
remote command execution, file bridge, Gateway restart, and Knox group bypass.

## Progress

- Complete: upstream boundary and latest-upstream delta investigation.
- Complete: custom plugin seam and sibling backend proof.
- Complete: additive resolved-agent input for backend factories and workdir
  resolvers, with focused contract coverage.
- Complete: SafeConnect transport comparison and credential exposure rules.
- Blocked on approval: SQLite version 2 and encrypted credential persistence.
- Next after approval: allocation contracts and in-memory tests, then schema and
  encrypted store, then private broker and `platformclaw-vm` plugin.

## See also

- [PlatformClaw architecture](/platformclaw)
- [Architecture decisions](/platformclaw/decisions)
- [Control plane phase 1](/platformclaw/control-plane-phase-1)
- [Sandboxing](/gateway/sandboxing)
- [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
