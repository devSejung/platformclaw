---
summary: "GitHub Actions policy for the private PlatformClaw downstream"
read_when:
  - Operating or changing PlatformClaw GitHub Actions
  - Synchronizing new workflows from OpenClaw upstream
title: "Private downstream CI"
---

# Private downstream CI

PlatformClaw does not run the complete OpenClaw maintainer automation suite in
its private origin repository. The upstream suite depends on OpenClaw
organization runners, GitHub Apps, release credentials, and public-repository
CodeQL behavior that are not PlatformClaw dependencies.

The repository uses two GitHub-hosted Ubuntu workflows with a repository-scoped
read-only `GITHUB_TOKEN`:

- `.github/workflows/platformclaw-ci.yml` is the required fast PR gate. A
  repository-owned planner classifies the changed paths. PlatformClaw-only
  changes run focused formatting, lint, typecheck, tests, build, workflow, UI,
  documentation, or deployment checks. Any path outside the private overlay
  automatically falls back to the upstream changed-surface gate.
- `.github/workflows/platformclaw-full-ci.yml` runs the broad upstream
  changed-surface gate after pushes to `main`, on manual dispatch, and on
  non-draft `sync/upstream-*` pull requests. It is background assurance for
  normal feature work and a pre-merge gate for upstream synchronization.

The fast path does not weaken control-plane coverage. Any control-plane change,
including authentication, authorization, session, credential, and tenant
isolation code, runs the whole control-plane test suite plus package typecheck,
lint, and build. It avoids only unrelated OpenClaw core fanout.
Repository-wide conflict-marker, changelog attribution, dependency pin, package
patch, export-boundary, duplicate-scan, and max-lines suppression guards remain
in the fast workflow. Both workflows use a blob-filtered full-history checkout:
commit history stays available for merge-base comparison after a pull request
base changes, while historical file contents are fetched only when Git needs
them. Read-only checkout credentials remain available for those lazy fetches.

The private `admin-http-rpc` plugin is also an overlay-owned surface. Changes
there run targeted lint, production and test typechecks, and the complete plugin
test directory. They do not trigger unrelated OpenClaw core fanout. If the same
pull request changes a shared or core path, the planner still adds the upstream
changed-surface gate.

GitHub and local development use `scripts/platformclaw-check.mjs` for the same
control-plane, Admin HTTP RPC, planner, and UI command groups. During an edit
loop, run:

```bash
node scripts/platformclaw-check.mjs --changed --quick
```

For overlay-owned surfaces, quick mode retains patch whitespace, formatting,
lint, typecheck, and focused tests; it skips only production builds. Shared or
core changes defer the upstream-wide gate to the full form. Before push or pull
request creation, run:

```bash
node scripts/platformclaw-check.mjs --changed
```

Repository policy, documentation, deployment, workflow, and genuine
upstream-path gates remain separate workflow checks. Security and architecture
coverage therefore remains visible and mandatory.

The login UI's private source, HTML entry point, and dedicated Vite configuration
stay on the focused path. That path runs the complete UI typecheck, lints both
Vite configurations, runs the private Vite regression tests, and performs the
production UI build. The upstream-owned `ui/package.json` and `ui/vite.config.ts`
always fall back to upstream changed-surface checks, even when a diff also changes
private UI files. The job keeps a 60-minute safety ceiling for that genuine
upstream work; focused PlatformClaw changes do not run the expensive fallback.

Docker image construction remains a release or deployment validation step. It
is not part of every pull request.

## Repository workflow state

Workflow enablement is GitHub repository state, not a source-controlled
property. The private origin keeps the following workflow groups disabled:

- OpenClaw CI and workflow-sanity workflows replaced by PlatformClaw CI;
- CodeQL workflows that require GitHub Code Security for a private repository;
- OpenClaw iOS, macOS, shared-kit periphery, and OpenGrep infrastructure;
- OpenClaw bot, label, response, maintainer, and stale automation;
- OpenClaw release, publication, translation, scheduled live-test, cache-warmer,
  and external-service workflows.

Generic repository-local guards may remain enabled when they use GitHub-hosted
runners and the built-in token. Current examples are dependency guard,
security-sensitive guard, and provider-scaffold validation.

## Upstream sync rule

After every upstream sync:

1. List active workflows in the private origin.
2. Review newly introduced or renamed workflow files before they run.
3. Disable workflows requiring OpenClaw organization infrastructure or
   credentials.
4. Re-enable an upstream workflow only after proving its runner, secret,
   permission, and private-repository contracts.
5. Run PlatformClaw CI on the sync pull request.
6. Require PlatformClaw Full CI to pass on the `sync/upstream-*` pull request.

Do not copy OpenClaw GitHub App private keys or release secrets into the
PlatformClaw repository to make an unrelated upstream workflow pass.
