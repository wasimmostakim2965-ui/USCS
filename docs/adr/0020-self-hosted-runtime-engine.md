# ADR-0020 — A self-hosted runtime: this deployment owns the container engine

- Status: accepted
- Date: 2026-09-28
- Deciders: Cloud Wai engineering
- Related: ADR-0002, ADR-0015, ADR-0018, ADR-0019

## Context

ADR-0002 chose Coolify as the deployment/hosting execution engine, wrapped
behind a version-pinned `HostingAdapter`. That decision still holds for the
*port* — the control plane asks for "the container engine" and does not know who
answers. What it left open is *ownership of the machine*: until now, a Cloud Wai
deployment that did not rent a Coolify instance had no container runtime at all,
so a `container` project could only ever report `not_configured`. The platform
had a build port (ADR-0018) that turned source into an image and nowhere to run
it.

The Vercel shape this platform is modelled on does not have that gap: a commit
becomes a running container inside the platform itself. A system that cannot run
the artifact it just built is not Vercel-grade, and requiring every tenant to
first stand up Coolify is not self-hostable.

## Decision

Add a **self-hosted runtime engine** — this deployment's own container runtime —
behind the *same* `HostingAdapter` port Coolify implements.

1. `infra/deployment/runtime-server.mjs` is the engine. It clones the git source,
   drives the build plane to produce an image, runs that image, assigns it a host
   port, and reports the real status, url and logs. It is the piece Coolify used
   to supply.
2. `packages/adapters/src/selfhosted.ts` is the adapter. It is a thin, honest
   translation of the runtime's HTTP surface; it never invents a deployment or a
   URL the runtime did not return.
3. `buildEngines` prefers the runtime when `RUNTIME_URL` and at least one
   `RUNTIME_TOKEN__<organizationId>` are set, and falls back to Coolify when only
   Coolify credentials are present. With neither, the container engine is honestly
   `not_configured`.
4. Because both engines share one port, the engine report reads the adapter's own
   `__engine` marker rather than treating the port as configured. A host wired to
   the runtime does **not** also report Coolify as ready.
5. The one-command deploy (`infra/deployment/deploy.sh`) generates `RUNTIME_TOKEN`,
   starts the runtime under the `runtime` compose profile, and wires every
   organization to `RUNTIME_URL`.

## Consequences

- A single Linux host can build and run a container project with no third-party
  hosting control plane: `./infra/deployment/deploy.sh` is a working
  "deploy this repository" button.
- The runtime holds the Docker socket, so it is its own image and service,
  isolated from the API and worker the same way the builder is (ADR-0018). Two
  services now mount the daemon — the build plane and the runtime — and
  `tests/deployment/build-plane.test.ts` pins that boundary at exactly two.
- Credentials stay per organization (`RUNTIME_TOKEN__<orgId>`). A tenant with no
  runtime token gets `not_configured`, not a shared fallback, because a shared
  fallback would run one tenant's code on another tenant's machine and call it
  deployment. A deployment needing a hard runtime boundary runs one runtime per
  tenant and points each organization at its own.
- Coolify remains a first-class engine. A host that already runs Coolify is
  unchanged; the runtime is the self-hosted path, not a replacement decision.
