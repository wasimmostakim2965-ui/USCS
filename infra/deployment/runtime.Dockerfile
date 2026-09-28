# Cloud Wai self-hosted runtime image.
#
# Build from the repository root:
#   docker build -f infra/deployment/runtime.Dockerfile -t cloud-wai-runtime .
#
# This image runs `infra/deployment/runtime-server.mjs`, this platform's own
# container runtime — the piece Coolify supplied before. It needs the Docker CLI
# because it starts the containers it deploys, and the socket is mounted at run
# time (see the compose file). Like the builder it is a separate image from the
# API and worker: the component that holds the daemon socket must not also hold
# the control plane's environment.

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       gnupg \
  && install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/debian/gpg \
       -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
       https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
       > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY infra/deployment/runtime-server.mjs /app/runtime-server.mjs

# The runtime holds only its own state: which image is live per app and its port.
# It never reads the control plane's database or the builder's internals.
EXPOSE 8095

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RUNTIME_PORT||8095)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/runtime-server.mjs"]
