# Build the PlatformClaw Jammy images

PlatformClaw is built outside the company network and transferred as a Docker
archive. The exported archive contains the Ubuntu 22.04 Jammy gateway image and
the matching Jammy sandbox image. Build-only OpenClaw stages are not exported.

## Build and export

From the repository root on Windows:

```powershell
node scripts/platformclaw-build.mjs
```

The command first creates a Jammy Node build base, then runs the current
upstream `runtime-assets` target on that base. This keeps native dependencies
compatible with Jammy. It layers the selected PlatformClaw tools into the
runtime image, runs image smoke checks, and writes:

```text
.artifacts/platformclaw/platformclaw-<version>-<git-sha>.tar
.artifacts/platformclaw/platformclaw-<version>-<git-sha>.tar.sha256
```

The working tree must be clean. Use `--no-export` for build and smoke checks
without creating the transfer archive.

The image contains the selected OpenClaw production dependencies and the
PlatformClaw command-line tools. It does not contain an npm or pnpm download
cache. Select every plugin required inside the disconnected network at build
time so its production dependencies are included:

```powershell
node scripts/platformclaw-build.mjs --extensions "plugin-a,plugin-b"
```

Installing a new npm package or plugin after transfer still requires an
approved internal registry or a newly built image. Runtime credentials and
configuration are not baked into the image.

Only the two final images are written to the archive. The larger Jammy build
base and OpenClaw `runtime-assets` image remain local build intermediates.

## Check image size

Compare final images with the image metadata size, not the size displayed for
local build stages or shared Docker Desktop snapshots:

```powershell
docker image inspect platformclaw:<version> --format '{{.Size}}'
docker image inspect platformclaw-sandbox:<version> --format '{{.Size}}'
```

The build script exports only `platformclaw:<version>` and
`platformclaw-sandbox:<version>`. Images named `platformclaw-jammy-build` and
`platformclaw-runtime-assets` are build intermediates and are not transferred.

## Use a private apt mirror

Keep private repository URLs outside Git. Pass an apt sources file as a
BuildKit secret:

```powershell
node scripts/platformclaw-build.mjs --apt-sources C:\secure\jammy.sources.list
```

The file is available only while apt packages are installed and is not copied
into an image layer.

## Import on Ubuntu

Verify the archive before loading it:

```bash
sha256sum -c platformclaw-<version>-<git-sha>.tar.sha256
docker load -i platformclaw-<version>-<git-sha>.tar
docker image inspect platformclaw:<version>
docker image inspect platformclaw-sandbox:<version>
```

Runtime credentials, configuration, workspaces, and user data remain external
to the image and must be injected through the approved runtime configuration.
