---
summary: "Target architecture and migration boundary for the embedded PlatformClaw Skill Hub runtime"
read_when:
  - Implementing the embedded Skill Hub runtime or deployment wiring
  - Extending Skill Hub organization, scanning, ACL, or notification contracts
  - Reviewing PlatformClaw and iflytek SkillHub ownership boundaries
title: "Skill Hub architecture"
---

# Skill Hub architecture

The target deployment runs Skill Hub on the single PlatformClaw server while
preserving a replaceable registry adapter boundary. “Embedded” means one managed
PlatformClaw deployment and release lifecycle, not browser-side registry logic or
registry code spread through the OpenClaw Gateway.

This architecture is implemented by the PlatformClaw deployment profile.

## Runtime topology

| Layer            | Current ownership                                                                |
| ---------------- | -------------------------------------------------------------------------------- |
| Browser          | Same-origin PlatformClaw Skill Hub BFF and Lit UI only                           |
| Control plane    | Employee actor, scope ACL, ownership, packaging, scan governance, audit, inbox   |
| Registry runtime | Pinned SkillHub server and scanner on the PlatformClaw server's internal network |
| Gateway          | Canonical archive validation, Basic install/update, bounded VM-export sessions   |
| Execution plugin | Assigned-VM export, transfer, atomic install/update/remove, and target locking   |
| SkillHub plugin  | Authorized Knox `/skillhub` command registration and bounded control-plane call  |
| Release          | One PlatformClaw image archive and checksum flow for all runtime images          |

```text
employee browser
  -> platformclaw-control (session, actor, ACL, projection, audit)
      -> replaceable Skill Hub adapter
          -> embedded registry runtime on the PlatformClaw server
      -> private OpenClaw Gateway upload/install path
          -> Basic workspace
          -> platformclaw-execution -> assigned VM workspace
      <- bounded Gateway export capability <- platformclaw-execution <- assigned VM
```

Only `platformclaw-control` is browser-facing. The registry listener, database,
scanner, Gateway credential, and VM SSH boundary remain private.

## Runtime ownership

`platformclaw-control` owns employee-facing policy:

- resolve the authenticated actor and personal Agent;
- consume shared organization authorization and evaluate Skill Hub visibility,
  ownership, and per-user ACL policy;
- select allowed namespaces and project safe response fields;
- package a real workspace skill;
- record publication, install, ownership, force, and ACL audit facts; and
- dispatch lifecycle notifications.

The registry owns immutable skill versions, package blobs, registry indexing,
version metadata, and scanner results. The OpenClaw Gateway remains the canonical
owner of local archive extraction and Basic workspace installation. The
`platformclaw-execution` plugin remains the owner of remote VM access and mutation.

Assigned-VM publication builds a seekable ZIP in an owner-only VM temporary
file using the existing required Python runtime. The execution plugin streams
that file over its authenticated SSH lease into an owner-only Gateway temporary
file while pinning the allocation identity and target revision and holding the
per-Agent target
mutation guard. Preparation is asynchronous because the private Admin RPC has a
15-second request deadline. Four plugin-owned `skillExport.begin`, `.status`,
`.read`, and `.close` methods expose only an Agent-bound random capability;
each raw chunk is at most 384 KiB and remains below the 1 MiB RPC envelope.
Control reconstructs the ZIP in its own owner-only temporary file, applies the
canonical 500 MiB / 1 GiB / 250 MiB / 100-entry validator, and streams the
result through the existing registry adapter. Completion, cancellation,
expiration, and Gateway shutdown clean up temporary archives. Credentials,
workspace paths, and archive bytes never cross the browser boundary.

The adapter must stay replaceable. Browser routes and UI models must not depend on
raw SkillHub response objects, internal URLs, tokens, storage paths, or database
identifiers.

Namespace authorization is behind the shared `OrganizationService` and
`AuthorizationService`. Skill Hub consumes
Global, real Team, Group, Part, direct/effective membership, and delegated
capability facts without reading organization tables or rebuilding lineage.
Skill Hub continues to own package and registry policy. See
[PlatformClaw organization architecture](/platformclaw/organization-architecture).

The Knox channel remains transport-only. It extracts a structurally valid final
command line and passes it to the shared command registry. The
`platformclaw-skillhub` plugin owns the `/skillhub` product command and calls the
control-plane-owned employee, ACL, catalog, and mutation boundary. Trusted
conversation context pins DM commands to the personal binding and group commands
to the registered room binding. The employee owns registry authorization; the
resolved conversation owns the workspace. Group catalog/install operations do
not inherit private employee grants. Room backend requests omit the personal
execution-target selector and reuse the existing room-aware target resolver and
mutation lock.

## Embedded deployment boundary

The registry runs on the same Linux server as PlatformClaw but remains a
private runtime component with its own health, persistence, and resource limits.
It is not copied into the Control UI and does not add SkillHub OAuth.

The implementation must use the existing PlatformClaw release archive and deploy
flow documented in [Build the PlatformClaw Jammy images](/upstream/jammy-build):

1. build and validate the exact PlatformClaw revision;
2. include the pinned registry runtime and its provenance in the existing release
   artifact set;
3. emit the existing archive checksum;
4. transfer and verify that one archive; and
5. load and start the PlatformClaw deployment as one versioned unit.

Do not create an independently versioned Skill Hub release archive or a separate
operator upgrade track. The existing transfer archive includes PlatformClaw,
sandbox, SkillHub server, scanner, PostgreSQL, and Redis images. The existing
deploy wrapper loads and starts them as one versioned unit.

## Registry inheritance

The integration is based on `iflytek/skillhub` tag `v0.2.16`, commit
`6e133c006e492dc3f468d91b21960aff1d577150`. Upgrades are explicit migrations,
never an automatic move to `main` or `latest`.

