---
summary: "Configure and operate the PlatformClaw Skill Hub registry integration"
read_when:
  - Connecting PlatformClaw to the pinned iflytek SkillHub registry
  - Publishing or installing workspace skills from the PlatformClaw Skills page
  - Troubleshooting Skill Hub authorization, archive validation, or package limits
title: "Skill Hub integration"
---

# Skill Hub integration

PlatformClaw connects its existing Skills page to an internal, company-wide
Skill Hub. Employees can publish a real Agent workspace skill without selecting
a ZIP, search the catalog, inspect versions, and install one exact version into
the personal Agent's Basic workspace or assigned-VM workspace. Each destination
keeps its own installed skills, independently of the active work location.

The managed deployment runs the registry on the same PlatformClaw server and
ships it through the existing PlatformClaw release archive and deployment flow.
See [Skill Hub product policy](/platformclaw/skill-hub-policy) for ownership,
ACL, scanning, and notification behavior, and
[Skill Hub architecture](/platformclaw/skill-hub-architecture) for the migration
boundary.

The integration targets `iflytek/skillhub` tag `v0.2.16`, commit
`6e133c006e492dc3f468d91b21960aff1d577150`. Do not upgrade the adapter from this
snapshot without reviewing its API contracts and repeating the integration tests.
SkillHub's service remains a separate internal container. Its React portal,
OAuth, logo, and branding are not embedded. PlatformClaw independently ports the
upstream catalog information architecture into its Lit UI and theme.

The managed server includes a pinned PlatformClaw patch for revision-checked
metadata edits and namespace moves. External registries need the same management
API and the existing server-only governance session to enable editing.

## Before you begin

The standard `platformclaw-<version>-<sha12>.tar` contains PlatformClaw, sandbox,
SkillHub server, scanner, PostgreSQL, and Redis images. Keep the existing release
procedure:

```bash
./platformclaw-deploy init
./platformclaw-deploy image load platformclaw-<version>-<sha12>.tar
./platformclaw-deploy up
./platformclaw-deploy status
```

New deployments enable the internal SkillHub profile by default. Existing
deployments without `PLATFORMCLAW_SKILL_HUB_ENABLED=true` retain their previous
two-image behavior until the operator opts in. The wrapper generates and mounts
server-only secrets, bootstraps approved namespaces and a scoped API token, and
never publishes registry, database, Redis, or scanner ports. PlatformClaw uses
its existing employee session and personal-Agent binding; it does not enable
SkillHub OAuth in the browser.

Managed SkillHub deployments automatically enable the existing trusted
uploaded-archive path on the private Gateway:

```json5
{
  skills: {
    install: {
      allowUploadedArchives: true,
    },
  },
}
```

This setting remains off by default upstream. PlatformClaw merges it into the
preserved Gateway config whenever the managed SkillHub profile starts, including
after image updates, without replacing other Skills or installer settings.
PlatformClaw sends downloaded packages
through `skills.upload.begin`, `skills.upload.chunk`, `skills.upload.commit`, and
`skills.install`; it does not add a second archive extractor or write directly
into an Agent workspace.

## Advanced external-registry configuration

Mount the SkillHub token as a regular, server-readable secret file. Configure the
adapter on the PlatformClaw control process:

```bash
PLATFORMCLAW_SKILL_HUB_URL=https://skillhub.internal.example
PLATFORMCLAW_SKILL_HUB_TOKEN_FILE=/run/secrets/platformclaw_skill_hub_token
PLATFORMCLAW_SKILL_HUB_NAMESPACES=engineering=eng-skill-publishers,shared=*
PLATFORMCLAW_SKILL_HUB_MAX_PACKAGE_BYTES=524288000
```

The URL, token file, and namespace list must be set together. The managed
deployment generates these values; set them manually only for an external
registry. `PLATFORMCLAW_SKILL_HUB_NAMESPACES` is only the registry bootstrap
allowlist. The optional right-hand value in legacy `namespace=value` syntax is
retained for registry bootstrap compatibility and is never employee
authorization. Bind each namespace to Global, Team, Group, or Part in Skill Hub
administration before publishing. Public skills remain searchable by every
active employee; all other access comes from organization scope, visibility,
ownership, or an explicit read/install grant.

Never put the token in `openclaw.json`, a browser runtime descriptor, a client
environment variable, or a reverse-proxy header visible to the browser. The
adapter keeps it inside the control process and redacts it if an upstream error
reflects the token.

Restart the control process after changing Skill Hub environment values or its
token file. Managed startup handles the Gateway archive-install setting.

## Publish a workspace skill

Use either entry point:

