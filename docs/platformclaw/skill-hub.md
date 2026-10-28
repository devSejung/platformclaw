---
summary: "Publish, share, download, and operate company skills through PlatformClaw Skill Hub"
read_when:
  - Publishing a workspace skill or uploading a ZIP
  - Installing an exact version into Basic or an assigned VM
  - Configuring or troubleshooting the embedded Skill Hub service
title: "Skill Hub integration"
---

# Skill Hub integration

Use Skill Hub to share a skill with the company, choose specific people or
organizations, or keep it Private. Any active user may publish, including users
without an organization. New skills default to **Public**, which means active
company users rather than anonymous internet access.

The same Skills and Skill Hub pages support Basic and assigned-VM workspaces.
Each destination has its own installed copies. See
[Skill Hub product policy](/platformclaw/skill-hub-policy) for the complete user
contract and [Skill Hub architecture](/platformclaw/skill-hub-architecture) for
storage, runtime ownership, and outstanding release proof.

## Publish a workspace skill

1. In **Skills**, choose the work location and select **Publish workspace skill**
   for a skill from that personal workspace. Alternatively, open **Skill Hub**,
   select **Publish workspace skill**, choose **Basic workspace** or **My VM
   workspace**, and select a discovered skill.
2. Choose **New skill**, enter the version, and keep **Public** for normal company
   sharing. To limit access, choose **Selected people and organizations** or
   **Private**. You may select another organization's Team, Group, or Part.
3. Select **Publish** and check the completion or pending result.

There is no namespace choice or organization-membership prerequisite. A new
publication receives its own stable ID even when another owner uses the same
package name. Use the display name and owner to distinguish equal names.

Publication packages the selected physical `skills/<slug>` directory without
switching the active work location. `SKILL.md` requires valid YAML frontmatter,
a name matching the package directory, and a nonempty description. The chosen
version is written into the temporary archive; the workspace file stays unchanged.
VM publication exports over its existing server-owned SSH path. It does not
require a browser attachment or a manual copy into Basic.

Use **Upload ZIP** to publish a local package instead. The archive must contain
a root `SKILL.md` with the requested package name and version. Browser ingress
streams the ZIP to a bounded private temporary file. Publication and installation
apply the same archive safety rules.

If a response is uncertain, retry the unchanged form. Its operation ID recovers
the original publication. Changing skill, source, version, or sharing starts a new
request identity. Pending publication notices allow cancellation before starting
over; cancellation cannot recall bytes already sent to the private registry.

## Manage a published skill

Open the skill and use its management section. Only its owner and administrators
can make these changes. A reader or selected organization member cannot edit it.
An administrator managing another owner's or an unassigned skill enters a reason
that appears in management history.

| Change                                      | Action                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| Display name, description, tags, or sharing | Select **Edit skill** and save                                         |
| Icon                                        | Upload PNG, JPEG, or WebP up to 2 MiB, or remove it to use the default |
| Package files or instructions               | Publish a new version from a workspace or ZIP                          |
| Owner                                       | Select an active user and offer ownership; the recipient accepts       |
| Remove from Hub                             | Move to Trash; recovery is available for 30 days                       |

Descriptions start from `SKILL.md` but can be edited independently. Use up to five
tags, each up to 32 characters. Metadata changes do not release a package version.
New versions preserve edited metadata and current sharing.

For another release, choose **New version of existing skill** and explicitly select
its entry, or start from that skill's management section. Released versions cannot
be overwritten. To roll back content, publish the desired files under a new
version. Sharing changes use **Edit skill**, rather than a new-version request.

A stale revision leaves the draft available and reports a conflict. Reload the
latest details, review the changes, and retry. There are no coauthors or automatic
merges. Ownership remains with the current owner until the recipient accepts the
request; the former owner then loses editing rights.

## Search and download

1. Search **Skill Hub** and open a result. Check its display name and owner.
2. Inspect the available versions and each version's scan result.
3. Select an exact version.
4. Choose **Download ZIP**, or choose the installation action under **Basic
   server** or **My development VM**.

Warnings and an unverified scan are visible but do not block a valid downloadable
package. A confirmed malicious version is blocked without an override. A native
version that is still unavailable cannot be downloaded merely because scanning is
nonblocking. Other versions are evaluated separately.

