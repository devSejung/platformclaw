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

Open **Settings > Administration > VM administration**. The Administration group
also contains **Web announcements** and is hidden from employees. Both pages
support direct links; VM administration uses `/platformclaw/app/settings/vms`.

The overview opens on the development VM list. Separate tabs show SafeConnect
connections, employee assignments, and recent activity. Counts describe the
configured catalog and assignments, not live SSH health. Add or edit an item in
its focused dialog; **Build environment** remains available for enabled VMs.

Connection registration separates the connection check from explicit host-key
approval. During a request, closing the progress dialog only hides it: the page
keeps the operation visible and lets you reopen progress. Success updates the
list and closes the dialog automatically. Errors keep the draft available for
correction or retry. Leaving the page prevents a retired request from starting
another write.

## Setup order

1. Add the SafeConnect endpoint host, SSH port, and AD domain.
2. Obtain its SSH host public key and SHA-256 fingerprint through an approved,
   independent administrator channel.
3. Compare both values and explicitly approve the host key. A key merely seen
   during an SSH connection is not trusted automatically.
4. Add a target development VM to the approved endpoint.
5. The employee opens **Work location**, selects an active VM, confirms the
   Linux account, enters an AD password, and runs the connection test.
6. PlatformClaw saves the verified connection, then activates it through the
   guarded switch. Previously registered VMs remain available in **Work location**.

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

Use **Rename** on a SafeConnect connection to change its display name, including
while enabled. This operation preserves its address, AD domain, approved host key,
VM connections, assignments, and credentials. Address, port, and AD domain edits
still require disabling the endpoint. Security identity changes require saved VM
connections to be forgotten and registered again. The same applies when changing
the Linux account or verified workspace. Password-only reauthentication retains
the saved connection and its Coding Agent settings.

Employee assignments include inactive saved VM connections. Revoke the intended
registration explicitly; revoking an inactive connection leaves the employee's
active work location alone. Use the existing assignment revocation flow for an
active connection; its guarded switch fails while Agent work is active or admitted,
including cron, queued preparation, and warm ACP turns. New runs receive a retry
error while the switch holds the host's admission fence. The private execution
plugin also excludes Skill Workshop SSH operations and other workspace mutations
from that switch; the shared host fence contains no SafeConnect policy.

The administration surface supports assignment revocation, VM disablement, and
endpoint disablement with explicit confirmation. These operations are soft
state changes; they do not delete database history or remote files.

Saved registrations belonging to disabled employees remain administratively
revocable when inactive. This does not bypass the guarded removal of an active
allocation.

Revoke active assignments before disabling a VM. Disable all active VMs before
disabling their endpoint. A user may release their own allocation only from the
basic workspace. The same run-boundary guard applies to administrator
revocation, so running work is never silently moved. An endpoint with an approved
host key can be re-enabled. Re-enable its endpoint before re-enabling a VM.
Disabled infrastructure records can be edited. Changing the endpoint host or port
clears its host-key approval and requires independent verification and approval
again. Changing the AD domain keeps the pinned SSH host key but still requires
the endpoint to be disabled and affected saved connections to be registered anew.
Infrastructure hard deletion remains unavailable. Removing a saved registration
removes its connection and saved settings while retaining audit and allocation
history and leaving remote files alone.
