---
name: release-platformclaw
description: Prepare, verify, upload, and publish PlatformClaw VM preview releases with the canonical tag, title, release-note sections, image transfer archive, home-managed deployment bundle, checksums, and manifest. Use for PlatformClaw preview release creation, replacement assets, release-format audits, or company-transfer artifact preparation.
---

# Release PlatformClaw

Create only VM preview prereleases until a stable PlatformClaw release contract is approved.

## Workflow

1. Read `PLATFORMCLAW.md`, `docs/upstream/status.md`, and
   `docker/platformclaw-runtime/README.md`.
2. Require a clean, pushed target SHA. Record branch, full SHA, package version,
   and relevant PR.
3. Run PlatformClaw validation selected by repository policy. Build on Linux:

   ```bash
   node scripts/platformclaw-build.mjs \
     --version <version> \
     --output-dir .artifacts/platformclaw-release
   ```

4. Prepare canonical assets:

   ```bash
   node .agents/skills/release-platformclaw/scripts/prepare-release.mjs \
     --image-tar .artifacts/platformclaw-release/platformclaw-<version>-<sha12>.tar \
     --output-dir .artifacts/platformclaw-release \
     --date YYYY-MM-DD
   ```

5. Edit generated `release-notes.md`. Follow
   `references/release-notes-template.md`. Remove every `TODO`.
6. Read public `release-manifest.json` and local
   `release-upload-plan.local.json`. Verify tag, target SHA, checksums, sizes,
   and every local upload path before any GitHub mutation. Never upload the
   local plan because it contains builder paths.
7. Create a draft prerelease targeting exact SHA. Never target a moving branch:

   ```bash
   gh release create <tag> \
     --target <full-sha> \
     --title "PlatformClaw VM Preview YYYY-MM-DD" \
     --notes-file <release-notes.md> \
     --prerelease \
     --draft
   ```

8. Upload exactly the local plan `uploadPaths` with
   `gh release upload <tag> <paths...>`. This includes the four checksummed
   assets and the manifest itself; the manifest cannot checksum itself.
9. Re-read live release and asset digests with `gh api`. Publish only after
   target SHA, notes, assets, and validation evidence match:

   ```bash
   gh release edit <tag> --draft=false --prerelease
   ```

## Canonical contract

- Tag: `platformclaw-vm-preview-YYYYMMDD`
- Title: `PlatformClaw VM Preview YYYY-MM-DD`
- Target: exact tested full commit SHA
- Type: prerelease
- Image archive: `platformclaw-<version>-<sha12>.tar`
- Runtime refs: `platformclaw:<sha12>` and `platformclaw-sandbox:<sha12>`;
  reusable version tags are not deployment or rollback identities
- Deployment bundle: `platformclaw-deployment-<version>-<sha12>.tar.gz`
- Checksums: adjacent `.sha256` files
- Manifest: `release-manifest.json`

Deployment bundle must contain `compose.yaml`, `platformclaw-compose`,
`platformclaw-deploy`, `deployment.env.example`, migration helpers, and Korean
operator runbook. Never upload `.env`, `deployment.env`, secrets, certificates,
runtime databases, logs, or user workspaces.

## Recovery

- Wrong draft asset: delete/replace while draft; re-run digest verification.
- Published release mismatch: do not silently replace immutable evidence.
  Create corrected dated preview unless user explicitly authorizes asset repair.
- Build or proof failure: keep release draft or delete empty draft. Never publish.
