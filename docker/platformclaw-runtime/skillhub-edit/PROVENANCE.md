# SkillHub managed artifact policy and metadata support

This directory contains the approved private patch to SkillHub v0.2.16,
commit `6e133c006e492dc3f468d91b21960aff1d577150`.
Upstream: <https://github.com/iflytek/skillhub>.
Upstream license: Apache License 2.0; the upstream source archive's LICENSE
is retained in the build source and copied here as LICENSE.upstream.

The Dockerfile verifies the source archive SHA-256 and builds Java 21 source.
`upstream.patch` applies reviewed production changes to existing upstream modules;
`upstream-tests.patch` adapts the retained upstream test fixtures.
`overlay/` supplies the new service, HTTP transport, receipt entity,
and additive PostgreSQL migration. No original source is replaced at runtime.

Published slugs, numeric IDs, version identities, and package bytes are retained.
The following metadata-edit behavior describes the retained administrative
transport from the earlier integration. It is not the employee sharing policy;
the canonical catalog uses only the managed artifact API described below.
The administrative session API edits display name, summary, visibility, and
namespace. Explicit presentation metadata survives later version publication;
publication with conflicting or pending visibility fails with HTTP 409. Desired
and effective visibility are separate: broadening a private audience prepares
every eligible private release for scanning and review while actual access stays
private. Previously approved shared releases reuse their recorded decision.
Unscanned stored releases use the deployed upload-mode scanner's immutable bundle
path; unsupported scanner configuration rejects the edit.
Failed private scan rounds start fresh durable stored-bundle tasks before sharing;
an unfinished historical audit cannot stand in for a runnable task. If every
release is rejected, yanked, or draft-only, sharing returns HTTP 422 and directs
the operator to publish a new Private version before retrying.
Native administrative
approval retains the explicit force path for completed non-SAFE results, and
rejects in-progress scans. Namespace locks
serialize publication and relocation. Successful requests have durable receipts
for replay after a network failure. Search and pending review namespace changes
commit with the receipt; completed reviews retain their historical namespace.

The existing asynchronous search writer keeps its REQUIRES_NEW transaction
boundary (upstream fix de033da5). The new edit path explicitly uses the same
projection and writer inside the edit transaction.
The asynchronous writer also rechecks canonical aggregate facts under the same
namespace lock, preventing an older prepared document from undoing a later edit.

The administrative exact-version review resolver selects the unique pending
review or latest approved decision, without paging through unrelated history.

The scan task outbox is a bounded backport from official SkillHub v0.2.18,
commit `b896c698cde8e50e58023bb80eb1004bcf67fdd5` (annotated tag
`06c0e4d5affd72d14bbd98a0522287f3712067ec`). Its downloaded archive SHA-256 is
`ab9f119aaf8bd92558b83aee068de50b0c8dc92c398fc8c00b82249ea0ac7269`.
The retained slice comprises ScanTaskOutbox, its repository/status/dispatcher,
SecurityScanService audit/task binding, ScanTaskConsumer stable identity, and
upstream PostgreSQL V44/V45 migrations. The base remains v0.2.16.

The downstream removes the test-only nullable outbox constructor/fallback.
All scan triggers persist an audit and durable task in the same transaction;
Redis delivery occurs from committed outbox rows, with stable task IDs for crash
replay. Additional owner fixes bind success/failure to the exact current audit
under a version lock, defer contended Redis messages without consuming retries,
and give local scan rounds separate task directories. Namespaced repeatable SQL
repairs v0.2.16 pending scans, including published administrative autoscan rounds,
into durable immutable-bundle tasks before consumers start. Obsolete Redis task
IDs are logged and skipped. Completed legacy audit history remains unchanged.

The upstream outbox defaults are retained: batch size 50, maximum 10 attempts,
lease 2 minutes, maximum backoff 5 minutes, dispatcher interval 5000 ms, and sent-row
cleanup after 7 days at 02:20 daily. No PlatformClaw environment options are added.
The private atomic approve-safe route checks current completed SAFE audits while
holding the version lock through the existing native approval transaction;
explicit administrative force approval retains its original endpoint.

Shipping image tags concatenate the first 12 upstream commit hex characters with
the first 12 SHA-256 hex characters of the patch inputs. Inputs are Dockerfile,
upstream.patch, artifact-policy.patch, and overlay production files (excluding paths containing /test/),
sorted by relative POSIX path. Each input contributes UTF-8 path, NUL, UTF-8 file
content normalized to LF, and NUL. Tests, provenance, license, and Python proof
are excluded. The runtime contract test recomputes the tag to catch stale tags.
Existing deployments upgrade only the exact former bundled server reference
when applying a complete new bundle; custom references and explicit opt-out stay
operator-owned. Image and PostgreSQL rollback restore a matching server pair.

