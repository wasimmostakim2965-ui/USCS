# Cloud Wai router image — this deployment's own front door.
#
# Build from the repository root:
#   docker build -f infra/deployment/router.Dockerfile -t cloud-wai-router .
#
# This image runs `infra/deployment/router-server.mjs`: it maps a public
# hostname to a loopback app port and terminates TLS, issuing certificates with
# ACME (Let's Encrypt) and falling back to a self-signed certificate so a host
# is never served without TLS. It is what makes a verified domain resolve to a
# running container rather than merely being recorded.
#
# Unlike the runtime and builder it holds no Docker socket — it only forwards
# HTTP and speaks ACME — so it is a separate, least-privileged image.

FROM node:22-bookworm-slim

WORKDIR /app

# The router's small dependency set (acme-client, selfsigned) is pinned in the
# deployment package and its lockfile, so `npm ci` reproduces the exact tree
# without the monorepo.
COPY infra/deployment/package.json infra/deployment/package-lock.json /app/
RUN npm ci --omit=dev --no-audit --no-fund

COPY infra/deployment/router-server.mjs /app/router-server.mjs

# Certificates and ACME account state live here; mount a volume so a restart
# does not re-issue them.
VOLUME ["/data"]

EXPOSE 80 443 8096

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ROUTER_ADMIN_PORT||8096)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/app/router-server.mjs"]
