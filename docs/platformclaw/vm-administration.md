---
summary: "Administrator workflow for trusted SafeConnect endpoints, VMs, and employee assignments"
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
5. Assign an active personal Agent, Linux account, and VM.
6. The employee registers an AD password and runs the connection test from
   **Work location** before selecting the VM.

The page shows current endpoints, VMs, assignments, and recent VM audit events.
It never returns stored passwords or credential ciphertext to the browser.

## Deferred destructive lifecycle

Endpoint disable, VM disable, assignment revocation, and reassignment are not
available in the first administration surface. Those operations can strand or
misidentify processes that remain in the previous execution environment. They
will be added only with a process-aware confirmation and recovery contract.

Use database backup and the audited operator procedure for exceptional cleanup
until that contract exists. Do not edit allocation rows while Gateway processes
are active.
