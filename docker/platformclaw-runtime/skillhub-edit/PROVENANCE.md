# SkillHub published metadata edit

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
upstream.patch, and overlay production files (excluding paths containing /test/),
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
