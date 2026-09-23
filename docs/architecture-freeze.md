# Cloud Wai Architecture Freeze

**Status:** Frozen for implementation

**Purpose:** This document is the source of truth for the next implementation milestones. It prevents further UI-led direction changes while the execution plane is built.

## Product Boundary

Cloud Wai is an organization-scoped cloud control plane for deploying and operating applications. The platform is not considered production-ready when a screen exists without a real lifecycle behind it. Infrastructure states must remain honest: when a provider or execution plane is unavailable, the system must expose `not_configured`, `failed`, or another truthful state rather than fabricate success.

## Frozen Technology Decisions

| Area | Decision |
| --- | --- |
| Frontend | React, Vite, TypeScript |
| Routing | Wouter with URL-driven routes |
| API | Express + tRPC |
| Auth and database | Supabase Auth + PostgreSQL |
| Authorization | Organization-scoped RLS plus server-side role checks |
| Infrastructure boundary | Adapter-based hosting, data, DNS/domain, security-edge, and billing integrations |
| Validation | Zod at tRPC boundaries; TypeScript, Vitest, and production build gates |
| UI direction | Original Cloud Wai design system informed by Vercel/Coolify/Qovery behavior; no proprietary source copying |
| Data honesty | No fake deployment, infrastructure, security, usage, or observability metrics |

These decisions are frozen unless a documented architectural decision record proves that the current choice blocks a required platform capability.

## Domain Model

```text
Organization
  └── Project
        └── Environment
              ├── Deployment
              ├── Domain binding
              ├── Database instance
              ├── Storage bucket
              ├── Environment variable / secret
              ├── Security policy
              └── Observability events and alerts
```

The current repository has organizations and projects plus many resource tables. A first-class `environments` table and foreign-key references from deployment-scoped resources are required before the deployment engine is considered complete. Production, preview, development, and custom environments must not be inferred from free-form strings in the UI.

## Current Reality Inventory

| Capability | Current classification | Required next step |
| --- | --- | --- |
| Supabase authentication | Implemented foundation | Keep; add lifecycle tests for protected mutations |
| Organizations, projects, memberships | Implemented foundation | Add environment ownership and stronger role matrix |
| RLS and audit logs | Implemented foundation | Verify every new job/event table and cross-tenant denial |
| Control-plane shell and routes | Implemented foundation | Keep current v2 shell; no further shell rebuild while execution work is underway |
| Deployment rows and adapter boundary | Partial | Move provider execution behind durable jobs and worker-owned transitions |
| Deployment statuses | Partial | Add transition table, actor/reason metadata, and illegal-transition tests |
| Deployment logs | Partial | Make append-only, sequenced, attempt-aware, and streamable |
| Rollback history | Partial | Make rollback a worker-executed lifecycle with verification |
| Hosting provider | Not configured by default | Preserve truthful failure; add a test adapter and provider contract |
| Database/storage provisioning | Contract-only by default | Add job lifecycle and adapter result persistence |
| Domains/DNS/TLS | Partial/adapter-dependent | Add verification, certificate state, retry, and failure lifecycle |
| Security policy rendering | Partial | Separate rendered artifact from applied enforcement and record both states |
| Observability | Partial | Define event ingestion, retention, aggregation, and alert evaluation |
| Billing/usage | Contract-only/gated | Postpone payment execution; define usage events and quota boundaries first |

## Deployment Execution Contract

Deployment creation must be fast and deterministic from the API perspective:

```text
request
  -> validate organization/project/environment access
  -> create deployment(status = queued)
  -> create idempotent deployment job
  -> return deployment and job identifiers
  -> worker claims job
  -> worker runs adapter/build lifecycle
  -> worker appends logs and events
  -> worker persists final state and audit event
```

The target state machine is:

```text
queued -> building -> deploying -> ready
queued -> failed
building -> failed
building -> canceled
queued -> canceled
deploying -> failed
ready -> rolled_back
```

Only the worker may move an active deployment through execution states. API mutations may request cancellation, retry, promotion, or rollback; they must enqueue a job and never silently mark infrastructure as successful.

