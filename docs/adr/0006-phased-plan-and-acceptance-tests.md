# ADR-0006 — Phased implementation plan and acceptance tests

- Status: accepted
- Date: 2026-09-23

## Phases

Each phase ends with `pnpm verify` green and a written summary. No phase may
claim completion while any part of it is unverified.

| Phase | Deliverable | Acceptance test |
|---|---|---|
| 0 | Engine inspection, license inventory, ADRs | This report exists; every claim cites a file or a commit |
| 1 | Monorepo skeleton, package boundaries, tooling | `pnpm verify` passes on the wired skeleton |
| 2 | Control-plane schema, RLS, identity, authorization | Two-organization isolation test passes for every procedure |
| 3 | Adapter contracts, durable jobs, fake providers | deploy/backup/policy run end-to-end against fakes, recorded in `orchestration_jobs` + `audit_logs` |
| 4 | Real engines behind adapters (Coolify, Postgres, MinIO, edge) | Real deploy + rollback with real logs; tenant DB + bucket backup/restore verified; SQLi/XSS blocked at the edge; origin unreachable except via the edge |
| 5 | UI, observability, polish | Every route calls a typed procedure and renders loading/empty/success/degraded/error; no mock data; keyboard accessible; ⌘K navigates for real |
| 6 | Real data engines (PostgreSQL, MinIO/S3) behind the adapters | Tenant database and bucket lifecycle proven against the adapter contract, with credentials never returned to the caller (`tests/engines/data-engines.test.ts`) |
| 7 | Security edge adapter: Cloud Wai policy compiled to Coraza/Envoy | Every enforcement action maps to a Coraza action; hostile host/path/origin input is refused, not escaped; a stale policy version is a failure (`tests/engines/security-edge.test.ts`) |
| 8 | `security-control` app, CI, and the gate-13 runbooks | Policy version only moves forward; a rollback is refused before the edge is called; CI applies every migration to a real PostgreSQL and runs the probes |

Phases 0–5 are the plan as first written. Phases 6–8 were added as the engine
work landed, and are what the corresponding `feat(phase-6|7|8)` commits
delivered; ADR-0011 records the data engines and the edge, ADR-0012 the gate
evidence. A phase ends when `pnpm verify:all` is green, not when the commit
message says so.

## Release gates (from the blueprint)

These are gates, not aspirations. A release that fails any of them is not a
release:

1. Two organizations cannot read or mutate each other.
2. API keys cannot exceed scopes or membership.
3. Retries cannot duplicate deployments or charges.
4. Provider timeout is recoverable.
5. Secrets are absent from logs and API responses.
6. Direct origin access is denied.
7. CRS attack fixtures are blocked while approved traffic passes.
8. A tenant cannot reach another tenant's network or filesystem.
9. Backup restore is verified.
10. Deployment and policy changes are audited.
11. Load tests report p50/p95/p99 latency and throughput.
12. The license inventory carries SPDX ids, notices and pinned versions.
13. Threat model, ERD, RLS matrix, API contracts, state machines, SLOs,
    incident response and disaster-recovery runbooks exist.

## What is verified now versus what needs a real engine

Verified in this repository today (runnable with `pnpm verify`):

- The engine inventory, pinned commits and SPDX ids are reproducible from
  `scripts/license-inventory.py`.
- The status vocabulary cannot express fake success (`tests/contract`).
- Organization scope is resolved from membership, not client input, and a role
  in one organization does not leak into another (`tests/isolation`).
- Log redaction removes credentials and origin addresses (`tests/integration`).
- The UI state mapping never renders success for a non-success engine status.
- The deployment write path is wired end to end: `deployments.create` and
  `deployments.rollback` persist a row before the engine is called, reuse an
  idempotency key instead of deploying twice, write `succeeded` only for an
  engine-reported success, and record `not_configured` when no hosting
  credentials exist (`tests/isolation/deployment-writes.test.ts`). The dashboard
  exposes both flows (`tests/web/dashboard.e2e.test.tsx`).
- The domain write path is wired end to end: `domains.create` issues and stores
  a challenge, `domains.verify` accepts only what the DNS verifier observed and
  writes nothing when the verifier is absent, and `domains.remove` is
  membership-scoped. `verified` is not an accepted input anywhere
  (`tests/isolation/domain-writes.test.ts`), and the verifier's own honesty
  rules — a broken lookup is `degraded`, never `verified: false` — are pinned in
  `tests/adapters/domain-verification.test.ts`.
- Engine-observed columns cannot be written by a client, on INSERT or UPDATE.
  Gate 1 covers tenants reaching each other; this covers a tenant reaching a
  *fact* it does not own. A member with their own JWT could previously run
  `update domains set verified = true` through PostgREST and self-certify a
  hostname they never controlled, insert a pre-verified row, mark a data
  resource `ready`, declare a policy `active`, or record which engine hosts
  their project. `supabase/migrations/0006_engine_column_guards.sql` accepts a
  change to those columns only in a session that already bypasses RLS (the
  service role, or a superuser), and
  `tests/isolation/rls/12_domain_verification_probe.sql` proves both the refusals
  and that a member may still edit their own inputs and the service role may
  still verify a domain and provision a resource.
- Every route calls a typed procedure and renders loading, empty, success,
  degraded and error without a blank page, and ⌘K navigates for real
  (`tests/web/dashboard.e2e.test.tsx`).

Requires a configured engine to verify (must stay honestly `not_configured`
until then):

- A real Coolify deployment with build logs, a live URL and a rollback.
- A real tenant database and bucket with a verified backup/restore.
- An edge that blocks SQLi/XSS fixtures while passing approved traffic, with the
  origin unreachable except through the edge.
- Load, failure and disaster-recovery validation.

## Scope discipline

The blueprint's layout, entity list, adapter interface shapes and route list are
followed as written. Changes to scope or architecture require an ADR here first,
not a silent edit.
