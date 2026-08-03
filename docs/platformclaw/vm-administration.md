---
summary: "Administrator workflow for trusted SafeConnect endpoints, VM catalog, and assignment revocation"
read_when:
  - Operating or changing PlatformClaw VM administration
  - Reviewing SafeConnect host-key approval or VM assignment
title: "VM administration"
---

# VM administration

Only an active PlatformClaw administrator can open the VM administration
surface or call its browser API. The control-plane store repeats the same role
check so bypassing the UI does not bypass authorization.

## Setup order

1. Add the SafeConnect endpoint host, SSH port, and AD domain.
2. Obtain its SSH host public key and SHA-256 fingerprint through an approved,
   independent administrator channel.
3. Compare both values and explicitly approve the host key. A key merely seen
   during an SSH connection is not trusted automatically.
4. Add a target development VM to the approved endpoint.
5. The employee opens **Work location**, selects an active VM, confirms the
   Linux account, enters an AD password, and runs the connection test.
6. PlatformClaw creates or replaces the allocation only after that test passes.

The page shows current endpoints, VMs, assignments, and recent VM audit events.
It never returns stored passwords or credential ciphertext to the browser.

## VM build environment

Administrators may configure a non-secret build environment on each development
VM. `Additional PATH` accepts absolute POSIX directories, one per line, and
prepends them to the standard remote command path. `Environment variables`
accepts one `KEY=value` entry per line. For example:

```text
TOOLCHAIN_PREFIX=/opt/toolchains/gcc/bin/aarch64-elf-
CLANG11_PATH=/opt/toolchains/clang/bin/
```

These values apply only to agent commands on that VM. They do not affect the
Basic workspace, PlatformClaw services, filesystem bridge operations, or an
already prepared agent run. A saved change is pinned into the next run's VM
target snapshot.

Do not store passwords, tokens, or other secrets here. The assigned Linux
account can inspect its command environment. PlatformClaw rejects direct
`PATH` replacement and reserved shell, dynamic-loader, OpenClaw, and
PlatformClaw variables; use the dedicated PATH list instead.

## Disable and revoke lifecycle

The administration surface supports assignment revocation, VM disablement, and
endpoint disablement with explicit confirmation. These operations are soft
state changes; they do not delete database history or remote files.

Revoke active assignments before disabling a VM. Disable all active VMs before
disabling their endpoint. A user may release their own allocation only from the
basic workspace. The same run-boundary guard applies to administrator
revocation, so running work is never silently moved. Re-enable and hard-delete
flows are intentionally absent from the first release; register a new record
when replacing infrastructure.