1. Open **Skills**, select the Basic or My development VM work location, find a
   skill loaded from that personal workspace's `skills/<skill>/`, and select
   **Publish to Hub**; or open **Skill Hub**, select **Publish workspace skill**,
   explicitly choose **Basic workspace** or **My development VM**, and select a
   discovered workspace skill.
2. Choose an allowed namespace, enter a SemVer version, and choose **Public**,
   **Namespace only**, or **Private**.
3. Select **Publish**.

The server resolves the authenticated user's personal-Agent binding and
packages the explicitly selected real Basic or assigned-VM workspace without
switching the active work location. VM publication uses its existing server-side
SSH session; no file attachment, browser download, or manual VM copy is needed.
It requires a root `SKILL.md`
with valid YAML frontmatter, a `name` equal to the skill directory, and a
non-empty `description`. The chosen version is written only into the temporary
package; the workspace `SKILL.md` is unchanged.

PlatformClaw does not treat SkillHub v0.2.16's built-in file-extension allowlist
as a publication restriction. If the pinned CLI publish endpoint rejects a
package **only** with `Disallowed file extension` warnings, the server retries
the same authenticated package through SkillHub's warning-confirmable publish
endpoint. This allows ordinary skill files with arbitrary extensions, including
`.jsonl` and `.bin`. Any additional pre-publish warning remains unconfirmed and
still blocks publication.

## Edit a published skill

Open **Skill Hub**, open the skill, and use its management section. The current
owner and PlatformClaw administrators can manage an existing skill; an individual
read/install grant does not give editing rights.

| Change                                               | Action                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Display name, description, visibility, or namespace  | Select **Edit skill**, change the fields, then **Save changes**.                        |
| Skill instructions or packaged files                 | Select **Publish new version**, choose the updated ZIP, and enter a new SemVer version. |
| Accountable owner                                    | Select an eligible active employee and transfer ownership.                              |
| Individual read/install access                       | Grant or revoke access in the management section.                                       |
| Namespace scope, visibility ceiling, or access state | Use the administrator namespace view.                                                   |
| Registry entry and all its versions                  | Use **Delete skill** and confirm the named skill.                                       |

A namespace move requires publication rights at the destination and an owner who
is eligible there. Transfer ownership first if the current owner cannot own a
skill in the destination namespace. The destination must be allowed and have a
managed binding. Its visibility ceiling still applies, and an existing skill
with the same package identity blocks the move.

Review the destination and visibility before saving: namespace membership can
change who can find and install the skill. Explicit per-user grants, versions,
packages, security scan results, and version history remain attached to the same
skill. The old registry coordinate stops resolving after a move. Copies already
installed in Basic or VM workspaces remain unchanged.

The package slug and released versions are immutable. The display name can be
edited independently. **Publish new version** pins the current namespace, slug,
and visibility, and requires a new version; it never overwrites a released ZIP. Explicitly
edited catalog metadata remains in place on subsequent publication. Change
visibility through **Edit skill** before publishing with a different visibility.

Saving checks both the registry metadata revision and the PlatformClaw ownership
revision. If another editor changed the skill, reload its detail before retrying.
After a definite rejection, select **Reload**, then open **Edit skill** again to
start with the current details. An uncertain network or recovery error keeps the
same request ID for a safe retry.
Changing Private to a shared visibility prepares the existing eligible versions
for security scanning and publication. The skill stays private until approval;
the saved edit reports that sharing is pending. Completed scans are reused, and
owners or administrators retain the existing reasoned force-publication path.
Failed scan rounds start fresh scans from the stored ZIP. If no eligible release
remains, publish a new Private version before sharing the skill again.
Employees downloading a shared skill can install only published versions.
An interrupted request retains a persistent edit ID: retrying the unchanged form
recovers the result, including after a namespace move. The control process also
reconciles pending edits automatically when an authenticated Skill Hub session
is active. Other mutations and catalog access to the affected coordinates wait
until reconciliation finishes.

If ownership or namespace policy changes while a registry edit is in flight,
PlatformClaw keeps the edit reserved until the registry confirms both requested
and effective Private visibility, then completes reconciliation with an unassigned
owner. The privacy recovery has its own persistent request ID and survives a lost
response or restart; a restored policy does not silently resume sharing. The
result displays an ownership-review warning and administrators receive
an inbox item. An administrator must review the owner and visibility before
sharing the skill again. Edit starts, completions, and rejected operations are
recorded in the audit log.

## Search and install a version

1. Search **Skill Hub** on the same Skills page.
2. Open a result to inspect its summary and published versions.
3. Choose a version whose download is available.
4. Under **Where should this skill be downloaded?**, check the installed version
   shown separately for **Basic server** and **My development VM**.
