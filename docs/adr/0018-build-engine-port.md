# ADR-0018: A build engine port, so Git source becomes a deployable artifact

- Status: accepted
- Date: 2026-09-24

## Context

The platform has five engine ports — hosting (Coolify), serverless (Lambda),
database (Postgres), storage (MinIO), security edge — and one non-engine port
(domain verification). `execution-router.ts` already documents the gap in its own
comment: a serverless deploy requires a built artifact, *"No build engine is
configured to produce one, so the step is not performed rather than faked."*
Until now there was no port through which a build could be requested at all, so a
serverless project reported `not_configured` for a missing build rather than a
missing credential.

Vercel's own architecture puts a build step at the centre: a build container
takes the source, runs the framework build, and classifies the output into static
assets, serverless functions and edge functions, writing a metadata document that
the request phase routes by. The equivalent layer here was absent.

## Decision

Add a `BuildEngine` port. It is the only new port this rewrite introduces.

1. **One port, engines behind it.** `BuildEngine` lives in
   `packages/adapters/src/` alongside the other ports. It exposes a build request
   that returns an artifact reference, plus log streaming and cancel. Routers
   never call a builder directly — the same rule as every other engine
   (ADR-0001).

2. **Railpack is the first adapter.** Railway's BuildKit-based builder is the
   successor to Nixpacks, which is in maintenance mode. It turns a source
   directory into an OCI image with no configuration, which is the "framework
   auto-detect" behaviour Vercel describes. Cloud Native Buildpacks / Paketo is
   the documented alternative and may be added behind the same port.

3. **A serverless project stops being blocked by a missing build.** Once the port
   is wired through `execution-router.ts`, a serverless deploy receives a real
   artifact; a container project continues to be built by Coolify as before, and
   is never handed to the serverless engine or the reverse.

4. **Honesty is unchanged.** With no builder configured, a build reports
   `not_configured`. It never invents an artifact, and it never reports success
   for a build it did not run.

5. **We do not write a builder.** The engines are proven; we write the wiring.
   This is the same reasoning as ADR-0002 for Coolify.

## Consequences

- The serverless path becomes end-to-end: source → artifact → runtime.
- The deployment pipeline (upload → build → classify → deploy) becomes
  expressible, which is what the dashboard is being reorganised around.
- One more credential to configure per deployment, reported honestly when absent.
- Build logs must be streamed to the dashboard, which is a new write path and
  therefore needs the same tenant-scoped RLS treatment as every other write.

## Implementation note (2026-09-28)

The port and the adapter landed, and the build plane now has a shipped service
behind them: `infra/deployment/builder-server.mjs` (the HTTP contract the
adapter speaks) and `infra/deployment/builder.Dockerfile` (its image). The
adapter's name is `build-railpack.ts` and the port is still the Railpack port,
but the **shipped builder is Nixpacks**, invoked as a pinned binary: Railpack has
no standalone CLI or published service, whereas Nixpacks does, so Nixpacks is
what a self-hosted build plane can actually run today. The port is unchanged, so
swapping in Railpack later (when it ships a runnable service) is an adapter
change, not a port change.

Two defects were found and fixed while wiring it, both recorded here because
they are the kind that pass a type-check and fail a build:

- The service drove Nixpacks with `docker run <nixpacks-image> build …`. The
  published `ghcr.io/railwayapp/nixpacks` images are the generated Dockerfiles'
  *base* images (CMD `/bin/bash`, no `nixpacks` executable), so every build died
  with `exec: "build": executable file not found in $PATH`. It now runs the
  binary, pinned by version and digest.
- The detected framework was read from `plan.providers[0]`, which is empty for
  the languages Nixpacks auto-detects, so every ordinary app reported `null`.
  The language is `plan.variables.NIXPACKS_METADATA`.

The build service is bounded — concurrency, wall-clock timeout, log volume,
retention — because it is the one component that runs untrusted source. See
[`docs/runbooks/build-plane.md`](../runbooks/build-plane.md) for the operator
path and the single-host versus builder-per-tenant trust shapes.

## Alternatives considered

- **No port; let Coolify build everything.** Rejected: Coolify builds inside
  itself and does not expose a build contract, so a serverless project could
  never be built, and the platform would depend on one engine's internal
  behaviour for a first-class capability.
- **Write our own builder.** Rejected for the reason in ADR-0002: an engine we
  write is an engine we must maintain and re-test. Railpack and CNB are
  industry-grade already.
