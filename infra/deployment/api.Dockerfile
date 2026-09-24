# Cloud Wai API image.
#
# Build from the repository root:
#   docker build -f infra/deployment/api.Dockerfile -t cloud-wai-api .
#
# The runtime carries the built workspace as-is. That is deliberate: a pnpm
# workspace is a graph of relative symlinks between `node_modules` directories,
# and hand-picking files to copy is the kind of layout guess that works here and
# fails on a server. Copying the resolved tree keeps every symlink valid. The
# build stage is still separate so the runtime carries no compiler.
#
# The API owns no data of its own: it talks to Supabase for identity and the
# control plane, and to engines through the adapters. An unconfigured deployment
# exits non-zero at start (see apps/api/src/main.ts) rather than serving an API
# that authenticates nobody.

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# Manifests first, so a source-only change does not re-resolve dependencies.
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
ENV HOST=0.0.0.0
ENV PORT=8787

# The whole resolved workspace: node_modules trees, workspace symlinks, package
# manifests and the compiled `dist` output. The TypeScript sources are dropped
# because the image runs built JavaScript only; the declaration files inside
# `dist` are kept, since removing them buys nothing and risks a wrong prune.
COPY --from=build /repo /repo
RUN find /repo -type d -name src -not -path "*/node_modules/*" -prune -exec rm -rf {} + \
  && find /repo -name "*.tsbuildinfo" -delete

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8787) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
