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

The repository instead runs `.github/workflows/platformclaw-ci.yml` on pull
requests, pushes to `main`, and manual dispatches. It uses a GitHub-hosted Ubuntu
runner with the repository-scoped read-only `GITHUB_TOKEN` and performs:

- changed-surface OpenClaw checks;
- focused PlatformClaw control-plane tests; and
- the PlatformClaw control-plane package build.

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

Do not copy OpenClaw GitHub App private keys or release secrets into the
PlatformClaw repository to make an unrelated upstream workflow pass.
