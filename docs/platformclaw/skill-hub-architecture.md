---
summary: "Canonical catalog, private registry artifacts, and workspace boundaries for PlatformClaw Skill Hub"
read_when:
  - Implementing Skill Hub storage, BFF routes, publishing, or installation
  - Reviewing organization sharing, runtime room checks, or retention
  - Validating the embedded registry deployment and migration
title: "Skill Hub architecture"
---

# Skill Hub architecture

The PlatformClaw control plane owns the employee-facing Skill Hub catalog and
its sharing policy. The embedded registry supplies immutable package artifacts
and version-specific scan results through the managed administrative client. Browsers use the
same-origin Lit UI and BFF; registry credentials and coordinates stay server-side.

See [Skill Hub product policy](/platformclaw/skill-hub-policy) for the approved
user contract and [Operate Skill Hub](/platformclaw/skill-hub) for setup.

## Runtime ownership

| Layer            | Responsibility                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| Browser          | Catalog, sharing selection, metadata, version selection, and visible outcomes                        |
| Control plane    | Current employee identity, stable IDs, sharing, ownership, receipts, retention, and safe projections |
| Registry runtime | Immutable package blobs, native versions, and scan evidence                                          |
| Gateway          | Canonical archive validation and Basic workspace mutations                                           |
| Execution plugin | Assigned-VM SSH export, transfer, atomic mutation, and target locking                                |
| Skill Hub plugin | Knox commands and tools, trusted conversation context, and per-run room policy checks                |
| Release tooling  | One PlatformClaw image archive, checksums, and deployment lifecycle                                  |

```text
employee browser
  -> PlatformClaw control plane
       -> canonical SQLite catalog and shared organization authority
       -> private registry adapter -> embedded registry artifacts and scans
       -> private Gateway upload/install path
            -> Basic workspace
            -> execution plugin -> assigned VM workspace
       <- bounded Gateway export <- execution plugin <- assigned VM
```

The registry listener, PostgreSQL, Redis, scanner, Gateway operator credential,
and VM SSH connection are private. Only the PlatformClaw web listener is exposed
to employees. Registry OAuth and its React portal are not embedded.

## Canonical identity and sharing

Each catalog entry has a stable UUID independent of its display name, package
slug, owner, and native coordinate. Equal names do not identify the same entry.
The UI shows display name and owner, keeps the UUID for links and requests, and
never asks users to create or choose a namespace.

New native artifacts are published privately under a server-owned coordinate.
Native `PUBLIC`, `NAMESPACE_ONLY`, and `PRIVATE` values are adapter data, not
employee permission levels. PlatformClaw exposes only `PUBLIC`, `SELECTED`, and
`PRIVATE` sharing. An existing native coordinate cannot be adopted by matching its
name; existing-version publication requires an explicit catalog ID and revision.

The canonical catalog stores owner, sharing targets, metadata, versions referenced
by publication receipts, deletion state, and transfer state. Shared organization
services resolve active identity and lineage. A user may select any active scope;
publishing does not require membership in that scope. Selected users and covered
organization members form a union. The owner retains access, while management
requires current owner or administrator authority.

An administrator acting on another owner's or unassigned entry supplies a bounded
reason. The transaction records the actual actor and reason. Reader projections
omit Selected recipient identities and management history. Authorized readers may
view ordinary version history; owners and administrators may also inspect
management events.

## Publication and concurrency

A request carries an operation UUID and a fingerprint of the artifact and relevant
parameters. SQLite reserves a new catalog identity or the exact existing revision
before the external registry effect. The service rechecks current employee,
workspace, ownership, and receipt authority after awaited work and immediately
before publication. Native results must match the reserved coordinate and exact
version before completion is recorded.

The private identity-reservation route accepts the server coordinate and catalog
operation UUID. It commits a Private native identity without uploading an archive
or creating a version. The control plane persists that ID before its first archive
POST. The managed-publication route then requires that immutable ID with the
original bounded ZIP. Its existing session and CSRF authority stay server-side.
A new reservation requires the original namespace creator and matching operation
marker; a retry may recover that exact reserved origin after principal rotation.
Existing updates match their known native ID. Archive publication uses the existing archive, manifest,
storage, locking, and durable scan-outbox owners. Heuristic findings do not block
publication. Existing native owner, metadata, visibility, and historical reviews
are preserved, and no native version may be overwritten. Employee sharing remains
the catalog's authority rather than a native visibility transition.

