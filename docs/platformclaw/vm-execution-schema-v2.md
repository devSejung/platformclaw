---
summary: "SQLite schema v2 for SafeConnect endpoints, assigned VMs, personal execution profiles, and encrypted credential envelopes"
read_when:
  - Implementing or operating personal VM execution
  - Migrating or restoring the PlatformClaw control database
  - Reviewing VM allocation or credential ownership
title: "PlatformClaw VM execution schema v2"
---

# PlatformClaw VM execution schema v2

Schema v2 extends `state/platformclaw-control.sqlite`. It does not move execution
state into OpenClaw core and does not give the Gateway direct credential access.
This page describes the VM tables introduced in v2; the current base control
schema is v3. Saved VM registrations are additive and do not bump that version.

## Tables

| Table                            | Owner and purpose                                                              |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `safeconnect_endpoints`          | Admin-approved SSH endpoint and pinned host public key                         |
| `vm_hosts`                       | Existing target VM reached through one endpoint                                |
| `vm_host_execution_environments` | Optional non-secret build environment for one VM host                          |
| `vm_allocations`                 | Personal agent to VM/Linux-account assignment                                  |
| `personal_execution_profiles`    | Active target, allocation reference, target revision                           |
| `encrypted_user_ssh_credentials` | One AES-GCM envelope per PlatformClaw user                                     |
| `saved_vm_connections`           | Verified registrations and separate encrypted credentials for each personal VM |
| `saved_vm_coding_agent_settings` | Coding Agent configuration and checks owned by a saved registration            |

Saved-connection tables are compatible additions initialized idempotently at
store startup. A one-time feature migration imports only non-revoked allocations,
retaining their IDs as durable workspace identities. The schema version and
single live-allocation index remain unchanged. Activation creates a fresh runtime
allocation and projects its credential/configuration in one synchronous transaction;
its stable `targetId` identifies the saved workspace independently of the fresh
`allocationId` used for SSH and revision checks.

`vm_host_execution_environments` is an additive schema-v2 feature table. It is
created idempotently on first VM-environment use, without advancing the schema
version, so older schema-v2 builds can ignore it. The row stores canonical JSON
containing PATH-prepend entries and environment variables plus the updating
administrator and timestamp. Empty configuration removes the row.

SafeConnect endpoint address and VM target address remain separate. The SSH
username is generated later from endpoint AD domain, bound PlatformClaw account,
allocation Linux account, and VM target address. It is not persisted as another
editable identity.

## Enforced invariants

- New personal agents receive `platform_server`, revision `0`.
- Knox room bindings cannot receive profiles or VM allocations.
- One non-revoked allocation exists per personal agent.
- One VM/Linux-account pair belongs to at most one non-revoked allocation.
- Inactive saved registrations also reserve their VM/Linux-account pair.
- Registration identity cannot be reused for another account, endpoint security
  identity, or verified home/workspace. Remove and register again after those changes.
- A profile can reference only an allocation owned by the same agent binding.
- An active allocation cannot be revoked before its profile leaves the VM.
- Active endpoints require an explicitly approving administrator and pinned
  host-key material. PlatformClaw parses the OpenSSH key blob and derives its
  SHA-256 fingerprint; approval fails if the displayed fingerprint differs.
  First release accepts the observed `ssh-ed25519` host-key format only.
- VM DNS and IP addresses are canonicalized before uniqueness checks so textual
  aliases cannot bypass VM/Linux-account ownership.
- SafeConnect endpoint DNS/IP addresses and AD DNS domains are canonicalized and
  validated before storage, duplicate checks, or SSH username construction.
- Credential rows are user-scoped and enforce 12-byte AES-GCM nonces, 16-byte
  authentication tags, and format version `1`.

SQLite checks ownership and revisions at commit. Run activity is checked by the
host's shared per-Agent admission fence, which covers preparation, queueing,
execution, and publication, including cron and warm ACP turns. A switch cannot
acquire that fence while work is admitted, and new runs are rejected while the
switch holds it. The private plugin separately guards workspace operations,
including Skill Workshop SSH access, with its target mutation coordinator.
SafeConnect and VM selection policy do not move into the generic host seam.

Allocation home and workspace paths stay empty until a successful connection
check resolves the remote account. Default remote workspace is
`${HOME}/.platformclaw/workspace`. A later home or workspace mismatch rejects
reverification until the saved connection is removed and registered again;
existing proposal bindings must never be redirected silently.

## Migration and recovery

Base initialization and existing upgrades retain their own transactions:

- version `0`: create the current base schema;
- version `1`: add v2 tables and server-default profiles, then run the existing
  v2-to-v3 upgrade;
- version `2`: run the existing v3 migration with its recoverable backup;
- version `3`: leave the base schema version unchanged;
- a version newer than the supported base version: fail closed.

Saved-connection initialization then runs in a separate `BEGIN IMMEDIATE`
transaction. It creates additive tables and triggers and records the one-time
import of non-revoked allocations with their existing IDs. Failure rolls back
this feature transaction; reopening does not recreate removed registrations or
revive revoked allocations. Activation keeps one live allocation and the user
credential as the current runtime projection; saved credentials remain scoped
to their registration.

An older build supporting the same base schema can read that projection but cannot select or manage
inactive registrations. Select Basic before downgrading and retain a database
backup with its matching master key. Keeping the schema version unchanged does
not make the older UI capable of managing the new saved-connection state.

Backups must contain the SQLite database, WAL state captured through a valid
SQLite backup/checkpoint procedure, and the matching master-key secret. The
master key is never stored in the database. Restoring only the database or only
the key makes credential envelopes unusable and must not trigger plaintext or
server-execution fallback.

The credential vault encrypts each password with AES-256-GCM, a fresh 96-bit
nonce, a 128-bit authentication tag, and authenticated data binding the owner,
format version, and master-key identifier. Users can replace or delete only
their own credential. Authentication failure changes its state to
`update_required`; replacement increments its revision and returns it to
`current`. Authentication failures use compare-and-set on the revision used by
the failed SSH attempt, so a late failure cannot invalidate a newer password.
Broker resolution checks that the owning employee is still active before
decrypting. Account disablement therefore blocks a new credential redemption;
it is not proof that a previously started remote background process has exited.

The 32-byte master key is strict Base64 in a separate Docker secret. Its SHA-256
identifier is stored with each envelope, but the key is never stored in SQLite,
an environment variable, logs, browser state, or Gateway state. The current
runtime loads one key: do not replace it until a later rotation workflow has
reencrypted all rows. The one-shot local broker transport is implemented, but
its authenticated Gateway handoff supplies revision-pinned grants to the
OpenSSH launcher, which passes password bytes to `sshpass` through an anonymous
one-shot descriptor.
