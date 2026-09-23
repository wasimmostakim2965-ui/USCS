# Incident response

Status: draft runbook. Not yet exercised against a real incident.

## Severity

| Severity | Meaning | Response |
|---|---|---|
| critical | cross-tenant access, credential exposure, control plane down, origin publicly reachable | page immediately, freeze deploys |
| high | a tenant's service down, policy not distributing, job queue wedged | page during hours, next-day postmortem |
| medium | degraded engine, elevated error rate, one flow failing | ticket, fix in normal flow |
| low | cosmetic, false-positive WAF block | backlog |

## First response

1. **Establish scope.** Is it one organization or all? Read
   `orchestration_jobs` for the organization and `audit_logs` for the window.
   Never assume a single-tenant report is single-tenant.
2. **Stop the bleeding, then diagnose.** For a suspected cross-tenant path or a
   leaked credential, quarantine first (`SecurityEdgeAdapter.quarantine`) and
   investigate after. Availability is recoverable; a disclosure is not.
3. **Open an incident record** (`IncidentTracker.open`) with the observed signal,
   not a guessed cause. Record the severity you are acting on.
4. **Preserve evidence.** Do not delete jobs or audit rows. Redact credentials
   from anything that leaves the system, using `@cloud-wai/observability`.

## Cross-tenant suspicion

This is the one that outranks everything else.

- Treat any cross-tenant read or write as critical even if it looks benign.
- Reproduce with the isolation probe: `pnpm verify:rls` runs the two-organization
  matrix against a real PostgreSQL. If the probe passes, the leak is in a path
  the probe does not cover — API procedures, jobs, adapters — and that gap is
  itself the finding.
- The tenant boundary is `organization_id`, resolved from membership, never from
  client input. A leak means some path trusted the client. Find it before
  closing.

## Credential exposure

- Assume exposed and rotate, do not assume "probably not logged."
- `redact` covers keys matching secret/origin patterns; a leak means a field got
  out that did not match, so add the field to the pattern after rotating.
- Check `audit_logs.metadata` and any adapter error reason for the raw value.

## Closing

An incident closes with a resolution and an outcome (`resolved` or
`false_positive`). A close without a resolution is refused by design — an
incident that disappears silently is worse than one left open. Anything
critical or high also produces a short written postmortem: timeline, impact,
root cause, and the specific test that would have caught it.

## What is not yet exercised

This runbook has never been run against a real incident on a real deployment.
Treat it as a plan, not as a rehearsed procedure.
