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
credential broker. The broker is transport infrastructure; it does not yet run
SSH or make a VM execution backend available.

## Grant contract

The control plane issues a cryptographically random 256-bit bearer grant bound
to one deferred vault resolution. The in-memory grant registry stores only the
SHA-256 token digest. Grants expire after 30 seconds, can be redeemed once, are
consumed before decryption, and cannot be retried after resolver failure. At
most 256 grants may wait in one process.

Grant issuance is currently an in-process control-plane API. The VM backend
slice must add the authenticated control-to-Gateway handoff before it can use
the broker; user-controlled agent IDs are never sufficient authority.

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
at `/run/platformclaw-credential-broker` in both containers. Control has write
access and Gateway has a read-only mount. The directory is transport only: it
contains no database, master key, credential file, or durable state. The later
authenticated handoff returns the current one-shot address to the SSH helper;
Gateway does not guess or enumerate socket names. The broker starts before
public Web ingress and stops before the vault database closes.
