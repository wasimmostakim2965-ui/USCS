# Cloud Wai self-hosted database engine image.
#
# Build from the repository root:
#   docker build -f infra/deployment/postgres.Dockerfile -t cloud-wai-postgres .
#
# This image runs `infra/deployment/postgres-server.mjs`, the engine that
# provisions, backs up and restores the tenant databases on a host that owns its
# runtime. It needs the Docker CLI because it starts the Postgres containers it
# manages, and the socket is mounted at run time (see the compose file). Like the
# runtime and the builder it is a separate image from the API and worker: the
# component that holds the daemon socket must not also hold the control plane's
# environment.
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
COPY infra/deployment/postgres-server.mjs /app/postgres-server.mjs

# The engine holds its own state: which database container serves each id, its
# host port, and the backups it wrote. It never reads the control plane.
EXPOSE 8097

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.POSTGRES_ENGINE_PORT||8097)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/postgres-server.mjs"]
