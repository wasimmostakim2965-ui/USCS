# Cloud Wai Production Readiness Audit

**Audit date:** 2026-09-28

## Executive verdict

Cloud Wai is a substantial control-plane foundation, not yet a complete Vercel-like deployment platform. The repository has a real Supabase-backed multi-tenant model, protected tRPC routers, RLS migrations, adapter boundaries, resource control records, and an original control-plane UI. The missing production-critical layer is the execution plane that turns a deployment request into a durable, observable, recoverable build and release.

The correct next step is not another dashboard rewrite. It is to connect and harden the real infrastructure boundary while preserving the current React/Vite/Express/tRPC/Supabase architecture.

## What is present

- React 19 + Vite + TypeScript client.
- Express + tRPC server.
- Supabase Auth and PostgreSQL migrations.
- Organization, membership, project, audit, API-key, and RLS foundations.
- Deployment, deployment-log, rollback-history, domain, DNS, database, storage, security, observability, and billing control-plane records.
- Hosting, data, security-edge, domain-reseller, and billing adapter boundaries.
- Honest `not_configured` behavior for unavailable providers.
- OAuth-only browser UI with Google, GitHub, and GitLab buttons; no email/password form is currently rendered.
- Current v2 control-plane shell in `client/src/control-plane/ControlPlaneShell.tsx` with navigation in `client/src/control-plane/navigation.ts`.
- `pnpm verify` as the required build, typecheck, and test gate.

## What is partial or not production-ready

### Deployment execution

The current hosting adapter calls a remote `COMPUTE_HOST` synchronously from the tRPC mutation. There is no durable queue, worker lease, retry/backoff, deployment attempt table, worker-owned state transition policy, artifact registry, or crash recovery contract. A configured compute API can therefore be called, but this is not yet a reliable production deployment engine.

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

The repository declares `MIT` in `package.json`, but there is no root `LICENSE` file in the current checkout. Add a root MIT license file before public distribution and include third-party notices/SBOM in release artifacts. Direct dependencies include Supabase, AWS SDK S3, Radix UI, TanStack Query, tRPC, React, Vite, Express, Wouter, Zod, Recharts, Lucide, and related packages. Their individual licenses and transitive dependencies must be generated and reviewed in CI; the package license field alone is not a complete third-party compliance record.

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

Keep React/Vite/Wouter, Express/tRPC, Supabase/Postgres/RLS, and adapters. Add first-class environments and a Postgres-backed durable queue before choosing an external queue product.

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
