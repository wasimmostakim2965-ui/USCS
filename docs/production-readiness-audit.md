# Cloud Wai Production Readiness Audit

**Audit date:** 2026-09-28

> **Status update (2026-09-28).** Parts of this snapshot described an earlier
> checkout and no longer match the code. Each is listed here with the evidence
> rather than edited out, so the original finding and its resolution stay
> together. Read the section below before acting on the body.
>
> - *"no durable queue, worker lease, retry/backoff, attempt table, worker-owned
>   state transition"* — now present: `orchestration_jobs` and `attempts`
>   (`supabase/migrations/0001_control_plane.sql`), claim/lease/reap
>   (`0003_jobs_lease_and_idempotency.sql`, `0008_jobs_claim_and_reap_functions.sql`)
>   and the worker-owned status guard (`0009_deployment_status_guard.sql`), driven
>   by `apps/worker/src/processor.ts` (claim, lease, reaper) and
>   `packages/database/src/sql-queue.ts`. The `apps/worker` app is real.
> - *"no root LICENSE"* — `LICENSE` exists and is MIT, matching `package.json`.
> - *"hardcoded browser-safe Supabase fallback values"* — none remain; the web
>   entry points read `import.meta.env.VITE_SUPABASE_*` and the API reads its env
>   (`apps/api/src/bootstrap.ts` refuses a session with no `SUPABASE_URL`).
> - *"redirect example must point to `/auth/callback`, not only `/`"* — it points
>   to `/auth/callback` (`apps/web/src/session.ts`, `apps/web/src/routes.ts`).
> - *"the missing production-critical layer is the execution plane"* — the build
>   plane now ships as a deployable service with a bounded, authenticated
>   contract (`infra/deployment/builder-server.mjs`, `builder.Dockerfile`,
>   `docs/runbooks/build-plane.md`, ADR-0018) and is wired into compose,
>   Terraform and the AWS bootstrap.
>
> - *"Express + tRPC server"* / *"client/src/control-plane/ControlPlaneShell.tsx"*
>   — the stack is not Express or tRPC and the path is not `client/src`. The API
>   is a dependency-light Node `http` server exposing a single `POST /rpc`
>   endpoint (`apps/api/src/server.ts`, `apps/api/src/router.ts`); the client is
>   `apps/web` (React 19 + Vite, hash-routed by `apps/web/src/routes.ts`, pages in
>   `apps/web/src/pages/`). No `@trpc/*`, `express` or `wouter` dependency exists
>   in any workspace package.
> - *"Supabase must have those providers configured"* — true, and the callback
>   contract now uses `/auth/callback`; see the note above.
>
> Still genuinely open, and not contradicted: real public-origin OAuth/logout
> on a live deployment, narrow-mobile screenshot QA, and connecting the external
> engine credentials (Coolify, MinIO, edge, DNS/TLS, Stripe) — those need live
> accounts, which is the operator's step. This is the same honest boundary the
> release gates 6–9 mark as *Open — needs an engine*. See
> [`deployment-readiness-2026-09-28.md`](audit/deployment-readiness-2026-09-28.md)
> for the deployment-specific audit.

## Executive verdict

Cloud Wai is a substantial control-plane foundation, not yet a complete Vercel-like deployment platform. The repository has a real Supabase-backed multi-tenant model, protected RPC procedures (`apps/api/src/router.ts`), RLS migrations, adapter boundaries, resource control records, and an original control-plane UI. The missing production-critical layer is the execution plane that turns a deployment request into a durable, observable, recoverable build and release.

The correct next step is not another dashboard rewrite. It is to connect and harden the real infrastructure boundary while preserving the current React/Vite/Node-http/Supabase architecture.

## What is present

- React 19 + Vite + TypeScript client.
- Node `http` API server exposing a single `POST /rpc` JSON-RPC endpoint (no Express, no tRPC).
- Supabase Auth and PostgreSQL migrations.
- Organization, membership, project, audit, API-key, and RLS foundations.
- Deployment, deployment-log, rollback-history, domain, DNS, database, storage, security, observability, and billing control-plane records.
- Hosting, data, security-edge, domain-reseller, and billing adapter boundaries.
- Honest `not_configured` behavior for unavailable providers.
- OAuth-only browser UI with Google, GitHub, and GitLab buttons; no email/password form is currently rendered.
- Control-plane shell in `apps/web/src/App.tsx` with navigation in `apps/web/src/navigation.ts`.
- `pnpm verify` as the required build, typecheck, and test gate.

