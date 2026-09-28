# Cloud Wai build-plane image.
#
# Build from the repository root:
#   docker build -f infra/deployment/builder.Dockerfile -t cloud-wai-builder .
#
# This image runs `infra/deployment/builder-server.mjs`, the process the
# Railpack build adapter speaks to (packages/adapters/src/build-railpack.ts). It
# is deliberately separate from the API and worker images because it is the one
# component that runs untrusted customer source and needs the Docker socket:
# keeping it in its own image means a compromised build cannot read the API's
# environment or reach anything the API can.
#
# The Dockerfile installs the **Nixpacks CLI binary**, not a `docker run` of the
# published `ghcr.io/railwayapp/nixpacks` image. Those images are the generated
# Dockerfiles' base images — their CMD is `/bin/bash` and they contain no
# `nixpacks` executable — so the `docker run … build` form the server once used
# failed with `exec: "build": executable file not found in $PATH` on every
# build. The binary is pinned by version and verified by checksum.
#
# The server drives Nixpacks, which drives the host Docker daemon through
# `--buildkit-host`/`DOCKER_HOST`; mount the socket at run time (see the compose
# file). The version is pinned so two builds of the same source produce the same
# image, matching the repository's engine-versioning rule.

# --- fetch the pinned Nixpacks binary ----------------------------------------
FROM debian:bookworm-slim AS nixpacks

ARG NIXPACKS_VERSION=1.41.0
# The release publishes no `.sha256` asset, so the tarball is pinned by its own
# digest instead. `194bcad8…` is the v1.41.0 x86_64 GNU build; bumping the
# version means re-pinning this line, which is the point — a silent swap of the
# builder between two deploys is what the pin exists to prevent.
ARG NIXPACKS_SHA256=194bcad8c379f78a309eee1a88b2e6b2abc59f354efe7ecd7b4bbaf21de99a06

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  base="https://github.com/railwayapp/nixpacks/releases/download/v${NIXPACKS_VERSION}"; \
  file="nixpacks-v${NIXPACKS_VERSION}-x86_64-unknown-linux-gnu.tar.gz"; \
  curl -fsSL -o "/tmp/${file}" "${base}/${file}"; \
  echo "${NIXPACKS_SHA256}  /tmp/${file}" > /tmp/nixpacks.sha256; \
  sha256sum -c /tmp/nixpacks.sha256; \
  tar -xzf "/tmp/${file}" -C /usr/local/bin nixpacks; \
  chmod +x /usr/local/bin/nixpacks; \
  /usr/local/bin/nixpacks --version

# --- runtime -----------------------------------------------------------------
# The runtime base carries the Docker CLI (so Nixpacks can build) and a Node
# runtime (so the server runs), and nothing else it does not need.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       git \
       gnupg \
       openssh-client \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
       -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
       https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY --from=nixpacks /usr/local/bin/nixpacks /usr/local/bin/nixpacks

# `nixpacks` drives the daemon the socket is mounted from; the CLI defaults to
# /var/run/docker.sock, so nothing extra is needed beyond the mount.
ENV NIXPACKS_BIN=/usr/local/bin/nixpacks

WORKDIR /app
COPY infra/deployment/builder-server.mjs /app/builder-server.mjs

# The builder reaches the daemon as a socket that is usually root-owned; running
# as root is the pragmatic choice for the one privileged component, and it is
# isolated from the API/worker by being its own image and network.
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.BUILDER_PORT||8090) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/builder-server.mjs"]