Native reservation and local binding precede every managed archive POST. A later
upload rollback therefore leaves a known immutable ID. A cancelled first entry
whose ID is still null never sent an archive; cleanup reconciles or reserves its
empty native identity, persists the binding, and uses the ordinary verified deletion
receipt. A known-ID lookup miss or unknown deletion receipt remains pending.
Existing managed updates and private artifact reads do
not inherit a retired namespace's publication ceiling or lifecycle restrictions.
An archived native Skill itself is never revived for publication; exact-ID physical
deletion remains available.

Metadata and versions use the same private administrative projection as artifact
export and scan evidence. The current service does not read or require a native
CLI token or use the registry portal's employee access policy. Deployment retains
the token artifact and mount solely for its existing image rollback contract:
Control at pre-cutover main `f4836f8e943f2c297b5e9c85bed8a89a553789ee` requires it.
Remove that deployment compatibility path when the supported downgrade floor
excludes such images. No second employee authorization or artifact reader remains.

Unchanged retries recover the same receipt. Changing the workspace skill, source,
version, sharing, or existing entry creates a new client operation UUID. A pending
publication is visible and may be retried from its original source or cancelled.
The source fingerprint uses the server-resolved Basic or saved-VM target ID, or
the ZIP-upload source. Allocation IDs, execution revisions, and credential revisions
are current authority checks, not artifact intent: reactivating the original saved
VM permits the same request and bytes to recover without adopting another VM.
Background reconciliation may complete a receipt only after the exact native
publication is verified. Cancellation does not claim to undo an already transmitted
registry artifact. Cancellation joins the publication lock, rereads the receipt,
and reconciles a verified committed version before rejecting cancellation of that
completed result. Completion records the historical committed fact even if its
original actor has since been disabled; it grants no new publication authority.
Two durable SQLite cursors advance publication recovery and cleanup batches before
external work, so persistent early failures cannot starve later entries after a
restart. A missing native row without a verified whole-deletion receipt remains an
unknown cleanup outcome.

Metadata, icon, sharing, Trash, restore, and ownership operations use a catalog
revision. Editing metadata does not mutate native package bytes or create a
version. New-version publication preserves metadata and sharing; explicit sharing
changes use the metadata path. An existing version cannot be overwritten.
Ownership transfer requires recipient acceptance at the expected revision.
There is one editor role, the owner, and no automatic content merge.

## Basic and assigned VM paths

The chosen publication source and installation destination are independent of
the active work location. No path silently copies to, mirrors, or falls back to
the other workspace. Execution profile revision and allocation identity are pinned
and revalidated under the existing per-Agent target mutation guard.
There are still two source choices: Basic and the currently assigned VM. A saved VM
that is inactive is not an arbitrary additional upload or installation destination.
The workspace inventory identifies its stable target and current revision and shows
the VM label. Browser actions carry the inspected target ID; a different current VM
rejects the action before publication or installation effects. Installation may also
pin the inspected execution revision.

Basic publication packages the actual personal `skills/<slug>` directory. It
validates physical paths and `SKILL.md`, writes the requested version only into
the temporary archive, and preserves workspace files.

Assigned-VM publication creates a seekable archive in an owner-only VM temporary
file using the existing Python runtime. The execution plugin transfers it over
its authenticated SSH lease into an owner-only Gateway temporary file while
holding the target guard. Preparation is asynchronous. The plugin-owned
`skillExport.begin`, `.status`, `.read`, and `.close` RPCs expose an Agent-bound
random capability; each raw chunk is at most 384 KiB, below the 1 MiB RPC envelope.
Control reconstructs and validates a bounded private temporary ZIP, then streams
it through the same registry adapter. Completion, cancellation, expiry, and
Gateway shutdown clean up owned temporary archives.

Installation downloads the exact native version, validates it, and uses
`skills.upload.begin`, `.chunk`, `.commit`, then `skills.install`. The Gateway
owns extraction and Basic mutation. The execution plugin stages an approved tree
under the VM workspace, validates it, locks the skill directory, and replaces it
atomically. Basic and VM paths keep sibling staging and backup directories so a
failed commit can restore the previous tree.

