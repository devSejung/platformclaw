# syntax=docker/dockerfile:1.7

# Repackage the validated upstream application image into the company runtime.
# Build the source image with the root Dockerfile before building this file.
ARG OPENCLAW_SOURCE_IMAGE=openclaw:local
FROM ${OPENCLAW_SOURCE_IMAGE} AS source

FROM ubuntu:22.04

ARG OPENCLAW_NODE_VERSION=24.15.0
ARG OPENCLAW_NODE_SHA256_AMD64=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
ARG OPENCLAW_NODE_SHA256_ARM64=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0
ARG PLATFORMCLAW_APT_PACKAGES=""
ARG PLATFORMCLAW_PIP_PACKAGES="markdown pygments"

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# company_apt_sources is optional. It must contain a complete Jammy sources.list.
# Keeping it as a BuildKit secret prevents private repository URLs entering Git.
RUN --mount=type=secret,id=company_apt_sources,required=false \
    set -eux; \
    if [ -f /run/secrets/company_apt_sources ]; then \
      rm -f /etc/apt/sources.list.d/*.list; \
      cp /run/secrets/company_apt_sources /etc/apt/sources.list; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git hostname jq locales lsof openssh-client openssl procps sshpass \
      python3 python3-pip python3-venv ripgrep tini tzdata xz-utils \
      ${PLATFORMCLAW_APT_PACKAGES}; \
    locale-gen ko_KR.UTF-8; \
    ln -snf /usr/share/zoneinfo/Asia/Seoul /etc/localtime; \
    echo Asia/Seoul >/etc/timezone; \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64; node_sha="$OPENCLAW_NODE_SHA256_AMD64" ;; \
      arm64) node_arch=arm64; node_sha="$OPENCLAW_NODE_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    archive="node-v${OPENCLAW_NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${OPENCLAW_NODE_VERSION}/${archive}"; \
    printf '%s  %s\n' "$node_sha" "$archive" | sha256sum -c -; \
    tar -xJf "$archive" -C /usr/local --strip-components=1; \
    rm "$archive"; \
    node --version

RUN if [ -n "$PLATFORMCLAW_PIP_PACKAGES" ]; then \
      python3 -m pip install --no-cache-dir $PLATFORMCLAW_PIP_PACKAGES; \
    fi

RUN groupadd --gid 1000 node && \
    useradd --create-home --uid 1000 --gid 1000 --shell /bin/bash node

COPY --from=source --chown=node:node /app /app

ENV LANG=ko_KR.UTF-8 \
    LANGUAGE=ko_KR:ko:en_US:en \
    LC_ALL=ko_KR.UTF-8 \
    TZ=Asia/Seoul \
    NODE_ENV=production \
    COREPACK_HOME=/usr/local/share/corepack

RUN install -d -m 0755 "$COREPACK_HOME" && \
    corepack enable && \
    corepack prepare "$(node -p "require('./package.json').packageManager")" --activate && \
    chmod -R a+rX "$COREPACK_HOME" && \
    chown -R node:node /home/node

USER node
EXPOSE 18789
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:18789/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "gateway", "--allow-unconfigured", "--bind", "lan", "--port", "18789"]
