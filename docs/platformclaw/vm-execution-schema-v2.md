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

## Tables

| Table                            | Owner and purpose                                      |
| -------------------------------- | ------------------------------------------------------ |
| `safeconnect_endpoints`          | Admin-approved SSH endpoint and pinned host public key |
| `vm_hosts`                       | Existing target VM reached through one endpoint        |
| `vm_allocations`                 | Personal agent to VM/Linux-account assignment          |
| `personal_execution_profiles`    | Active target, allocation reference, target revision   |
| `encrypted_user_ssh_credentials` | One AES-GCM envelope per PlatformClaw user             |

SafeConnect endpoint address and VM target address remain separate. The SSH
username is generated later from endpoint AD domain, bound PlatformClaw account,
allocation Linux account, and VM target address. It is not persisted as another
editable identity.

## Enforced invariants

- New personal agents receive `platform_server`, revision `0`.
- Knox room bindings cannot receive profiles or VM allocations.
- One non-revoked allocation exists per personal agent.
- One VM/Linux-account pair belongs to at most one non-revoked allocation.
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

Allocation home and workspace paths stay empty until a successful connection
check resolves the remote account. Default remote workspace is
`${HOME}/.platformclaw/workspace`. A later HOME mismatch marks the allocation
for explicit confirmation; runtime must not silently redirect it.

## Migration and recovery

Initialization runs under one `BEGIN IMMEDIATE` transaction:

- version `0`: create schema v1, then migrate to v2;
- version `1`: add v2 tables and create server-default profiles for existing
  personal bindings;
- version `2`: no-op;
- any newer version: fail closed without changing the database.

Backups must contain the SQLite database, WAL state captured through a valid
SQLite backup/checkpoint procedure, and the matching master-key secret. The
master key is never stored in the database. Restoring only the database or only
the key makes credential envelopes unusable and must not trigger plaintext or
server-execution fallback.

Schema v2 only establishes persistence and allocation policy. AES-256-GCM
encryption, key rotation, credential broker, SSH process, and Docker dependency
land in later bounded changes.
