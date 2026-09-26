# ADR-0019: Rewrite scope — rebuild the pipeline and dashboard, keep the connection layer

- Status: accepted
- Date: 2026-09-24

## Context

The owner's instruction is to follow Vercel's structure and technique, and to
delete what is wrong rather than patch it. That instruction is right about the
problem: the dashboard was organised around labels instead of the deployment
lifecycle, the database section was blocked behind an unresolved question, and
the build layer — the centre of Vercel's architecture — was absent entirely.

It is not right that the whole repository must be deleted. This ADR records the
scope precisely, so the question is settled once and does not return.

## Decision

### Superseded (rebuilt along Vercel's structure)

- The phase ordering in ADR-0006, replaced by `docs/plans/vercel-roadmap.md`.
- The "reverse or narrow ADR-0011" blocker. ADR-0018 answers it: the missing
  capability was a build port, not a data-plane decision.
- The dashboard's label-first organisation, rebuilt around upload → build →
  classify → deploy → route.
- The blocked database placeholder routes, replaced by real surfaces in Phase E.

### Kept (the connection layer)

- The six engine ports and their adapters — Coolify, Postgres, MinIO, security
  edge, serverless, domain verification.
- The Postgres-backed job queue and the worker.
- The RLS schema and the isolation probes.
- The AWS Terraform and compose hosting shape (ADR-0015).

### Never rebuilt

Any engine. Coolify, Envoy, Coraza, CrowdSec, MinIO, Postgres, Railpack and
Lambda are industry-grade already. Re-testing them is waste. We test only our
wiring, which is the only part we wrote.

## Rationale

The connection layer is the part an equivalent platform must own, and it is the
part already verified by 666 tests and the isolation probes. Deleting it would
not remove any of the three real blockers:

1. the missing `BuildEngine` port (ADR-0018),
2. the ADR-0011 question (answered by ADR-0018),
3. the absence of live infrastructure for gates 6–9.

All three are unchanged by a rewrite. Deleting would therefore forfeit verified
work while leaving every blocker in place — slower, not faster, and directly
against the goal of reaching Vercel's structure quickly.

## Consequences

- The rewrite is real where it matters (pipeline, dashboard, database surface)
  and avoids destroying the verified connection layer.
- The roadmap is the single map from layer to component to port to status, which
  is what the project lacked.
- Every future "should we rewrite this?" question is answered by referring here.