Basic and VM installation actions show their own installed state. Installing on
one destination leaves the other copy unchanged and does not switch the active
work location. A missing or unreachable VM shows a reason; complete its setup in
**Work location** and check again. Basic remains a separate available choice. See
[VM administration](/platformclaw/vm-administration).

An existing physical package name requires replacement confirmation, including
when the version text is equal. Review the destination and installed revision
before confirming. A different Hub ID or an untracked local copy is not reported
as the same installed Hub entry. Local edits may be replaced and cannot be
reconstructed from an older published ZIP.

The installed Hub label requires the recorded version and `SKILL.md` revision to
match the completed installation. It does not verify every helper file in the
package. Review local changes before confirming replacement. Removing that label
does not remove the saved origin or relax a shared room's access restrictions.

If an installation response was lost, refresh installed status first. An uncertain
provenance record stays pending and requires explicit replacement confirmation;
neither the browser nor the natural-language tool silently forces another install.

## Trash, restore, and history

Moving an entry to Trash immediately hides it from readers and prevents further
Hub downloads and room use. It does not remove personal Basic or VM copies.

Open **Trash** to restore an owned skill within 30 days. An administrator may
restore another owner's entry with a reason. Restore keeps its ID, links, versions,
metadata, and sharing settings, subject to current recipient status. An archived
organization never broadens the audience to Public automatically.

After 30 days, permanent cleanup removes package and description content, icons,
and versions. Cleanup failures remain visible and the entry stays unavailable;
a success response from an HTTP delete alone is not physical-erasure proof.
Independent backups follow the operator retention policy.

Authorized readers can open ordinary version history, including who published a
version and when. Owners and administrators also see management history and
administrator reasons. History remains while the skill is active or recoverable.
After permanent deletion, only minimal actor, action, time, and version audit facts
remain for one year, then expire. Notifications do not retain deleted descriptions
or package contents.

## Knox commands

Authenticated users can use `/skillhub` in Knox without a model turn. DM commands
use the employee's active personal workspace. Room commands use the registered
room workspace and only currently Public Hub skills. Private or Selected access
held by the sender, owner, or administrator never becomes room access. Publishing
is available from personal workspaces only.

Replies default to Korean. Put `--lang=en` or `--lang=ko` immediately after
`/skillhub` to choose the reply language for one command, including errors. For
example, `/skillhub --lang=en list` browses in English. The choice is not saved;
English next-page commands include the same selector. `help en` and `help ko`
continue to select the help language only. Common host authorization messages
shown before the plugin runs are in English.

| Command                                        | Result                                                         |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `/skillhub help [ko\|en]`                      | Show help in the selected language                             |
| `/skillhub list [page\|all]`                   | Browse accessible catalog entries                              |
| `/skillhub installed`                          | Show installed copies on the active target                     |
| `/skillhub publish <workspace-skill>`          | Create a Public entry from a personal workspace                |
| `/skillhub install <skill-id\|name>`           | Install an available version of the selected entry             |
| `/skillhub update <skill-id\|name>`            | Explicitly replace the installed version after revision checks |
| `/skillhub delete <installed-skill> --confirm` | Remove only the current workspace copy                         |

Equal names require selecting a returned stable ID. `list all` denotes the first
page; follow the next-page command to continue. Categories such as `knowledge` or
`utility` are not filters. Legacy coordinate links can resolve an existing entry,
but namespace paths are not a publication interface.

Deleting an installed copy does not delete its Hub original. Deletion checks the
current physical directory and revision; it cannot remove another workspace,
follow an arbitrary path, or select a sibling by a frontmatter alias.

## Natural language in Knox

Ask the Agent to find a skill for a task. It searches the available catalog,
recommends a stable ID and exact version, and asks whether to install unless you
already clearly requested that entry. A natural reply such as `어 설치해` refers
to that conversation's recommendation. Ambiguous names require clarification.

The plugin exposes `skillhub_search`, `skillhub_status`, `skillhub_install`, and
`skillhub_delete`. Trusted runtime context pins the sender, account, room, Agent,
and session; tool input cannot choose another person or workspace. README text,
search results, tool output, quotations, and third-party instructions do not
supply user approval. A short or empty result is not an exhaustive catalog check.

A matching completed Hub installation returns readiness. Disabled skills and
missing environment requirements need configuration. The tool cannot force an
update or reinstall. Check status after an uncertain response and after installation;
newly installed content is available on a later run.