Policy drift recovery reserves both coordinates until a separately receipted
Private edit confirms canonical desired and effective visibility. Same-coordinate
Private restriction with unchanged canonical display name and summary remains
available in frozen or archived namespaces; general profile edits, moves, and
visibility broadening retain the active-namespace gate. A later native approval
uses the managed desired Private visibility and cannot undo this restriction.

Native replay receipts bind the exact canonical request body independently of the
current trusted administrative login, so service-principal rotation does not
misclassify an already committed operation as a rejected request. The original
actor remains in the immutable audit; regular users cannot access this transport.

Terminal scan failures are recorded on the exact audit as `failedAt`, separately
from successful scan completion. A published background scan keeps its released
version available; later sharing starts a fresh durable task for a failed audit.
The namespaced repeatable migration repairs unfinished audits whose matching
outbox delivery already failed. Completed and superseded audits retain history.
Publication checks use recorded `publishedAt` as well as current status, so review
transitions cannot make an immutable release replaceable. Managed coordinates
also retain historical publication ownership while native unedited private owner
isolation remains intact. Every existing skill changes audience through the
metadata workflow, preventing a new version from exposing older private releases.
New publications retain pending reviews of historical managed releases prepared
by an audience edit; withdrawing a never-published draft keeps its native flow.

## Managed artifact policy API

The approved `artifact-policy.patch` adds the server-owned administrative artifact
contract while retaining upstream immutable skill/version IDs and ZIP objects.
The new session-authenticated SUPER_ADMIN transport is:

- POST `/api/v1/admin/platformclaw/skills/identities`, with JSON `namespace`,
  `slug`, and `publicationId`: commit a Private Skill row and its unique opaque
  origin UUID in an independent transaction. This lightweight reservation creates
  no package version, object, or scan task. New reservations require an empty coordinate in an active
  service-created `pc-<UUID>` namespace with its matching operation marker.
  Its original creator must make the first reservation.
  A retry can recover only that exact reserved origin and coordinate, including
  after service-principal rotation; it cannot adopt an unmarked native row.
  The control plane persists the returned immutable ID before its first archive POST.
- POST `/api/v1/admin/platformclaw/skills/publish`, with the original multipart
  ZIP, `namespace`, and required `expectedSkillId`: publish through the retained
  archive, manifest, preflight, immutable-version, object-storage and scan-outbox
  pipeline. The upload transaction requires the separately reserved ID and never
  creates an identity automatically.
  Rolled-back version rows therefore leave a discoverable Skill ID whose whole
  object prefixes can be physically cleaned. Updates require the
  exact immutable ID and coordinates, retain the existing native owner, metadata,
  visibility and historical reviews, and never replace an existing version.
  Valid heuristic warnings do not require a separate confirmation. A new
  entry starts as a Private artifact; exact-ID updates of imported native PUBLIC
  entries preserve their existing visibility and history. Employee sharing remains
  owned by the canonical catalog. The original ZIP is streamed into its immutable bundle
  object without reconstruction. The domain boundary independently checks
  SUPER_ADMIN authority and the 500 MiB compressed bound.
- GET `/api/v1/admin/platformclaw/skills/coordinates/{namespace}/{slug}`, with
  optional `expectedSkillId` or `expectedPublicationId`: read an unambiguous
  artifact identity and its metadata through the private owner. The origin check
  permits secure recovery of a failed first upload without guessing or adopting
  another coordinate. This projection includes a reserved row without versions
  and does not depend on the service principal owning it or joining its namespace.
- GET `/api/v1/admin/platformclaw/skills/{skillId}/artifact/versions`, with
  expected `namespace`, `slug`, `page` and `size` (1–100): read immutable version
  metadata by exact skill identity. Download authorization still comes from the
  historical-security and original-artifact gates, not this metadata projection.
- GET `/api/v1/admin/platformclaw/skills/{skillId}/versions/{versionId}/artifact`
  with expected `namespace` and `slug`: stream the original bounded ZIP object;
  no reconstructed or partial per-file fallback is used.
- GET the same version prefix plus `/security-audits`, with expected coordinates,
  `page`, and `size` (1–100): return all historical rounds, total count,
  `artifactAvailable`, and `blocked`. Superseded or soft-deleted rounds remain
  evidence of an immutable artifact's confirmed malware status.
- DELETE `/api/v1/admin/platformclaw/skills/{skillId}/artifact`, with expected
  coordinates: reserve a durable whole-artifact deletion before metadata removal.
- GET `/api/v1/admin/platformclaw/skills/{skillId}/artifact-deletion`: return the
  immutable-ID receipt as pending or completed with its completion timestamp.
  HTTP 404 means unknown; it never establishes deletion completion.