5. Select **Install to Basic Workspace** or **Install to My VM Workspace** for
   the destination you want. This choice does not switch your active work
   location.

If the selected version is already downloaded to a destination, its action is
disabled. To install a different version there, select that version, choose
**Change to** the requested version, and review the destination and version
change before confirming replacement. Installing on Basic leaves the VM copy
unchanged, and installing on the VM leaves the Basic copy unchanged.

An unavailable destination shows a reason and disables its install action.
If no VM is assigned, ask an administrator to assign one. If your VM is not ready
or cannot be reached, complete or check its connection in **Work location**
settings, then select **Check again** in the skill detail. See
[VM administration](/platformclaw/vm-administration) for assignment and connection
setup. You can still install to Basic while the VM is unavailable.

PlatformClaw downloads the exact
`/api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download` resource,
validates it, and stages it through the Gateway upload installer for the
authenticated user's Agent. The browser explicitly selects the destination. The
control process checks access to that destination again, and the Gateway pins
the execution profile revision before any mutation. Target configuration and
the actual workspace install are serialized for each Agent, and the pinned
revision is revalidated after that guard is acquired. A concurrent target
configuration change therefore fails visibly;
installation never falls back from a VM to the Basic workspace.

Basic installs use the canonical local workspace installer. Assigned-VM installs
reuse the same upload extraction and security scan, then the execution plugin
streams only the approved extracted tree over its server-side SSH session. It
stages under the remote workspace's `.openclaw/skill-installs`, validates the
remote tree, locks the `skills` directory, and atomically moves it into
`workspace/skills/<slug>`. Staging is removed on success or failure. Installing
an existing skill with the same slug requires a revision-bound replacement
confirmation. The browser prevents downloading the same installed version again.
PlatformClaw does not claim the namespace of an existing install without durable
provenance. The Basic and VM installers use sibling staging and backup directories to replace
atomically and restore the old tree if validation or commit fails.

## Delete a published skill

Owners and PlatformClaw administrators can permanently delete a PlatformClaw-managed
skill from the Skill Hub registry from its detail view. The confirmation names the
exact `namespace/slug`, pins the current PlatformClaw ownership revision, and warns
that the operation cannot be undone. A stale ownership revision fails visibly and
must be retried from a refreshed detail view.

Registry deletion hard-deletes the registry entry, its published versions, and
uploaded package files. It also retires PlatformClaw's management state for that
skill, including its explicit access grants and pending governance jobs. Audit and
notification history remain historical records. A registry skill without a
PlatformClaw ownership record cannot be deleted through this path, including by an
administrator.

Deleting from the registry **does not uninstall copies that employees already
installed** in Basic or assigned-VM workspaces. Workspace removal remains a separate
operation; Knox `/skillhub delete <slug> --confirm` continues to remove only the
revision-pinned copy from the active workspace target.

## Knox commands

Authenticated employees can use `/skillhub` directly in Knox Teams without an
Agent/model turn. Managed initial configuration and upgrade reconciliation enable
the command plugin. Disabling the optional registry profile keeps the command
registered and returns an explicit unavailable message.

DM commands target the employee's active Basic or assigned-VM workspace. Group
commands target the registered room Agent workspace, never the sender's personal
Agent or VM. The relay account, room, Agent, and session are checked together.
Room catalog and installation use effective Public visibility; an employee's
private, organization, owner, or administrator grants do not become room grants.
Installed listing and removal stay in that room. Publishing reads that room's
source skill and still requires the sender's normal namespace/ownership rights.

Responses default to Korean; `help en` shows English help.

| Command                                    | Result                                                           |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `/skillhub help`                           | Korean command help                                              |
| `/skillhub help [ko\|en]`                  | Select the help language                                         |
| `/skillhub list [page\|all]`               | Skills the employee may download                                 |
| `/skillhub installed`                      | Skill Hub skills installed on the active target                  |
| `/skillhub publish <slug>`                 | Publish a skill from the active Basic or assigned-VM workspace   |
| `/skillhub install <slug\|namespace/slug>` | Install the latest accessible version                            |
| `/skillhub update <slug\|namespace/slug>`  | Replace the installed version with the latest accessible version |
| `/skillhub delete <slug> --confirm`        | Remove the revision-pinned skill from the active target          |

`list all` is a compatibility alias for page 1. The previous categories
`knowledge`, `automation`, `utility`, and `other` do not exist in the current
registry; requests for them return the current listing syntax instead of an
unfiltered result disguised as a category.