To remove a copy, name the installed skill and explicitly confirm the effect on
local edits. The tool checks current installed status and uses `confirm: true` only
with that user authority. Published files cannot restore unrecorded local changes.

Before each room run, saved Hub copies are checked against current sharing,
Trash state, and version blocks. Revoked access excludes the skill from the next
run; existing runs and results are not recalled.

## Deploy the managed service

The standard `platformclaw-<version>-<sha12>.tar` contains PlatformClaw, sandbox,
SkillHub server, scanner, PostgreSQL, and Redis images. Use the existing wrapper:

```bash
./platformclaw-deploy init
./platformclaw-deploy image load platformclaw-<version>-<sha12>.tar
./platformclaw-deploy up
./platformclaw-deploy status
```

New deployments enable the managed Skill Hub profile by default. Existing
installations opt in through `PLATFORMCLAW_SKILL_HUB_ENABLED=true`. The wrapper
generates server-only secrets and keeps registry, database, Redis, and scanner
ports private. The browser uses the existing PlatformClaw session and never
receives registry OAuth or administrator credentials.

Managed startup enables the existing private Gateway uploaded-archive path while
preserving other Skills settings:

```json5
{
  skills: {
    install: {
      allowUploadedArchives: true,
    },
  },
}
```

The control plane stages exact-version packages through the existing Gateway
installer; it does not add another workspace extractor. Assigned-VM installation
uses the execution plugin's authenticated SSH lease, remote tree validation,
per-target guard, staging directory, and atomic replacement. Export uses bounded
private RPC chunks and owner-only temporary archives, with cleanup on completion,
cancellation, expiry, and shutdown.

At least 20 GiB of free disk is required for a fresh embedded deployment and 5 GiB
for later restarts. Preserve the registry and control database volumes together
in backup and restore procedures. A downgrade must restore matching application
and database snapshots; it must not recreate retired sharing policy in a current
catalog.

## Configure an external registry

The integration is pinned to `iflytek/skillhub` tag `v0.2.16`, commit
`6e133c006e492dc3f468d91b21960aff1d577150`, with the managed PlatformClaw runtime
patch and provenance. Revalidate native API behavior before changing that pin.
Its React portal, OAuth, logo, and branding are not embedded.

Mount bounded, server-readable regular secret files and configure Control:

```bash
PLATFORMCLAW_SKILL_HUB_URL=https://skillhub.internal.example
PLATFORMCLAW_SKILL_HUB_BOOTSTRAP_PASSWORD_FILE=/run/secrets/platformclaw_skill_hub_bootstrap_password
PLATFORMCLAW_SKILL_HUB_MAX_PACKAGE_BYTES=524288000
```

URL and bootstrap password file must be configured together.
The server-owned managed registry connection provisions private artifact
coordinates and supports legacy inventory. It does not assign employee audiences.
Remove `PLATFORMCLAW_SKILL_HUB_NAMESPACES` from older deployments: the setting is
retired and startup reports an actionable error if it remains. There is no
replacement namespace allowlist; sharing is configured per skill.

Current Control operations use the managed administrative session and do not read
or require `PLATFORMCLAW_SKILL_HUB_TOKEN_FILE`. The embedded deployment retains
its CLI token provisioning, secret mount, and matching backup for the supported
image rollback flow: older Control images require that token. Remove this
deployment compatibility path when the supported downgrade floor excludes those
images. The retired token does not participate in employee permissions or artifact
reads in the current service.

Never put registry credentials in `openclaw.json`, a browser descriptor, client-side
environment variable, or browser-visible reverse-proxy header. The adapter keeps
credentials inside Control and redacts reflected errors. Restart Control after
changing runtime environment values or mounted registry credentials.

## Package and scan limits

Packages are limited to 500 MiB compressed, 1 GiB expanded cumulatively, 250 MiB
per entry, and 2,000 total ZIP entries. Retained `SKILL.md` is limited to 256 KiB.
Validation streams decompressed entries rather than trusting ZIP size metadata.
It rejects unsafe paths, symlink or junction escapes, hard links, malformed or
mismatched manifests, reserved runtime content, and unconfirmed replacements.

`.env` and `.env.*` remain valid for nonsecret defaults. Private keys, credentials,
VCS state, runtime metadata, and dependency trees remain excluded or rejected by
the canonical packaging and extraction policy. File extensions alone are not a
publication restriction. The managed artifact publication API accepts valid
heuristic warnings through the retained archive and storage pipeline; other native
publication errors remain visible and must not be reclassified as success.