Physical directory names identify installation collisions; frontmatter aliases
cannot select a sibling directory. Replacement requires the current installed
revision, including equal version text. Durable provenance records the Hub ID,
version, Agent, destination, archive hash, operation, and verified installed
revision. Equal slugs alone never prove that a requested Hub entry is installed.
Installation provenance is keyed by Agent, destination, stable target ID, and slug.
Basic and rooms use `platform-server`; assigned VMs use the canonical saved-connection
ID. Switching away and back creates a new allocation but retains that VM's origin.
Another VM's same-name local copy cannot inherit, overwrite, or delete that origin.

An uncertain install remains pending. A local `SKILL.md` revision is not proof of
an unchanged complete package tree. Status may explain the pending outcome, but
must not silently complete provenance or force a reinstall. A user reviews and
explicitly confirms a replacement before another mutation.

## Room execution boundary

Knox remains transport-only. Its Skill Hub plugin passes current sender,
relay-account, conversation, Agent, and session facts to the control plane. DMs
resolve the employee's personal Agent; rooms resolve their registered room Agent,
never the sender's personal VM. Room package publication is unavailable.

Room search and installation admit only currently Public Hub entries. A room
installation records Hub provenance. Before each subsequent run, the plugin sends
bounded candidate paths to the service-authenticated room policy endpoint. The
runtime preserves each candidate's original source path when materialization
renames or remaps its readable path. The control plane matches that source only
against the installed package in the admitted room's canonical workspace;
unrelated local, bundled, and node skills do not acquire Hub provenance from a
matching name or folder basename. It checks current sharing, deletion, installed
version blocks, and the active room binding again after asynchronous scan reads.
All installed room origins participate, including disabled or malformed skills
that are absent from discovery. Explicit denied source directories receive
read-only empty-directory overlays in both Docker and the filesystem bridge.
Mount sources and destinations share canonical workspace coordinates so ancestor
aliases cannot expose a second path or a custom bind around an exclusion.
Ordinary local skills, README files, and source bytes remain unchanged. A missing
source is recorded as absent and checked again before run admission. A later
permission change requiring an unprepared overlay stops the run before model or
tool execution. An old hot container with a different overlay plan is rejected
through the existing current-config gate without terminating running work.
Native CLI skill projections recheck their selection after queue admission and
backend staging, immediately before launch. A newly denied selection stops the
run and cleans its temporary projection; policy errors do not consume model fallbacks.
Excluded paths are
removed from run skill context and loading, including saved copies. Personal
copies remain independent. Existing runs and results are not recalled.

When Skill Hub is disabled, known active personal Agents retain their ordinary
local skills. Room and unknown-Agent checks fail visibly because their Hub access
cannot be established. An unavailable policy check must not silently load room
Hub content.

## Archive and scanner boundaries

Canonical limits are 500 MiB compressed, 1 GiB expanded cumulatively, 250 MiB per
entry, 2,000 entries, and 256 KiB of retained `SKILL.md`. Browser ZIP upload streams
to an owner-only temporary file with a running byte cap rather than assembling a
500 MiB upload in memory. Every entry is checked while decompressing; central
ZIP sizes are not trusted. Traversal, absolute or drive-qualified paths,
symlinks, junction escapes, hard links, and reserved runtime content remain
blocked. `.env` files may contain nonsecret defaults; actual deployment secrets
use the credential owner.

The scanner is asynchronous, bounded to ten minutes, and version-specific.
Heuristics, extension warnings, suspicious commands, incomplete scans, and
scanner outages remain visible without blocking an otherwise valid package.
A confirmed malicious hash finding blocks its exact version durably, without
an owner or administrator override. A later outage does not clear that block.
LLM and VirusTotal services remain disabled unless separately approved.

Native installability and PlatformClaw scan policy are separate facts. A package
that the native registry cannot yet supply is not reported as downloadable merely
because its scan is nonblocking. The managed artifact API reads the original
stored bundle across native `SCANNING` and `SCAN_FAILED` states, with confirmed
malware and missing or yanked artifacts remaining blocked.

## Storage and retention