## What is partial or not production-ready

### Deployment execution

The current hosting adapter calls a remote `COMPUTE_HOST` synchronously from the RPC procedure. There is no durable queue, worker lease, retry/backoff, deployment attempt table, worker-owned state transition policy, artifact registry, or crash recovery contract. A configured compute API can therefore be called, but this is not yet a reliable production deployment engine.

### Status model

The database currently uses `pending`, `building`, `ready`, `failed`, `canceled`, and `rolled_back`. The target contract requires an explicit queued/building/deploying lifecycle, legal transition validation, transition events, correlation IDs, attempt numbers, reasons, and idempotency. These must be added without fabricating readiness.

### Logs

Deployment logs exist as append-only-looking rows, but they lack a sequence per attempt, stage, attempt ID, correlation ID, retention policy, and a live transport contract. Polling can remain the first UI transport; the storage model must support SSE later.

### Infrastructure providers

- `COMPUTE_HOST` and `COMPUTE_API_TOKEN` are required for hosting execution.
- Database/storage adapters are intentionally not configured by default.
- Security-edge apply needs `EDGE_API_URL` and `EDGE_API_TOKEN`; rendering an artifact is not enforcement.
- DNS/TLS execution requires a real provider adapter and credentials; control records alone do not provision certificates.
- Stripe and domain reseller flows are gated and should remain disabled until account, webhook, pricing, and legal operations are ready.

### Authentication

The browser UI already exposes only Google, GitHub, and GitLab OAuth. Supabase must have those providers configured, and each provider's callback must be allowlisted. The current client contains hardcoded browser-safe Supabase fallback values. Production should require deployment-provided public configuration rather than silently binding every build to one project. The redirect example must point to `/auth/callback`, not only `/`.

### UI quality

The provided Vercel reference screenshot demonstrates a restrained shell, compact top bar, project-scoped navigation, high information density, and carefully controlled responsive behavior. Cloud Wai's current mobile render still needs screenshot-based QA: content alignment, sidebar collapse, card widths, drawer behavior, and table overflow must be tested at narrow viewports. The reference project's account data must not be copied.

## License and dependency finding

The repository declares `MIT` in `package.json`, but there is no root `LICENSE` file in the current checkout. Add a root MIT license file before public distribution and include third-party notices/SBOM in release artifacts. Direct dependencies include Supabase, AWS SDK S3, React, Vite, Zod and related packages. Their individual licenses and transitive dependencies must be generated and reviewed in CI; the package license field alone is not a complete third-party compliance record.

## Frozen architecture recommendation

```text
Organization
  └── Project
        └── Environment
              ├── Deployment
              ├── Deployment job / attempt / event / log / artifact
              ├── Domain and TLS binding
              ├── Database instance
              ├── Storage bucket
              ├── Environment variables and secrets
              ├── Security policy and enforcement result
              └── Observability events and alerts
```

Keep React/Vite, the Node-http RPC API, Supabase/Postgres/RLS, and adapters. Add first-class environments and a Postgres-backed durable queue before choosing an external queue product.

## Production gates

A production release is not approved until all of the following are true:

1. OAuth callback and logout work on the real public origin.
2. Tenant isolation tests deny cross-organization reads and writes.
3. A deployment request returns queued without blocking on provider work.
4. A worker can claim, lease, retry, timeout, and recover a job.
5. A configured provider produces real build/deploy states; an unavailable provider produces an explicit failure, never ready.
6. Logs are persisted per attempt and are visible while a job runs.
7. Retry and rollback are idempotent and audited.
8. Secrets never appear in browser bundles, ordinary logs, audit metadata, or error messages.
9. Desktop and narrow-mobile screenshot checks pass.
10. Build, typecheck, tests, migration checks, dependency/license checks, and security checks pass.

## Immediate implementation order

1. Require runtime Supabase configuration and correct the OAuth callback contract.
2. Add root license and dependency compliance workflow.
3. Add environments and deployment execution tables with RLS.
4. Add legal state transitions and a durable Postgres job queue.
5. Add worker execution with the existing hosting adapter.
6. Add attempt-aware logs, retry, rollback, and live polling/SSE boundary.
7. Connect real compute, artifact storage, DNS/TLS, and edge providers only after their health/auth contracts are verified.
8. Perform Vercel-class UI polish against the real lifecycle, not placeholder states.
