# Cloud Wai dashboard image.
#
# Build from the repository root:
#   docker build -f infra/deployment/web.Dockerfile \
#     --build-arg VITE_CLOUD_WAI_API_URL= --build-arg VITE_SUPABASE_URL=... \
#     --build-arg VITE_SUPABASE_ANON_KEY=... -t cloud-wai-web .
#
# The dashboard is served by nginx, which also reverse-proxies `/rpc` and
# `/healthz` to the API. Serving both from one origin is the deployment shape the
# blueprint wants: the browser makes same-origin requests, so no CORS allow-list
# is involved and the API's allowed-origin setting stays empty. Point
# `API_UPSTREAM` at the API service (e.g. `http://api:8787`).
#
# The `VITE_*` values are compiled into the bundle, so they are build arguments,
# not runtime environment. `VITE_SUPABASE_ANON_KEY` is public by design; the
# service-role key is never part of this image.

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

ARG VITE_CLOUD_WAI_API_URL=""
ARG VITE_SUPABASE_URL=""
ARG VITE_SUPABASE_ANON_KEY=""
ENV VITE_CLOUD_WAI_API_URL=$VITE_CLOUD_WAI_API_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

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
# `build:web` bundles the browser app, but it imports `@cloud-wai/ui` and
# `@cloud-wai/contracts` through their built `dist` entry points, so those must
# exist first. The workspace `build` produces them.
RUN pnpm build && pnpm --filter @cloud-wai/web build:web

# --- runtime -----------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# The dashboard bundle and its static assets.
COPY --from=build /repo/apps/web/dist/browser /usr/share/nginx/html

# `envsubst` (part of the base image) substitutes API_UPSTREAM at container start,
# so the same image works in any environment without a rebuild.
ENV API_UPSTREAM=http://api:8787
COPY infra/deployment/nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 8080
