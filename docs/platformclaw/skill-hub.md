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
the personal Agent's active Basic or assigned-VM workspace.

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

Enable the existing trusted uploaded-archive path on the private Gateway:

```json5
{
  skills: {
    install: {
      allowUploadedArchives: true,
    },
  },
}
```

This setting is off by default upstream. PlatformClaw sends downloaded packages
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

Restart the Gateway after enabling uploaded archives, then restart the control
process after changing Skill Hub environment values or its token file.

## Publish a workspace skill

1. Open **Skills** for a personal Agent whose execution target is the platform
   workspace.
2. Find a skill loaded from `<workspace>/skills/<skill>/`.
3. Select **Publish to Hub**.
4. Choose an allowed namespace, enter a SemVer version, and choose **Public**,
   **Namespace only**, or **Private**.
5. Select **Publish**.

The server resolves the authenticated user's active personal-Agent binding and
packages that Agent's real workspace directory. It requires a root `SKILL.md`
with valid YAML frontmatter, a `name` equal to the skill directory, and a
non-empty `description`. The chosen version is written only into the temporary
package; the workspace `SKILL.md` is unchanged.

## Search and install a version

1. Search **Skill Hub** on the same Skills page.
2. Open a result to inspect its summary and published versions.
3. Choose a version whose download is available.
4. Confirm the current work location, then select **Install to Basic workspace**
   or **Install to My development VM**.

PlatformClaw downloads the exact
`/api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download` resource,
validates it, and stages it through the Gateway upload installer for the
authenticated user's Agent. The browser sends the work location it displayed
only as a stale-screen guard. The control process resolves the authoritative
execution profile again, and the Gateway pins its target revision before any
mutation. Target selection and the actual workspace install are serialized for
each Agent, and the pinned target is revalidated after that guard is acquired.
A concurrent target switch or stale screen therefore fails visibly;
installation never falls back from a VM to the Basic workspace.

Basic installs use the canonical local workspace installer. Assigned-VM installs
reuse the same upload extraction and security scan, then the execution plugin
streams only the approved extracted tree over its server-side SSH session. It
stages under the remote workspace's `.openclaw/skill-installs`, validates the
remote tree, locks the `skills` directory, and atomically moves it into
`workspace/skills/<slug>`. Staging is removed on success or failure. Installing
the exact version already present is a no-op. An upgrade or downgrade returns
the current and requested versions and requires a second confirmation. The Basic
and VM installers use sibling staging and backup directories to replace
atomically and restore the old tree if validation or commit fails.

## Knox commands

Authenticated employees can manage the active execution target from Knox Teams.
Responses are Markdown. English is the default; only `help ko` selects Korean
help text.

| Command                                             | Result                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| `/skillhub help`                                    | English command help                                             |
| `/skillhub help ko`                                 | Korean command help                                              |
| `/skillhub list [page]`                             | Skills the employee may download                                 |
| `/skillhub installed`                               | Skill Hub skills installed on the active target                  |
| `/skillhub install <slug\|namespace/slug>`          | Install the latest accessible version                            |
| `/skillhub update <slug\|namespace/slug>`           | Replace the installed version with the latest accessible version |
| `/skillhub delete <slug\|namespace/slug> --confirm` | Remove the revision-pinned skill from the active target          |

A bare slug works when it identifies exactly one accessible namespace. If the
same slug is visible in multiple namespaces, the response lists candidates and
requires `namespace/slug`. Install, update, and delete resolve the authoritative
Basic or assigned-VM target at execution time; they never fall back to the other
workspace. Delete requires `--confirm` and refuses to remove a skill whose
revision changed after status was read.

## Validation and security limits

The compressed ZIP ceiling is **500 MiB**. Browser ingress streams to an
owner-only temporary file with a running cap. Validation then enforces **1 GiB
expanded content**, **250 MiB per entry**, and **100 entries** without trusting
central-directory sizes. The scanner timeout is ten minutes. LLM and VirusTotal
analyzers are explicitly disabled.

Both publication and installation reject:

- path traversal, absolute paths, Windows drive paths, and malformed ZIP paths;
- symbolic links, junction escapes, non-file workspace entries, and realpath
  escapes;
- a missing, oversized, malformed, or name-mismatched `SKILL.md`;
- a `SKILL.md` version that differs from the exact version requested for install;
- more than 100 archive entries;
- a compressed archive over 500 MiB, expanded content over 1 GiB, or one entry
  over 250 MiB; and
- an unconfirmed version replacement.

The control-plane preflight streams every decompressed entry through cumulative
and per-manifest byte limits instead of trusting ZIP size metadata. The existing
Gateway archive extractor and install security policy then perform the
authoritative extraction and destination checks. Successful publish and install
operations create control-plane audit records without package contents or
credentials.

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
publication, and administrator namespace/unassigned-owner views. Server-side
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
| Publish        | `POST /api/cli/v1/skills/{namespace}/publish`                           |
| Exact download | `GET /api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download` |

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
- **Uploaded skill archive installs are disabled**: set
  `skills.install.allowUploadedArchives: true` on the private Gateway and restart
  it.
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