Scanner execution is bounded to ten minutes. Heuristic warnings and unavailable
scans are nonblocking for valid, available packages. Confirmed malicious versions
remain blocked. LLM and VirusTotal analyzers stay disabled unless separately
approved. No fallback silently transmits package data to an external analyzer.

## API boundary

Browser calls use only same-origin `/platformclaw/api/skill-hub` routes with the
HttpOnly employee session. Mutation origins, content type, bounded bodies, current
actor authority, and revisions are checked server-side.

| Route relative to the BFF                                       | Purpose                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /config`, `GET /search`                                    | Available targets, active organizations, owned entries, and accessible catalog |
| `GET /users?q=...`                                              | Active-user sharing or transfer selector with safe public identity fields      |
| `POST /publish`, `POST /publish/upload`                         | Workspace publication or bounded ZIP upload with an operation UUID             |
| `GET /skills/by-id/:id`                                         | Detail and permitted management projection                                     |
| `PATCH /skills/by-id/:id`                                       | Revision-checked metadata and sharing                                          |
| `POST /skills/by-id/:id/install`                                | Exact-version destination install                                              |
| `GET /skills/by-id/:id/download?version=...`                    | Authorized exact-version ZIP download                                          |
| `GET`, `PUT`, `DELETE /skills/by-id/:id/icon`                   | Authorized icon read or revision-checked replacement/removal                   |
| `POST /skills/by-id/:id/delete`, `/restore`                     | Trash and recovery                                                             |
| `POST /skills/by-id/:id/transfer`, `/transfer/accept`           | Ownership offer and recipient acceptance                                       |
| `GET /skills/by-id/:id/history`, `GET /trash`, `GET /transfers` | Access-filtered history and lifecycle views                                    |
| `POST /publications/:operationId/cancel`                        | Cancel an authorized pending publication                                       |
| `GET /notifications`, `POST /notifications/read`                | Lifecycle inbox and read state                                                 |

Native registry routes remain adapter details. The adapter consumes detail,
versions, exact downloads, private publication, deletion, and scan-audit APIs;
its managed server session supplies inventory and opaque coordinate creation.
Native names and IDs do not establish employee authority. Download and install
responses do not reveal private filesystem paths or credentials.

## Troubleshoot an outcome

- **Retired namespace setting:** remove `PLATFORMCLAW_SKILL_HUB_NAMESPACES`, then
  restart using the deployment wrapper. Configure sharing in the skill detail.
- **Pending publication:** retry the original unchanged request or cancel its
  pending operation before starting over. Ask an administrator about persistent
  reconciliation errors; do not manually adopt a similarly named native artifact.
- **Revision conflict:** reload current details or installed status, review the
  differences, and confirm the intended edit or replacement again.
- **Unknown installation result:** inspect installed status. Review local files
  before an explicit replacement; automatic force retry is unavailable.
- **VM unavailable or target changed:** verify **Work location** and VM readiness,
  reload, and retry the intended target. Basic is not a fallback.
- **Uploaded archives disabled:** verify the managed Skill Hub profile and Gateway
  setting, then restart with the wrapper so configuration is reconciled.
- **Package validation failure:** correct the reported manifest, path, or size.
  Scanner warning policy cannot bypass an invalid or unsafe archive.
- **Hub unavailable:** inspect the pinned internal service, private network,
  mounted credentials, and visible maintenance outcome from the Control host.
  Never copy its token into a browser.

## Verify a release

Use the repository validation routing and its trusted Linux environment. Preserve
focused archive, adapter, catalog, browser BFF, command/tool, room runtime, Basic,
VM, and UI regression coverage. Build Control and UI, then exercise the real
ordinary-user browser workflows and inspect screenshots. Keep exact-revision
commands and evidence with the change.

The existing PlatformClaw archive, checksum, transfer, load, persistence, backup,
restore, and rollback path also requires proof. Retain byte comparisons for
legacy native `SCANNING` and `SCAN_FAILED` downloads and inspect physical storage
after expired Trash cleanup. A mock, synthetic receipt, or HTTP success is not
proof of those effects. Local Linux fixture validation covers the managed Local
storage path; production backup and S3 validation remain separate. See
[Release validation](/platformclaw/skill-hub-architecture#release-validation).