Native namespace lifecycle gates remain for fresh reservations and ordinary native
publishers. Exact-ID managed updates and private artifact reads do not inherit
retired namespace restrictions. An archived native Skill still cannot be published
or silently revived. Physical deletion permits inactive rows after the same exact
ID, coordinate and namespace-first lock checks; otherwise a historical archive
could never be erased. Public portal ACLs remain unchanged.

The additive nullable `platformclaw_managed_publication_id` column and unique index
are the native reservation origin; older rows remain unmarked. No schema-version
bump or second runtime identity store is introduced. PlatformClaw persists any
recovered registry ID before deletion so a lost response can still be reconciled
through the immutable-ID receipt. In the new catalog, a null native ID means no
managed archive POST was sent. Cleanup first reconciles or reserves that empty
identity by its original UUID, persists the binding, and uses the normal verified
whole-artifact deletion. A known-ID lookup miss or unknown receipt remains visibly
pending rather than being reported as physical erasure.

The artifact gate accepts safely stored, non-yanked versions independent of native
review and scan-pending/failure state. It checks bundle/download readiness, stored
original object presence, and the 500 MiB bound. Actual ZIP integrity and structure
remain checked by the consuming PlatformClaw archive owner. Every historical
`VIRUSTOTAL_MALICIOUS_FILE` finding from analyzer `virustotal`, category `malware`,
and a valid SHA-256 `file_hash` blocks that version. Heuristic severity or a generic
native BLOCKED verdict alone never proves confirmed malware. This does not enable
VirusTotal, LLM scanning, or any new external service.

The existing storage-compensation owner now records cleanup before metadata
removal for whole skills and partial versions. The additive repeatable migration
adds `platformclaw_whole_skill` with false default, so historical partial-cleanup
rows cannot be mistaken for proof of a whole artifact's deletion. No schema-version
bump is introduced. A whole deletion includes pending older-version object keys.
Only successful deletion followed by absence checks clears keys, names, and errors
and completes the receipt. Incomplete cleanup survives a crash and uses the existing
scheduled retry. Completed receipts retain immutable ID/timestamps for one year,
then are removed. Existing deployments' absent artifacts without a whole-delete
receipt remain explicitly unknown.

`artifact-tests.patch` adapts the retained cleanup-owner tests to pre-effect durable
registration. Overlay tests cover administrative auth/session/CSRF, exact identity,
original-object export across scan/review states, paginated historical malware,
missing/yanked objects, pending and unknown deletion receipts, and content erasure.

The S3 cleanup adapter batches at most 1,000 keys and rejects per-key errors even
when the service returns HTTP 200. Missing keys remain idempotent success. This
follows the [official DeleteObjects contract](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html)
and is covered through the pinned AWS SDK request/response types without external
credentials. Storage absence is still verified by the cleanup owner before any
whole-artifact receipt completes.

Whole-artifact cleanup also enumerates the exact `skills/<skillId>/` and
`packages/<skillId>/` prefixes. This catches historical, unindexed objects left
behind by a crash before metadata committed. Each pass drains at most 20 pages
of 1,000 keys per prefix, then checks that both prefixes are empty. Partial-version
cleanup does not enumerate or delete a whole skill prefix. Local storage rejects
symlink traversal and preserves sibling skill IDs.

S3 deployments need `s3:ListBucket` permission constrained to those artifact
prefixes and `s3:GetBucketVersioning`, in addition to the existing object
read/write/delete permissions. Physical completion requires a never-versioned
bucket: Enabled, Suspended, unknown, or unreadable versioning states leave
cleanup pending. A delete marker cannot establish physical erasure of prior
object versions. See the [official version deletion contract](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html).
Missing listing permission leaves cleanup visibly pending; it cannot produce a
completed deletion receipt. S3 behavior is validated against pinned SDK types
and request/response fixtures. Actual object-removal runtime proof uses the
bundled Local storage provider; no credentialed S3 proof is claimed.

Physical completion also removes retired native metadata-edit replay receipts
that contain descriptions, using their exact immutable skill ID. Native skill
audits lose payloads and transport details at completion; only minimal identity,
actor, action, and time remain. The existing cleanup owner's one-year expiry
removes those audit facts with the whole-artifact receipt. Namespaced PostgreSQL
triggers bind both effects to the durable receipt transaction and backfill already
completed deletions without resetting their completion time. Partial-version
receipts do not authorize whole-skill history erasure.
Whole completion and repeatable backfill also clear historical completed
compensation names, object keys, and errors for that exact skill ID. They retain
the original timestamps and preserve unrelated skills and pending cleanup records.
