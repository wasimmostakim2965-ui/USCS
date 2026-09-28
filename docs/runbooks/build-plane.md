# Running the build plane

The build plane turns a Git repository into a runnable OCI image. It is the step
Vercel puts at the centre of its own architecture (upload → **build** → request)
and the one port this platform was missing before ADR-0018. This runbook is the
operator's side of it: what runs, where the credentials go, and what the limits
are.

Two components are involved and they are separate on purpose:

| Piece | What it is | Where it runs |
| --- | --- | --- |
| Build adapter | `packages/adapters/src/build-railpack.ts` | inside the API and worker |
| Build service | `infra/deployment/builder-server.mjs` | `infra/deployment/builder.Dockerfile` |

The API and worker never run Nixpacks; they call the build service over HTTP
through the adapter. The browser never reaches either.

## Why it is its own container

The builder is the only component that executes untrusted customer source, and
it is the only one given the Docker socket (a build must produce an image in the
daemon the runtime deploys from). Anything that can talk to the socket can start
a container, so the socket is mounted into **only** the builder. The API and
worker images never receive it, which is why the builder is not folded into them
even though it would have been fewer moving parts.

The service is opt-in. A host that runs no builder sets no `BUILDER_TOKEN`; the
build adapter then reports `not_configured` and a serverless or preview deploy
stops with that as the reason — never with a fabricated artifact.

## Shape A — single host (one shared builder)

This is what `infra/deployment/docker-compose.yml` (profile `build`) and
`infra/deployment/deploy.sh` give you: one builder container on the host, with a
single `BUILDER_TOKEN`, reached by every organization at
`http://builder:8090` (all-container) or `http://127.0.0.1:8090` (host
processes). It is published on loopback only, never a public interface.

```sh
# compose (API/worker/web also containers)
BUILDER_TOKEN=$(openssl rand -hex 32) docker compose \
  -f infra/deployment/docker-compose.yml --profile build up -d --build

# or the one-command path, which starts the builder and wires every existing org
./infra/deployment/deploy.sh
```

Per organization, set the endpoint and token in the environment the **API and
worker** read:

```sh
BUILD_ENGINE_URL__<organizationId>=http://builder:8090      # or 127.0.0.1:8090
BUILD_ENGINE_TOKEN__<organizationId>=<the BUILDER_TOKEN>
```

One builder, one token, many organizations, is a **shared** trust boundary: a
build for tenant A runs on the same daemon as a build for tenant B. That is
acceptable when the hosted projects are the operator's own or a small, trusted
set. It is not a hard multi-tenant boundary — Nixpacks builds run as containers
with the daemon's reach. Use shape B when the tenants are not mutually trusted.

## Shape B — builder per tenant (hardened)

For untrusted tenants, run one builder per organization and point each
organization's `BUILD_ENGINE_URL__<organizationId>` at its own instance. Each
builder has its own daemon (its own host or its own nested daemon), its own
`BUILDER_TOKEN`, and its own resource limits. The adapter needs no change: the
per-organization credential is already the boundary (the same model as Coolify's
one-team-per-tenant, ADR-0002). Nothing else in this repository assumes a shared
builder.

## What the service bounds

Every bound is configuration, applied where untrusted input arrives, because the
builder is the component a broken or hostile repository can exhaust:

| Variable | Default | Why |
| --- | --- | --- |
| `BUILDER_CONCURRENCY` | `2` | Builds run at once. Excess builds wait in FIFO order rather than fail, so one tenant's build storm does not deny every other tenant. |
| `BUILDER_BUILD_TIMEOUT_MS` | `900000` | A build that does not finish is killed and reported as a timeout, so a hung `npm install` cannot hold a slot forever. |
| `BUILDER_MAX_LOG_LINES` | `5000` | A log that prints forever is capped, and the truncation is written into the log so it is visible rather than silent. |
| `BUILDER_JOB_TTL_MS` | `3600000` | Finished jobs and their logs are dropped after this, so a long-lived builder does not grow without bound. |

Cancellation is real: `POST /builds/:id/cancel` marks the job and the build
either stops before it starts or is reported cancelled, so the adapter's
`cancelBuild` has an effect rather than a no-op.

## How a build runs

1. The adapter `POST /builds` with the source and the platform's idempotency
   key; a replayed key returns the same job id, so a retry cannot produce a
   second image.
2. The service clones the source, runs the pinned Nixpacks binary
   (`nixpacks build <dir> --name <tag>`), then `nixpacks plan --format json` to
   record the detected framework.
3. The adapter polls `GET /builds/:id` until the artifact exists. "Still running"
   is `degraded`; "finished with nothing" is `failed`; the two are never
   confused, so a caller never retries a finished failure forever.

Nixpacks is invoked as a **binary**, not as `docker run <nixpacks-image> build`.
The published `ghcr.io/railwayapp/nixpacks` images are the generated Dockerfiles'
*base* images: their CMD is `/bin/bash` and they carry no `nixpacks` executable,
so the `docker run … build` form fails on every build with
`exec: "build": executable file not found in $PATH`. `builder.Dockerfile` pins
the binary by version and digest and installs the Docker CLI **and the buildx
plugin**, which Nixpacks requires.

## Verifying it honestly

```sh
# 1. The service is up (it is loopback-only, so reach it from the host).
curl -fsS http://127.0.0.1:8090/healthz          # {"status":"ok"}

# 2. It refuses an unauthenticated build.
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8090/builds -d '{}'   # 401

# 3. A real build produces a real image. (A local path works because the service
#    clones it; use a git URL in production.)
ID=$(curl -s -X POST http://127.0.0.1:8090/builds \
  -H "Authorization: Bearer $BUILDER_TOKEN" -H 'content-type: application/json' \
  -d '{"source":{"kind":"git","repository":"https://github.com/<you>/<repo>"},"idempotencyKey":"smoke"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s http://127.0.0.1:8090/builds/$ID -H "Authorization: Bearer $BUILDER_TOKEN"
# -> {"status":"succeeded","artifact":{"image":"cloudwai-…","framework":"node"}}

# 4. The image exists in the daemon the runtime deploys from.
docker images | grep cloudwai-
```

An unset builder is a passing state too: Security → Engine status shows the
build engine `not_configured`, and that is the honest answer, not a failure.

## What this does not yet do

- **A registry.** The image is tagged in the local daemon. Promoting a built
  artifact to a *different* host needs a registry push; the adapter's artifact
  carries whatever image reference the builder returns, so wiring a registry is a
  change to the builder's tag, not to the port.
- **Per-build resource limits.** `BUILDER_CONCURRENCY` caps how many builds run,
  but a single build's CPU/memory is not capped here; enforce that on the builder
  host (cgroup limits or shape B's per-tenant host).
- **Build caching.** Nixpacks caches within a build; a cross-build cache needs a
  cache volume, which is an operator addition.
