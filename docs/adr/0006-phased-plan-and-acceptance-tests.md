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