Additive catalog, publication, history, icon, version-block, and installation
provenance tables use the existing shared SQLite database without a schema-version
bump. They are the runtime policy owner. Legacy namespace, ceiling, and per-user
grant records are migration inputs only; there are no ongoing dual writes or
fallback permission readers. Notifications remain persistent, generic lifecycle
messages rather than copies of skill descriptions or package content.
Existing legacy room-install audit facts normalize once to the Basic target and
remain pending until verified. Legacy personal VM audit facts lack a stable physical
target identity and are not assigned to whichever VM happens to be current. Their
independent local copies require explicit verified installation to acquire new
catalog provenance. The catalog installation table is new in this cutover; no older
catalog schema or parallel runtime reader is retained.

The one-time cutover enumerates the managed registry and recorded legacy
coordinates, preserving native IDs, versions, package bytes, owner facts, and old
links. Each eligible nondeleted entry receives Public sharing once. The migration
marker commits only after inventory is complete. Later user restrictions survive
restarts. Deleted content and confirmed malicious blocks are not revived.

Trash prevents reads and downloads immediately. For 30 days the owner or an
administrator may restore the same ID and recorded settings. After that, cleanup
marks the entry pending, verifies the native identity, requests permanent removal,
and only records completion after confirmed deletion. Failed cleanup leaves
content inaccessible and exposes a maintenance outcome. Local metadata, icons,
version state, and content-bearing history must be purged with the artifact.
Minimal actor/action/time/version audit facts remain for one year after purge,
then expire. Independent backup retention remains an operator responsibility.

## Deployment and provenance

The embedded integration is pinned to `iflytek/skillhub` tag `v0.2.16`, commit
`6e133c006e492dc3f468d91b21960aff1d577150`. Dependency upgrades are explicit
migrations, not an automatic move to `main` or `latest`. The managed source patch,
source archive checksum, scanner outbox behavior, and image provenance remain
part of the existing runtime build inputs. PostgreSQL, Redis, and scanner images
remain pinned. Retired metadata-move and safe-only approval endpoints do not
become the canonical catalog policy.

The inherited source is Apache-2.0. Keep applicable license, copyright, patent,
trademark, attribution, and modification notices. Do not ship the upstream logo
or imply endorsement. Built-in upstream skills are separate content and are not
bundled merely because the runtime is integrated.

Use the existing PlatformClaw image archive, checksum, transfer, image load, and
deployment wrapper. The same artifact set contains PlatformClaw, sandbox,
SkillHub server, scanner, PostgreSQL, and Redis images. There is no separate Skill
Hub release archive or independent operator upgrade track. See
[Build the PlatformClaw Jammy images](/upstream/jammy-build).

## Release validation

A release must retain exact-revision evidence for:

- ordinary users without organizations publishing Public by default;
- Private and Selected access, another Part selection, reader history projection,
  owner-only writes, and reasoned administrator operations;
- one-time legacy cutover, preserved links and native versions, and persistent
  user restrictions after restart;
- duplicate names, explicit existing IDs, immutable versions, and lost-response
  publication receipts;
- Basic and VM workspace publication, ZIP upload/download, target races, and
  exact-version installation with verified provenance;
- warning and unavailable scans remaining usable, confirmed malware blocks,
  and room access revocation before later runs;
- Trash restore, expired cleanup, minimal audit retention, and backup restoration;
- browser credential isolation, archive attacks, pinned image provenance, and the
  existing archive/checksum/load/upgrade/rollback flow; and
- real browser screenshots of the ordinary-user workflows.

Local Linux runtime validation covers byte-identical downloads across synthetic
legacy `SCANNING` and `SCAN_FAILED` states through the actual managed artifact
API and ordinary employee catalog. It also covers expired Trash through the
actual deletion owner: stored bundles, indexed files, and seeded pre-upgrade
unindexed objects disappear while sibling artifacts remain intact. A completed
receipt alone does not replace inspecting storage. Historical malware blocking
uses harmless synthetic findings, not an external VirusTotal verdict.

Keep fresh evidence for the exact release candidate. Production backup recovery,
packaged upgrades, and credentialed S3 behavior retain their separate operational
proof requirements; local fixture results do not establish those outcomes.
