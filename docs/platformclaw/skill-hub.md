---
summary: "Configure and operate the PlatformClaw Skill Hub registry integration"
read_when:
  - Connecting PlatformClaw to the pinned iflytek SkillHub registry
  - Publishing or installing workspace skills from the PlatformClaw Skills page
  - Troubleshooting Skill Hub authorization, archive validation, or package limits
title: "Skill Hub integration"
---

# Skill Hub integration

PlatformClaw connects its existing Skills page to a separately deployed SkillHub
registry. Employees can publish a real Agent workspace skill without selecting a
ZIP, search the shared registry, inspect versions, and install one exact version
into the personal Agent's active Basic or assigned-VM workspace.

The integration targets `iflytek/skillhub` tag `v0.2.16`, commit
`6e133c006e492dc3f468d91b21960aff1d577150`. Do not upgrade the adapter from this
snapshot without reviewing its API contracts and repeating the integration tests.
SkillHub's source and portal UI are not copied or embedded in PlatformClaw.

## Before you begin

Deploy SkillHub separately and create a server-side API token with the
`skill:publish` scope for each namespace PlatformClaw may use. PlatformClaw uses
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

## Configure the control process

Mount the SkillHub token as a regular, server-readable secret file. Configure the
adapter on the PlatformClaw control process:

```bash
PLATFORMCLAW_SKILL_HUB_URL=https://skillhub.internal.example
PLATFORMCLAW_SKILL_HUB_TOKEN_FILE=/run/secrets/platformclaw_skill_hub_token
PLATFORMCLAW_SKILL_HUB_NAMESPACES=engineering=eng-skill-publishers,shared=*
PLATFORMCLAW_SKILL_HUB_MAX_PACKAGE_BYTES=10485760
```

The URL, token file, and namespace list must be set together. The package limit
is optional and defaults to 10 MiB. `PLATFORMCLAW_SKILL_HUB_NAMESPACES` is the
PlatformClaw authorization boundary. Each entry is
`namespace=employee-group`; `*` allows any active employee, and a bare
`namespace` requires an employee group with the same name. Administrators may
publish to every configured namespace. Members see only namespaces permitted by
their existing PlatformClaw identity groups in the publish dialog. Public skills
remain searchable by every active employee. Namespace-only and private skills
are returned, opened, and installed only for administrators or members of that
namespace's configured employee group. SkillHub applies its token and namespace
permissions again at publication time.

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
in-memory ZIP; the workspace `SKILL.md` is unchanged.

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
`workspace/skills/<slug>`. Staging is removed on success or failure. Existing
target directories are not overwritten; publish a new version under the same
Hub skill, then install it only where that workspace does not already contain a
conflicting skill directory.

## Validation and security limits

Both publication and installation reject:

- path traversal, absolute paths, Windows drive paths, and malformed ZIP paths;
- symbolic links, junction escapes, non-file workspace entries, and realpath
  escapes;
- a missing, oversized, malformed, or name-mismatched `SKILL.md`;
- a `SKILL.md` version that differs from the exact version requested for install;
- more than 256 archive entries;
- compressed or extracted content beyond the configured package limit; and
- a destination directory that already exists in the selected Basic or VM
  workspace.

The control-plane preflight streams every decompressed entry through cumulative
and per-manifest byte limits instead of trusting ZIP size metadata. The existing
Gateway archive extractor and install security policy then perform the
authoritative extraction and destination checks. Successful publish and install
operations create control-plane audit records without package contents or
credentials.

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
- **Skill already exists**: the integration deliberately blocks overwrite.
  Remove or rename the local skill through an approved workspace workflow before
  installing.
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
node scripts/run-vitest.mjs ui/src/pages/skills/view.skill-hub.test.ts
```

Then build the two changed packages:

```bash
pnpm --filter @platformclaw/control-plane build
pnpm --dir ui build
```