Every transition records the deployment id, previous status, next status, attempt, actor or worker identity, reason, timestamp, and correlation/job id. Illegal transitions are rejected and covered by tests.

## Queue and Worker Contract

The first implementation may use a PostgreSQL-backed durable queue because Supabase/Postgres is already a platform dependency. The queue must support:

- idempotency key per logical deployment action;
- claim with lease expiration;
- retry count and bounded exponential backoff;
- timeout and dead-letter status;
- safe recovery after worker interruption;
- correlation id shared by deployment, job, logs, and audit events;
- explicit `not_configured` result when an adapter is unavailable.

A resident production worker is a deployment concern, not a browser concern. Local tests may use an in-process worker harness, while production deployment must run the worker as a separately supervised process or managed job service.

## Logs and Artifacts

Deployment logs are append-only records with a monotonic sequence per deployment attempt. Each record includes timestamp, level, stage, source, attempt, message, and correlation id. The UI may poll initially, but the contract must support SSE or another live transport without changing the stored model.

Build artifacts must have a provider reference, content metadata, checksum, retention state, and deployment linkage. Artifact availability and deployment readiness are separate facts.

## Security and Resource Lifecycles

A security policy has two distinct states:

1. **Rendered:** the platform produced a provider-specific artifact or configuration.
2. **Enforced:** the provider accepted and applied the policy.

The UI must never label a policy protected solely because rendering succeeded.

Database, storage, domain, certificate, backup, and restore operations follow the same request → job → adapter → event → final-state pattern. Secrets are referenced or encrypted; connection values are not written into audit metadata or ordinary list responses.

## UI Contract

The current `client/src/control-plane/ControlPlaneShell.tsx`, `navigation.ts`, and `control-plane-v2.css` remain the shell source of truth. No second dashboard shell is to be introduced.

Every resource page must use shared primitives for:

- page header and breadcrumbs;
- status badges;
- tables and filters;
- drawers and confirmation dialogs;
- loading, empty, error, forbidden, and not-configured states;
- responsive mobile behavior;
- keyboard and focus states.

UI completion requires a working backend lifecycle or an explicit truthful state. A button that only raises a toast is not a completed feature.

## Execution Order and Exit Criteria

### Milestone 1 — Architecture Freeze

Exit criteria: this document is committed; schema gaps and authoritative files are identified; no further shell rebuild is planned; `pnpm verify` passes.

### Milestone 2 — Deployment Model

Exit criteria: environments, deployment events, jobs, attempts, and artifacts are modeled; RLS is applied; legal status transitions and idempotency behavior have tests.

### Milestone 3 — Worker Foundation

Exit criteria: a job can be claimed, leased, retried, timed out, and recovered; a not-configured adapter produces a truthful failed deployment with an actionable reason.

### Milestone 4 — Real Vertical Slice

Exit criteria: a user can create a project/environment/deployment, observe queued → building → ready or failed, inspect attempt logs, retry a failed job, and request a worker-executed rollback. No fake success is allowed.

### Milestone 5 — Security Vertical Slice

Exit criteria: policy selection, preview, apply request, provider result, audit history, and rollback/failed states are coherent and tenant-scoped.

### Milestone 6 — Domains and Data Lifecycles

Exit criteria: domain verification/TLS state and database/storage/backup/restore jobs expose real lifecycle states and provider configuration boundaries.

### Milestone 7 — UI and Reliability Polish

Exit criteria: desktop/mobile visual QA, accessibility checks, pagination/filtering, live log transport, observability, quotas, and reliability runbooks are complete for the vertical slice.

## Definition of Done

A milestone is done only when its backend contract, authorization, lifecycle states, error and recovery behavior, audit trail, tests, and desktop/mobile UI behavior agree. A green build alone is not completion. A provider that is not connected must remain visibly and programmatically not configured.

## Postponed Scope

Payment execution, domain reseller marketplace, AI-specific products, image optimization, feature flags, sandboxes, multi-region orchestration, and advanced marketplace integrations are postponed until the deployment vertical slice and worker reliability gates pass.
