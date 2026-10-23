# Security and release contracts

Read before credentials/security, dependency policy, releases, backports, version changes, or publishing. Read this guide in full. The [root policy](../../AGENTS.md) owns hard gates, task routing, and validation-environment selection. Paths and commands here are relative to the repository root.

## Security / Release

- Never commit real phone numbers, videos, credentials, live config.
- Secrets: channel/provider creds in `~/.openclaw/credentials/`; model auth profiles in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
- SecretRef failures isolate to the smallest known owning surface. Proven-inactive surfaces skip; unknown ownership fails closed. Gateway refuses startup only when its own ingress protection cannot be established, config is structurally invalid, or the owning surface is unknown. Otherwise start, mark the exact capability/account/route configured-unavailable, emit a typed redacted diagnostic, and forbid implicit credential fallback. On reload, retain last-known-good only for an unchanged ref+provider; a changed unresolved ref makes that owner cold. Doctor and status must list every degraded owner.
- Dependency patches/overrides/vendor changes need explicit approval. `pnpm-workspace.yaml` patched dependencies use exact versions only.
- Release/package guards: no hard-coded retired-package denylists; use generic artifact/dependency checks or fix build source.
- `pnpm-lock.yaml` is the product dependency security review surface; `.github/release/clawhub-cli/package-lock.json` separately pins trusted release tooling. Published packages bundle runtime dependencies where configured and never ship lockfiles; other npm-format locks exist only transiently during checks and publish staging.
- Carbon pins owner-only: do not change `@buape/carbon` unless Shadow (`@thewilloftheshadow`, verified by `gh`) asks.
- Releases/publish/version bumps need explicit approval. Use `$release-openclaw-maintainer`.
- Active release scope lock: freeze the operator-selected cut SHA and release identity through publish and verification. Moving `main`, unrelated CI, optional backports, refactors, cleanup, and normal forward-ports are not part of the release work queue.
- Touch `main` during a release only when the operator requests it or the smallest critical main-owned blocker prevents that release. Return to the release branch immediately; defer broader main work until closeout.
- Release versions use `YYYY.M.PATCH`, where `PATCH` is a sequential monthly release-train number, never the calendar day. Stable and beta tags determine the current train; alpha-only tags do not consume or advance the beta/stable patch number. After `2026.6.5`, the next beta train is `2026.6.6-beta.1` even if higher alpha-only tags exist.
- Alpha/nightly versions use the next unreleased train plus an incrementing prerelease number. Repeated nightlies for the same train increment only `alpha.N`; they must not mint a new patch number from the date.
- Backports are optional. Apply only the operator-selected set; when requested without a target, use the newest open `release/` branch.
- Regular beta/stable flow has two immutable identities:
  - **Code SHA**: version prep plus any optional backports/release fixes, with no release changelog mutation. Full product validation belongs here.
  - **Release SHA**: a descendant of the green Code SHA whose complete diff is exactly `CHANGELOG.md`. Tag, npm preflight, package/install acceptance, and publish belong here.
- Never generate the release changelog before the Code SHA has green Full Release Validation. A product/code failure changes the Code SHA and restarts product validation. A workflow/harness/infrastructure failure is fixed in trusted tooling and rerun against the same Code SHA; do not mutate the candidate to satisfy newer tooling.
- After green Code SHA validation, generate and review `CHANGELOG.md` once. Dispatch Full Release Validation for the Release SHA with evidence reuse enabled; `changelog-only-release-v1` may reuse the Code SHA product evidence only when GitHub independently proves the entire descendant delta is `CHANGELOG.md`. Any other path change requires a new Code SHA and fresh full validation.
- Release-SHA proof is intentionally narrow: release-note/provenance checks, npm preflight/package bytes, install/update acceptance, and publish readiness. Do not rerun the full product matrix merely because the changelog changed.
- Pass the successful Release-SHA validation run and npm preflight run into `release:candidate`; do not let the candidate helper dispatch duplicate copies of evidence that already passed.
- Keep one release operator and one watcher per release identity. Resume partial publish from successful immutable child artifacts/runs; never rebuild or republish an already-published package version.
- GHSA/advisories: `$openclaw-ghsa-maintainer` / `$security-triage`. Secret scanning: `$openclaw-secret-scanning-maintainer`.
- Beta tag/version match: `vYYYY.M.PATCH-beta.N` -> npm `YYYY.M.PATCH-beta.N --tag beta`.
