# Package And Docker Proof

Read this for package installation, plugin trust, Docker/live lane selection,
or a failed package/Docker run. Root `AGENTS.md` and user host policy still own
execution and credentials. Use local Linux Docker for PlatformClaw deployment
proof when permitted. Before using hosted proof, verify the target repository's
workflow, runner, and secret capabilities; private downstream workflows differ
from `openclaw/openclaw`. Do not enable upstream automation or dispatch to a
public repository merely because an example names it.

## Plugin Package Shape And Trust

Prove packaging and trust separately, in isolated test state:

- A local release-candidate tarball installed with
  `openclaw plugins install npm-pack:<candidate.tgz> --force` exercises the
  managed per-plugin npm dependency path. A raw archive/path install does not
  establish the same dependency behavior.
- `npm-pack:` alone does not establish official trust. If behavior depends on
  trusted official status, add a catalog-backed official or published-package
  proof that records that trust; do not weaken the gate for a local fixture.
- Inspect the tarball's `package/package.json`, expected runtime files, bundled
  dependencies when enabled, and absence of npm lockfiles. Runtime imports
  belong in `dependencies` or `optionalDependencies`; manually installing a
  missing package inside managed state cannot be the final proof.
- When runtime dependency ownership changes, include the repository's transient
  npm package-lock check and inspect the packed payload.
- Restart only the proof-owned Gateway after changes to registration, runtime
  loading, privileged helpers, provider routing, or generated dist. Remove
  temporary provider/channel config and verify cleanup before handoff.

For a plugin release matrix, read
[release-openclaw-plugin-testing](../../release-openclaw-plugin-testing/SKILL.md).

## Package Candidate Identity

Package Acceptance validates one installable tarball; normal CI validates source.
Read `docs/ci.md#package-acceptance` and
`docs/help/testing-updates-plugins.md` when selecting its inputs.

- Pin an exact package version or full source SHA for recovery and comparisons.
  Resolve and record a moving npm dist-tag only when the task asks for that tag;
  do not silently substitute another tag or package if it is broken or stale.
- Keep the trusted workflow/harness revision separate from the package revision.
  `workflow_ref` selects the harness; `package_ref` selects what `source=ref`
  packs. Record the resolved version, source SHA, digest, and artifact identity.
- Use `source=npm` for supported OpenClaw registry specs, `source=ref` for trusted
  source, `source=url` for an HTTPS tarball with required SHA-256, or
  `source=artifact` for a named Actions tarball. Consult current workflow inputs
  for additional source policies; do not invent a private mirror bypass.
- Select the smallest matching profile: `smoke`, `package`, `product`, `full`,
  or `custom` with exact `docker_lanes`. Inspect lane and credential requirements
  before selecting broad product coverage or Telegram/live proof.

All selected package, Docker, and optional channel checks must consume the same
resolved tarball. A narrow green rerun does not authorize publishing. Release
Code SHA/Release SHA rules, full-validation dispatch, evidence reuse, and parent
verifier recovery belong to
[release-openclaw-ci](../../release-openclaw-ci/SKILL.md).

## Plan Docker Before Running It

For trusted source, inspect the scheduler without building or running Docker:

```bash
node scripts/test-docker-all.mjs --plan-json
```

Select a lane through `OPENCLAW_DOCKER_ALL_LANES`. For example, in a Linux Bash
shell, inspect only the failed lane before running that same selection:

```bash
OPENCLAW_DOCKER_ALL_LANES=<lane> node scripts/test-docker-all.mjs --plan-json
OPENCLAW_DOCKER_ALL_LANES=<lane> node scripts/test-docker-all.mjs
```

The plan owns lane selection, image kinds, package/live-image requirements,
state scenarios, and credential checks. Lane definitions live in
`scripts/lib/docker-e2e-scenarios.mjs`; planning lives in
`scripts/lib/docker-e2e-plan.mjs`. Avoid copied lane/chunk catalogs: aliases can
expand to multiple shards. Inspect the resolved plan and budget before running.

`scripts/package-openclaw-for-docker.mjs` is the shared local/CI packer and
validates the package inventory. Bare lanes mount that prebuilt tarball;
functional images install it. Copied checkout sources are not package proof.
Reuse prepared images only when their candidate identity and required contents
match. Do not skip builds or preflight merely to make a rerun faster.

## Recover From Artifacts

Read `.artifacts/docker-tests/**/summary.json`, `failures.json`, and the relevant
lane log before rerunning. Check status, timeout, exact target, image kind,
`rerunCommand`, and phase timings. A timeout needs diagnosis before repetition.

The existing helpers can rank timings and print targeted rerun commands:

```bash
node scripts/docker-e2e-timings.mjs <summary.json>
node scripts/docker-e2e-rerun.mjs <failures.json>
node scripts/docker-e2e-rerun.mjs <run-id> --repo <owner/repo>
```

For a run id, the rerun helper downloads the relevant artifacts. It prints
commands; review the target repository, trusted workflow ref, exact package SHA,
selected lanes, and credential requirements before dispatch. Combine failed
lanes only when they share the same candidate. Preserve an upgrade lane's
recorded baseline as well as its candidate.

A fresh hosted run may need to rebuild runner-local images. Generated image
reuse inputs apply only when the artifact proves reusable GHCR image identity;
do not substitute local tags or images from another SHA. Rerun the affected
lane first, then broaden only for the changed contract or unresolved failure.
