# Cloud Wai worker image.
#
# Build from the repository root:
#   docker build -f infra/deployment/worker.Dockerfile -t cloud-wai-worker .
#
# The worker drains the orchestration queue. It holds the service-role database
# credentials, which never reach a browser, and it exits non-zero at start when
# the control plane is unset (see apps/worker/src/main.ts) rather than looping
# over an empty queue and looking healthy.

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/orchestrator/package.json apps/orchestrator/
COPY apps/security-control/package.json apps/security-control/
COPY packages/contracts/package.json packages/contracts/
COPY packages/security/package.json packages/security/
COPY packages/database/package.json packages/database/
COPY packages/authorization/package.json packages/authorization/
COPY packages/auth/package.json packages/auth/
COPY packages/adapters/package.json packages/adapters/
COPY packages/observability/package.json packages/observability/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo /repo
RUN find /repo -type d -name src -not -path "*/node_modules/*" -prune -exec rm -rf {} + \
  && find /repo -name "*.tsbuildinfo" -delete

USER node

# No HEALTHCHECK port: liveness for a queue drainer is "the process is running".
# A wedged worker shows up in the queue's lease/reap metrics, not in a socket.
CMD ["node", "apps/worker/dist/main.js"]
