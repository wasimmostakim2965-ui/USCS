# Release gate evidence

This file maps each of the thirteen release gates in
[ADR-0006](adr/0006-phased-plan-and-acceptance-tests.md) to the command or test
that proves it. It exists so a reviewer can check a gate rather than take a
status report's word for it.

Two kinds of evidence appear below and they are not interchangeable:

- **Enforced** — a running check fails the build when the property breaks. Run
  `pnpm verify:all` to execute every one of them.
- **Blocked on an engine** — the property involves a real external system this
  deployment has no credentials for. The repository proves the *contract* (that
  it cannot report false success), and the gate stays open until a configured
  engine closes it. These are marked honestly as open, not as passing.

## How to run everything

```bash
pnpm verify:all      # build + typecheck + unit/contract/isolation suite + RLS probes
```

`pnpm verify:all` needs a local PostgreSQL for the RLS half. CI provides one;
locally, start the cluster and run `scripts/verify-rls.sh`.

## The gates

| # | Gate | Kind | Evidence |
|---|---|---|---|
| 1 | Two organizations cannot read or mutate each other | Enforced | `tests/isolation/api-procedures.test.ts`, `tests/isolation/api-scope.test.ts`, and the real-PostgreSQL probe `tests/isolation/rls/10_isolation_probe.sql` (organizations, projects, deployments, audit, api keys, domains, data resources, backups, security policies) |
| 2 | API keys cannot exceed scopes or membership | Enforced | `tests/isolation/api-keys.test.ts` — a member requesting `org:delete` gets it dropped; unknown scopes dropped; a factory-narrowed key refuses a scope the owner's live role would grant; revoked keys refuse everything. `tests/isolation/api-procedures.test.ts` proves the same through the registered procedure and that neither the secret nor its hash reaches a list response or an audit row |
| 3 | Retries cannot duplicate deployments or charges | Enforced | `tests/adapters/queue.test.ts` and `tests/isolation/rls/11_jobs_probe.sql` — a replayed idempotency key returns the existing job; the unique constraint is enforced by the database, not by the caller |
| 4 | Provider timeout is recoverable | Enforced | `tests/engines/coolify.test.ts` ("bounds a hanging engine call"), `tests/adapters/honesty.test.ts` ("never upgrades a timeout into success"), `tests/engines/data-engines.test.ts` — a slow engine is aborted and surfaces as a non-success result, never as success |
| 5 | Secrets are absent from logs and API responses | Enforced | `tests/integration/observability.test.ts` (redaction of credentials, tokens, cookies and origin addresses), `tests/adapters/honesty.test.ts`, plus `key_hash` being unselectable by an authenticated client in `10_isolation_probe.sql` |
| 6 | Direct origin access is denied | **Open — needs an engine** | The contract side is enforced: `tests/engines/security-edge.test.ts` proves origin addresses never leave the edge adapter and are not published by policy. Denying a real origin requires a deployed Envoy/Coraza pair, which is not configured here |
| 7 | CRS attack fixtures are blocked while approved traffic passes | **Open — needs an engine** | `tests/engines/security-edge.test.ts` compiles policy to Coraza/Envoy and refuses hostile input before it becomes a rule. Running the OWASP CRS fixtures needs a live Coraza |
| 8 | A tenant cannot reach another tenant's network or filesystem | **Open — needs an engine** | The control-plane half is enforced (gate 1). The runtime half needs real containers and network policy |
| 9 | Backup restore is verified | **Open — needs an engine** | `tests/engines/data-engines.test.ts` ("backs up and restores through the engine.s own artifacts") proves the restore lifecycle and its states against the adapter contract. A *verified* restore needs a real PostgreSQL/MinIO pair with a backup destination, which is not configured here |
| 10 | Deployment and policy changes are audited | Enforced | `tests/isolation/api-procedures.test.ts` (creation audited with actor and target), `tests/isolation/security-control.test.ts` (policy distribution and incident lifecycle), and the append-only enforcement in `10_isolation_probe.sql` |
| 11 | Load tests report p50/p95/p99 latency and throughput | Enforced | `tests/load/control-plane-load.test.ts` — runs the real router and procedure table under concurrency and asserts every request succeeded before reporting the percentiles. Also pins the percentile maths itself |
| 12 | License inventory carries SPDX ids, notices and pinned versions | Enforced | `LICENSES/engines.json` and `LICENSES/third-party-inventory.md`, reproducible from `scripts/license-inventory.py` |
| 13 | Threat model, ERD, RLS matrix, API contracts, state machines, SLOs, incident response and DR runbooks exist | Enforced | `docs/adr/0003-threat-model.md`, `docs/adr/0004-control-plane-erd-rls.md`, `docs/adr/0005-api-contracts-and-state-machines.md`, `docs/runbooks/slos.md`, `docs/runbooks/incident-response.md`, `docs/runbooks/backup-and-dr.md` |

## What the load numbers mean

`pnpm test tests/load/control-plane-load.test.ts` prints a line like:

```text
organizations.list (in-process fixture): 500 requests, 500 ok, 0 failed, 406728.9 req/s, p50=0.03ms p95=0.05ms p99=0.26ms max=0.37ms
```

That figure is the dispatch path against an in-memory store. It is a harness
proof, not a production capacity claim: the database, network and TLS costs are
absent. A production capacity number requires target hardware and a real
database, and belongs in an operational validation, not in this repository.

## Rules for editing this file

- Do not move a gate to Enforced without a check that fails the build.
- Do not remove an "Open — needs an engine" row. An open gate is information;
  deleting it makes the release look safer than it is.
- When an engine is configured, the gate's evidence changes from the contract
  test to the real-system test, and this table is updated in the same commit.
