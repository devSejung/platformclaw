---
summary: "One-shot local IPC boundary that keeps decrypted SafeConnect passwords out of Gateway state"
read_when:
  - Implementing or reviewing VM SSH authentication
  - Operating the PlatformClaw control process
  - Changing credential transport or execution grants
title: "PlatformClaw credential broker"
---

# PlatformClaw credential broker

`platformclaw-control` owns the SSH credential vault and a private local
credential broker. The broker transports one credential into a Gateway-owned
SafeConnect master connection; decrypted bytes never enter Gateway state.

## Grant contract

The control plane issues a cryptographically random 256-bit bearer grant bound
to one deferred vault resolution. The in-memory grant registry stores only the
SHA-256 token digest. Grants expire after 30 seconds, can be redeemed once, are
consumed before decryption, and cannot be retried after resolver failure. At
most 256 grants may wait in one process.

Control exposes target resolution and grant issuance on a separate internal
listener. The service re-resolves the prepared personal agent, active
allocation, target revision, and credential revision before issuing a grant
and again when the grant is redeemed. A stale or changed target or credential
therefore fails closed; a
user-controlled agent ID is never sufficient authority.

## Gateway connection lease

Gateway owns at most one process-local OpenSSH master for each prepared
personal Agent and assigned-VM snapshot. The identity includes the allocation,
target revision, credential revision, endpoint, accounts, target address, and
approved host key. Any changed identity retires the old master; active commands
may finish, but new commands use the new snapshot.

The first command authenticates through the one-shot broker and
`sshpass -d 3`. Later commands use only the owner-private OpenSSH control socket.
The lease admits four active channels and queues additional callers. This
conservative cap follows enterprise evidence that admission became variable
above eight channels. An idle lease expires after 24 hours; use renews the idle
window. Gateway shutdown closes every master and removes its temporary files.

If a master dies before a later command acquires a session, one shared
connection attempt authenticates a replacement. PlatformClaw never blindly
replays a command after transport loss because the remote command may already
have produced side effects. The runtime emits bounded
`platformclaw_ssh_master`, `platformclaw_ssh_lease`, and
`platformclaw_ssh_channel_queue` timing events without accounts, hosts, paths,
commands, or credentials.

## Local transport

Production Linux uses an absolute Unix-domain socket. Startup requires its
parent directory to be owned by the process with mode `0700`, and creates the
socket with mode `0600`. It never changes a pre-existing directory's
permissions and refuses every pre-existing socket path instead of guessing
that a live endpoint is stale. Windows development uses a named pipe with the
same binary framing and one-shot behavior.

The request contains only the opaque grant. A successful response contains the
credential revision and password bytes so a later authentication failure can
invalidate only the exact revision used. All errors become one generic response. Frames are bounded,
connections time out after five seconds, and the server accepts at most 64
concurrent local clients. Password buffers are overwritten after framing and
must also be overwritten by the caller immediately after use.

Neither the master key nor decrypted passwords enter the Gateway, command-line
arguments, ordinary environment variables, files, JSON, logs, browser state,
workspaces, audit details, or model input. The following VM backend slice will
connect the response bytes directly to `sshpass -d <fd>` and must preserve this
rule.

## Deployment

`PLATFORMCLAW_CREDENTIAL_BROKER_ADDRESS` is required by the deployable control
runtime and supplies a base name, not one reusable socket inode. Every Control
process lifetime appends a random nonce and listens on a fresh address. A crash
can therefore leave only an unreachable old socket; it cannot prevent the next
Control process from starting. The Windows preview follows the same rule with
a unique named pipe.

Compose mounts one owner-only, non-persistent memory-backed runtime directory
at `/run/platformclaw-credential-broker` in Control. Gateway receives access
only after its agent commands are Docker-isolated. The
directory is transport only: it contains no database, master key, credential
file, or durable state. The authenticated handoff returns the current one-shot
address to the SSH helper; it does not guess or enumerate socket names. The
broker starts before public Web ingress and stops before the vault database
closes.

Execution handoff uses a second owner-only Unix socket in that runtime
directory; no credential-bearing handoff is exposed over TCP. Control reads a
dedicated execution-service token. Once VM execution is enabled, Gateway reads
that token through its own secret mount, but agent sandboxes never receive it.
Rotation replaces the secret and restarts Control and Gateway; there is no
dual-token grace period in the first release. Public employee sessions and the
Gateway administration token cannot call the socket.