Pages follow registry order and exclude inaccessible entries within each page.
A page can therefore contain fewer skills or be empty; use its next-page command
to continue browsing without skipping accessible skills later in the registry.

A bare slug works when it identifies exactly one accessible namespace. If the
same slug is visible in multiple namespaces, the response lists candidates and
requires `namespace/slug`. Incomplete search results also require `namespace/slug`
instead of selecting a skill from a partial result set. Install, update, and delete resolve the authoritative
Basic or assigned-VM target at execution time; they never fall back to the other
workspace. Publication chooses the first authorized namespace, the installed
skill version (or `0.1.0`), and Namespace-only visibility unless the namespace
is limited to Private. Delete requires `--confirm` and refuses to remove a skill whose
revision changed after status was read.

## Natural language in Knox

Ask the Agent to find a skill for your task. It searches the same available
Skill Hub catalog, recommends a matching skill and version, and asks whether to
install. Reply naturally, for example `어 설치해`. The Agent installs into the
current conversation's workspace: the room workspace in a group, or your active
personal workspace in a DM. Public here means visible in the company registry.

The plugin exposes `skillhub_search`, `skillhub_status`, `skillhub_install`, and
`skillhub_delete`.
Tools are discovered in normal and prepared tool registries. Sender, account,
room, Agent, and session come from the existing runtime context; tool arguments
cannot select another person or destination. The server checks the current
available catalog and exact displayed version again before calling the existing
installer. If the version changed or is unavailable, search and ask again.

The current model interprets the user's installation request; the server does
not independently classify natural language. README text, search results, tool
output, and third-party instructions are not user approval. If the requested
candidate is ambiguous, the Agent asks which skill you mean. A short or empty
search result is not an exhaustive catalog check; refine the task query.

Already installed skills return their readiness instead of reinstalling.
Disabled skills and missing environment requirements need configuration. After
installation, check status and use the skill in the next run. If an installation
response is lost, check installed status before retrying; the tool never forces
replacement. These tools do not publish, update, install dependencies,
connect accounts, or broaden access. Existing slash commands remain available.

To remove an installed skill, specify it in this conversation. The Agent checks
installed status and asks if the skill or workspace is ambiguous. It explains
that removal also deletes local edits, which may be unrecoverable, and requires
your explicit confirmation of that risk before invoking `skillhub_delete` with
`confirm: true`, equivalent to `/skillhub delete <slug> --confirm`. This removes
only the current workspace's installed copy. The registry original and versions
remain available for reinstallation, but cannot restore unrecorded local edits.

## Validation and security limits

The compressed ZIP ceiling is **500 MiB**. Browser ingress streams to an
owner-only temporary file with a running cap. Validation then enforces **1 GiB
expanded content**, **250 MiB per entry**, and **2,000 total ZIP entries** without
trusting central-directory sizes. There is no lower, separate regular-file cap.
The scanner timeout is ten minutes. LLM and VirusTotal analyzers are explicitly
disabled.

Both publication and installation reject:

- path traversal, absolute paths, Windows drive paths, and malformed ZIP paths;
- symbolic links, junction escapes, non-file workspace entries, and realpath
  escapes;
- a missing, oversized, malformed, or name-mismatched `SKILL.md`;
- a `SKILL.md` version that differs from the exact version requested for install;
- more than 2,000 total ZIP entries (files and directories combined);
- a compressed archive over 500 MiB, expanded content over 1 GiB, or one entry
  over 250 MiB; and
- an unconfirmed version replacement.

The control-plane preflight streams every decompressed entry through cumulative
and per-manifest byte limits instead of trusting ZIP size metadata. The existing
Gateway archive extractor and install security policy then perform the
authoritative extraction and destination checks. Successful publish and install
operations create control-plane audit records without package contents or
credentials.

`.env` and `.env.*` are ordinary skill package files and are not excluded. They
remain subject to scanning and visibility policy, so publishers must not place
deploy-time credentials in them. Private keys, certificates, credential files,
VCS state, runtime metadata, and dependency trees remain excluded or rejected.
Those reserved security exclusions are separate from the removed upstream
extension allowlist behavior.

## Catalog lifecycle

The current managed integration adds:

- namespaces bind to Global, Team, Group, or Part, with explicit per-user ACLs;
- normal versions publish automatically after the scanner passes;
- every version shows its current scan state and risk badge;
- owners and PlatformClaw administrators may force publication for any severity
  only with a reason and audit record;
- owners can transfer ownership to an eligible active employee; inactive or
  scope-ineligible owners enter the unassigned owner queue;
- lifecycle events produce notifications without making delivery success the
  source of truth; and
- LLM scanning and VirusTotal remain off.

