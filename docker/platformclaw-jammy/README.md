# PlatformClaw Jammy image

This profile repackages the current, validated OpenClaw application image into
an Ubuntu 22.04 runtime. It does not duplicate the upstream application build.

Build the application image first:

```bash
docker build -t openclaw:local .
```

For a public Ubuntu build, omit the optional secret:

```bash
docker build \
  -f docker/platformclaw-jammy/Dockerfile \
  -t platformclaw:jammy .
```

For a company build, point the secret at the approved Jammy `sources.list`.
Never add that file or its internal URLs to Git:

```bash
docker build \
  --secret id=company_apt_sources,src=/secure/company-jammy.list \
  -f docker/platformclaw-jammy/Dockerfile \
  -t platformclaw:jammy .
```

Alternatively, place the approved file at
`docker/platformclaw-jammy/company-jammy.list` (it is gitignored) and run:

```bash
docker compose -f docker/platformclaw-jammy/compose.yaml build
```

Optional runtime packages are supplied with `PLATFORMCLAW_APT_PACKAGES` and
`PLATFORMCLAW_PIP_PACKAGES` build arguments. Build the matching sandbox with:

```bash
docker build \
  --secret id=company_apt_sources,src=/secure/company-jammy.list \
  -f scripts/docker/sandbox/Dockerfile.jammy \
  -t openclaw-sandbox:jammy .
```

Validate the final artifact before transfer:

```bash
docker run --rm platformclaw:jammy cat /etc/os-release
docker run --rm platformclaw:jammy node --version
docker save platformclaw:jammy -o platformclaw-jammy.tar
```