The managed server carries a pinned PlatformClaw source patch for catalog
metadata edits and namespace moves. The patch adds an administrator-only
management API, transaction-scoped edit receipts, and publication serialization.
It preserves registry skill/version IDs and package bytes. Scanner, PostgreSQL,
and Redis object images remain pinned. The server source archive, checksum,
patch, and attribution are kept with the existing runtime build inputs; the
modified server remains part of the same PlatformClaw transfer archive.

The upstream repository is Apache-2.0. Any copied or modified upstream source
must ship with the license, retain applicable copyright, patent, trademark, and
attribution notices, and mark modified files. The Apache license does not grant
trademark rights. Do not ship the upstream logo or imply iFlytek endorsement.
Individual built-in skills are not part of the registry-runtime inheritance and
must not be bundled merely because they appear in the upstream repository.

The release provenance must record the repository URL, tag, commit, license, and
the exact incorporated files or image. If PlatformClaw uses only the service API
and independently implements Lit UI, record that boundary without claiming that
the upstream portal was incorporated.

## Scan architecture

The scanner is asynchronous and version-specific:

1. accept and safely validate an immutable package;
2. place the version in pending scan state;
3. scan within bounded CPU, memory, time, and expanded-content limits;
4. store the authoritative result on that exact version;
5. publish automatically when no blocking result remains; or
6. allow an owner or administrator to force publication with a reason and audit.

LLM and VirusTotal integrations remain disabled. Scanner unavailability must
produce an explicit unavailable or failed state; it must not auto-publish or
silently call an external service.

The managed registry backports the upstream scan-task outbox into its pinned
server. Audit, version, and queued scan state commit together before Redis
delivery. Stable task IDs bind each result to its own audit; an older scan cannot
complete a newer scan. Contended duplicate deliveries stay pending for reclaim.
Existing pending scans migrate in PostgreSQL before normal consumers run.

## Data and lifecycle boundaries

Organization bindings, ownership, ACLs, scan-governance jobs, notifications, and
the unassigned queue use additive tables in the existing shared PlatformClaw
SQLite database. The change is backward-tolerable and does not bump the schema
version. PostgreSQL and the registry storage volume own canonical registry
metadata and package blobs. Edit intents retain request snapshots for recovery.

Metadata edits additionally record a durable intent in the shared SQLite store
before calling the registry. The intent reserves the source and destination
coordinates. A registry transaction changes metadata, relocates review scope,
updates search, and stores an idempotent receipt. PlatformClaw then atomically
rekeys ownership, ACLs, and governance jobs and records completion. Recovery
replays the same operation ID, so a lost registry response or a control-process
restart cannot duplicate a move. Concurrent ownership or policy drift persists a
separate privacy-recovery request while keeping both coordinates reserved. Its
immutable request replays after response loss; only a definitive revision conflict
allows a fresh snapshot and request ID. Ownership, ACL, and job relocation completes
only after the registry confirms requested and effective Private visibility, and
the result remains unassigned even if policy eligibility returns during recovery.
This visibility-only restriction also works in frozen or archived namespaces;
profile changes, moves, and broader visibility still require active namespaces.
Completed
receipts let an unchanged browser retry recover the result at the old coordinate.

The current control schema v3 organization migration rebuilt the managed
hierarchy and namespace-binding constraint. Existing `team` bindings with no
scope ID migrated to `global` with no scope ID; a real Team binding uses `team`
plus a managed Team ID. The migration preserved skill ownership, ACL, scan,
notification, and registry data and introduced no fallback reader or dual
write. That migration left Global bindings restricted until administrator
activation; those persisted restrictions remain effective. New Global bindings
start active, and all active employees may publish and own skills in active
Global namespaces. The managed allowlisted `global` binding is provisioned once
on first authenticated Skill Hub use if missing, without changing an existing
binding. Configuration projects the authorized Global default and each allowed
destination's scope so browser and Knox publication share the same default.
Namespace administration and other employees' skills remain protected by their
existing administrator and owner boundaries.

Employee-created namespaces reuse the registry's native namespace API through
the server-owned governance session. A dedicated additive SQLite creation ledger
reserves names and records each actor, authorized scope, opaque operation marker,
registry receipt, and completion. Exact-request recovery compares the recorded
marker with the native registry namespace description before accepting a remote
result. No existing namespace is adopted from its name alone. Successful
activation rechecks current scope authority and atomically commits the binding
and completed creation; only completed creations extend the process snapshot.
The bootstrap environment allowlist remains authoritative for other namespaces.

Package blobs are named product artifacts. Audit and lifecycle state belong in
the appropriate database owner, not JSON sidecars. Secrets remain in server-only
secret files or the existing credential boundary.

## Release gates

Each release must prove:

- the pinned runtime is built and attributed through the existing archive flow;
- fresh install, upgrade, backup, restore, and rollback preserve registry data;
- the browser never receives registry or Gateway credentials;
- current and expanded package limits pass malicious archive tests;
- organization and per-user ACL decisions are enforced server-side;
- forced publication is reasoned, audited, and visibly badged;
- inactive-owner reassignment and the unassigned queue are deterministic; and
- Basic and VM install tests prove no cross-target fallback or race.

## See also

- [Skill Hub product policy](/platformclaw/skill-hub-policy)
- [Operate Skill Hub](/platformclaw/skill-hub)
- [PlatformClaw architecture](/platformclaw)

Terminal scan delivery/execution failure is recorded on the current audit as `failedAt`,
separately from a completed scan. Published versions retain their publication fact and
immutable IDs/ZIP bytes during reinspection; failed rounds receive a new durable task
before a PRIVATE skill can broaden its audience.