The Skill Hub page exposes current risk badges, the persistent notification
inbox, ZIP publication, owner transfer, explicit employee grants, forced
publication, managed-skill registry deletion, and administrator
namespace/unassigned-owner views. Server-side
policy remains authoritative even if a browser calls the BFF directly.

Skill Hub consumes the shared organization authorization boundary for
Global/Team/Group/Part. Global starts restricted and requires an explicit,
reasoned administrator activation. See
[PlatformClaw organization architecture](/platformclaw/organization-architecture)
for the canonical capability contract.

## API boundary

The pinned adapter uses these SkillHub `v0.2.16` endpoints:

| Operation      | SkillHub endpoint                                                       |
| -------------- | ----------------------------------------------------------------------- |
| Search         | `GET /api/cli/v1/skills/search`                                         |
| Detail         | `GET /api/v1/skills/{namespace}/{slug}`                                 |
| Versions       | `GET /api/v1/skills/{namespace}/{slug}/versions`                        |
| Version state  | `GET /api/v1/skills/{namespace}/{slug}/versions/{version}`              |
| Publish        | `POST /api/cli/v1/skills/{namespace}/publish`                           |
| Delete skill   | `DELETE /api/cli/v1/skills/{namespace}/{slug}`                          |
| Exact download | `GET /api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download` |

The managed server patch additionally exposes
`GET /api/v1/admin/platformclaw/skills/{namespace}/{slug}` and
`PATCH /api/v1/admin/platformclaw/skills/{skillId}`. Only the control process uses
these administrator endpoints through its private CSRF-protected session. The
same boundary resolves an exact version's pending or latest approved review at
`GET /api/v1/admin/platformclaw/skills/{namespace}/{slug}/versions/{version}/review`,
so old versions remain reviewable beyond the first catalog page. The
automatic policy uses
`POST /api/v1/admin/platformclaw/skills/{namespace}/{slug}/versions/{version}/approve-safe`
to check completed SAFE evidence and approve in one registry transaction. The
browser submits revision-checked edits to
`POST /platformclaw/api/skill-hub/skills/{namespace}/{slug}/edit`; it receives the
resulting coordinate and any ownership-review or pending-publication warning.

The browser calls only same-origin `/platformclaw/api/skill-hub/*` endpoints with
its HttpOnly PlatformClaw session cookie. Browser responses contain registry
metadata and operation results, never the SkillHub base URL, bearer token, or
private Gateway credential. The install response also projects only the skill
identity, exact version, and resolved target kind; it never returns a local or
remote filesystem path.

## Troubleshooting

- **Publishing or installing from this namespace is not allowed**: add the
  namespace to `PLATFORMCLAW_SKILL_HUB_NAMESPACES` only after approving employee
  access, then restart the control process.
- **Uploaded skill archive installs are disabled**: verify
  `PLATFORMCLAW_SKILL_HUB_ENABLED=true`, then restart Gateway. Managed startup
  repairs the archive-install setting while preserving other Skills config.
- **Version change requires confirmation**: review the current and requested
  versions, then use the explicit replacement action. A stale confirmation is
  rejected.
- **Execution target changed**: reload the Skills page and retry against the work
  location now shown. PlatformClaw will not silently install into the other
  workspace.
- **Skill Hub archive expands past the configured size limit**: reduce the
  package or raise the server limit after reviewing storage and extraction risk.
- **Skill Hub is unavailable**: verify the pinned SkillHub service, internal
  network route, token scope, and namespace permission from the control-process
  host. Do not test by copying the token into a browser.

## Verification

Run the focused adapter, packaging, archive-security, deployment, and Skills UI
tests:

```bash
node scripts/run-vitest.mjs packages/platformclaw-control-plane/src/skill-hub-adapter.test.ts packages/platformclaw-control-plane/src/skill-hub-service.test.ts packages/platformclaw-control-plane/src/deployment-config.test.ts
node scripts/run-vitest.mjs extensions/platformclaw-execution/src/backend.test.ts extensions/platformclaw-execution/src/gateway.test.ts extensions/platformclaw-execution/src/remote-skill-install.test.ts extensions/platformclaw-execution/src/target-mutation-coordinator.test.ts
node scripts/run-vitest.mjs ui/src/pages/skills/view.skill-hub.test.ts ui/src/pages/skill-hub/skill-hub-page.test.ts
```

Then build the two changed packages:

```bash
pnpm --filter @platformclaw/control-plane build
pnpm --dir ui build
```

Also prove the existing PlatformClaw archive, checksum, transfer, load,
persistence, backup, restore, and rollback path. Do not introduce a second Skill
Hub release archive or independent upgrade procedure.
