# Service level objectives

Status: **draft — targets proposed, not yet measured.**

Every number here is a target, not a result. Load and failure validation
(blueprint implementation step 10) has not run against real engines, so no
objective below has been demonstrated yet. Nothing in this file may be reported
as achieved until `tests/load` reports it against a real deployment.

## Why this file exists

An SLO is only useful if it is falsifiable. Each objective below names the metric
that decides it and the evidence that would prove it, so the day the load run
happens there is no argument about what "met" means.

## Control plane

| Objective | Target | Metric | Evidence source |
|---|---|---|---|
| API availability | 99.9% monthly | non-5xx / total by route | API access logs (OTel) |
| Command acceptance latency | p95 < 300 ms, p99 < 800 ms | `procedure.duration_ms` | API metrics |
| Job pickup latency | p95 < 2 s from `queued` to `running` | `orchestration_jobs.started_at - created_at` | job table |
| Job completion (deploy) | p95 < 5 min cold, < 90 s warm | `finished_at - started_at` | job table |
| Audit completeness | 100% of state changes | every transition has an `audit_logs` row | audit table |

## Edge

| Objective | Target | Metric |
|---|---|---|
| Added WAF latency | p95 < 10 ms, p99 < 25 ms | edge request duration minus upstream |
| Blocked-request false positives | < 0.1% | challenge/block events appealed as legitimate |
| Origin exposure | zero direct-to-origin success | origin-leak probe |

## Error budget

A month with more than 0.1% unavailability pauses feature work until the cause
has a written postmortem. The budget is deliberately small because a hosting
control plane that is down is a customer outage, not a degraded feature.

## What would have to be true

For these to be measured rather than asserted:

1. A real deployment with Coolify, PostgreSQL, MinIO and the edge configured.
2. `tests/load` driving the required flows (see blueprint "Required flows").
3. OTel traces emitted from the API and worker, with the redaction rules in
   `@cloud-wai/observability` applied before export.

Until all three exist, the honest statement is "objectives are proposed and
unmeasured," which is what this header says.
