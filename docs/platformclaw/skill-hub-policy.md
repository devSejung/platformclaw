---
summary: "Approved sharing, ownership, package, and retention rules for PlatformClaw Skill Hub"
read_when:
  - Publishing, sharing, updating, transferring, or deleting a company skill
  - Implementing or reviewing Skill Hub access and lifecycle behavior
  - Reviewing package validation, scan warnings, or migration policy
title: "Skill Hub product policy"
---

# Skill Hub product policy

Skill Hub lets active company users share reusable Agent skills. A new skill is
**Public** unless its publisher chooses another audience. Public means every
active, signed-in company user, including a user with no organization membership.
It does not expose skills anonymously on the internet.

This is the approved product contract. See
[Release validation](/platformclaw/skill-hub-architecture#release-validation)
for the required runtime and upgrade proof.

## Choose who can use a skill

| Sharing choice                    | Who can find, read, and download the skill                                  |
| --------------------------------- | --------------------------------------------------------------------------- |
| Public                            | Every active company user                                                   |
| Selected people and organizations | Any selected user, or a current member covered by any selected organization |
| Private                           | The owner, with the administrator operating exception below                 |

A publisher may select **any active Team, Group, or Part**, including one they do
not belong to. Selecting a Team includes its Groups and Parts; selecting a Group
includes its Parts. User and organization selections form a union. A selected
organization follows its current active membership and lineage. The owner always
retains access. An empty Selected audience must be corrected or changed to Private.

A primary organization does not change the Public default. Being a reader,
organization member, or organization leader does not make someone a skill editor.
Organization sharing does not create a new membership or leadership role.

Sharing applies to every retained version of that skill. Narrowing the audience
immediately affects later Hub searches, reads, downloads, and room runs. Existing
personal downloads and their local edits are not recalled or deleted.

## One owner manages the skill

Every skill has one accountable owner. The owner may:

- edit its display name, description, icon, tags, and sharing;
- publish a new immutable version;
- move it to Trash or restore it within the recovery period; and
- offer ownership to another active user.

There are no coauthors, shared editing roles, automatic merges, or editable
package versions. People can exchange files outside Hub; whoever publishes an
update is recorded as its publisher. Hub does not infer who authored files before
upload.

Ownership changes only when the selected recipient accepts. The existing owner
keeps editing rights until acceptance; afterward the recipient owns the skill and
the former owner has only the access granted by its sharing settings. Pending
requests carry a revision so another edit or transfer cannot be silently overwritten.

Disabling an owner blocks that account from managing skills. Existing published
skills keep their current audience and remain usable. An administrator explicitly
assigns a replacement owner; the system does not silently choose a leader or an
arbitrary employee. Leaving an organization alone does not remove ownership.

Administrators may inspect skills for operations. Using administrator authority
to change another owner's or an unassigned skill requires a nonempty reason,
recorded with the actual administrator and action. An administrator accepting an
ownership offer as its named recipient follows the same rules as any other
recipient. Administrator access does not make a Private or Selected skill eligible
for a shared room.

## Publish and update

New publication creates a stable skill ID. Equal names are allowed; the display
name and owner help users distinguish entries. A matching package name never
claims or overwrites another entry. To release another version, explicitly select
the existing owned entry or use its management section.

A new version preserves the existing ID, owner, icon, description, tags, and
sharing. Released package bytes and version numbers are immutable. To revert
content, publish the desired files under a new version. Installed personal copies
update only when their user chooses to replace them.

Metadata and sharing changes do not create package versions. They use the current
revision; a stale edit fails visibly and retains the draft for review. Reload the
latest entry before retrying. No automatic merge is attempted.

A publication has an operation ID. Retrying an unchanged request recovers the same
publication rather than creating another entry. An uncertain result remains
visible as pending; retry the original request or cancel it before starting over.
Cancelling pending bookkeeping cannot recall a package already transmitted to the
private registry.

## Describe the skill

| Field        | Rule                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| Icon         | Default icon, or PNG, JPEG, or WebP up to 2 MiB                                         |
| Display name | Editable catalog title; the package name remains fixed                                  |
| Description  | Initially taken from `SKILL.md`; later catalog edits are independent of package content |
| Tags         | Optional, up to five tags, with up to 32 characters per tag                             |

Icons and other metadata obey the same read and management permissions as the
skill. Uploading a new version does not reset an edited description or tag list.

## Scans explain risk

Show the scan result for each exact version:

- **Scan passed**: the available completed scan reports no findings.
- **Warnings**: heuristic findings, suspicious commands, or file extensions need
  attention; valid packages remain publishable and downloadable.
- **Not verified**: scanning has not completed or is unavailable; a valid package
  remains usable, with that state visible.
- **Malware blocked**: a confirmed malicious-file finding blocks the affected
  version. There is no owner or administrator override.

Malformed packages, unsafe paths, invalid manifests, and content that cannot be
installed are rejected regardless of scan status. Native severity labels alone do
not establish confirmed malware. A later confirmed malicious result remains
blocked even if the scanner subsequently becomes unavailable. Other clean
versions are evaluated separately.

LLM and VirusTotal integrations remain off unless separately approved. Scanner
failure does not silently enable an external service or expose package contents.
The permissive warning policy does not bypass authentication or archive safety.

## Basic and VM workspaces stay separate

The Basic server and assigned VM are independent sources and destinations. Users
choose the source for workspace publication and the destination for installation.
Neither operation switches the active work location, mirrors files, or falls back
from an unavailable VM to Basic. ZIP upload and exact-version ZIP download are
also available.

With multiple saved VMs, the VM source and destination refer to the VM currently
connected to the Agent. Choose another saved VM in Work location settings before
accessing its skills. Each VM keeps its own installed files. Returning to a VM
shows that VM's downloads, even when another VM uses the same package name.
The UI names the VM being used and checks the selected workspace before a
publication or installation proceeds.

An existing physical package name requires a revision-bound replacement
confirmation, including when its version text matches. Durable Hub ID and version
provenance distinguish an installed Hub entry from another entry with the same
name. An unknown installation outcome requires review and explicit replacement;
the system must not automatically force another install over local edits.

VM export and installation use the existing server-owned SSH and Gateway paths.
Skill Hub requests carry workspace choices and opaque target IDs, rather than SSH
credentials, private export paths, or VM leases. Work location settings keep their
existing authorized connection details.

## Shared rooms use Public Hub skills

For this release, room searches, installation, and later use admit only Public Hub
skills. Private and Selected sharing cannot be used in rooms, even by their owner
or an administrator. Publishing is a personal-workspace action.

Saved room copies are checked again before each run. Narrowed sharing, Trash, or
a confirmed malicious installed version excludes that Hub skill from subsequent
room use. Work already running, existing results, and personal downloaded files
are not recalled. Local room skills without Hub provenance keep their existing
room policy; this rule does not invent a Hub identity for them.

## Trash and recovery

Moving a skill to Trash hides it immediately from readers and prevents further
Hub downloads and room use. Existing personal copies remain independent.

The owner or an administrator can restore it for **30 days**. Restore preserves
its stable ID, links, versions, metadata, owner, and sharing choices. Only current
valid users and organizations contribute access. An archived organization never
causes the skill to become Public automatically.

After 30 days, cleanup must permanently remove package blobs, versions, icons,
and description content. Deletion remains unavailable and marked pending until
the registry confirms cleanup. A failed cleanup is visible and retryable; it is
not reported as successful physical erasure.

Backups have a separate operator retention policy. Restoring an old backup must
reapply expiry and purge policy before making content available again. The
30-day policy does not assert that independent historical backups have been erased.

## History and notices

Authorized readers can inspect ordinary version history, including who published
a version and when. Owners and administrators can also inspect management
history. Retain actor, action,
time, exact version when relevant, and administrator reason throughout the active
skill lifetime and its Trash recovery period. Readers do not receive management
history or the identities of other Selected recipients.

After permanent deletion, retain only minimal audit facts such as actor, time,
action, and version identifier for **one year**, then delete them. Do not retain
package contents, descriptions, or icon bytes in history or notification records.
Notifications use generic lifecycle text rather than retaining deleted skill
content. External email and chat delivery are outside this release.

## Existing skills

At cutover, convert existing nondeleted skills to Public once. Preserve their
stable IDs, links, owners, immutable versions, and package bytes. Do not restore
previously deleted skills or unblock confirmed malicious versions. After cutover,
a user's later Private or Selected choice must survive restart; conversion is not
a recurring default repair.

Namespaces, namespace ceilings, separate per-version user grants, force-publish
controls, and organization eligibility for ownership are retired product policy.
Native registry coordinates remain private adapter details and old-link resolution
inputs, not choices presented to users.

## Package limits

The package ceiling is 500 MiB compressed, 1 GiB expanded in total, 250 MiB per
entry, and 2,000 ZIP entries. `SKILL.md` must be valid and match the physical
package name; its retained manifest is limited to 256 KiB. Do not trust ZIP size
metadata. Reject traversal, absolute and drive-qualified paths, symlink or
junction escapes, hard links, and reserved runtime or credential content.

`.env` and `.env.*` are allowed for nonsecret runtime defaults. Deploy-time secrets
belong in the existing credential surfaces. Publication and installation retain
the canonical Gateway archive checks. See
[Operate Skill Hub](/platformclaw/skill-hub) for setup and troubleshooting.
