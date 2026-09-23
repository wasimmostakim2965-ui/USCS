# Cloud Wai

A production-grade, multi-tenant cloud control plane for self-operated hosting
and data services. Cloud Wai owns identity, organizations, projects, billing,
policies, audit, orchestration contracts and security policy. Real open-source
systems (Coolify, Supabase, PostgreSQL, Envoy/HAProxy, Coraza, OWASP CRS,
CrowdSec, Valkey, MinIO, …) are **execution engines**, connected only through
Cloud Wai-owned adapters.

This is not a static site and not a thin wrapper around a competitor SaaS.

## Source of truth

| Document | Contents |
|---|---|
| [`DEV_AGENT_BLUEPRINT.md`](DEV_AGENT_BLUEPRINT.md) | Architecture, rules, repository layout |
| [`DEV_AGENT_REPOSITORY_MAP.md`](DEV_AGENT_REPOSITORY_MAP.md) | Canonical engine inventory and inspection protocol |
| [`LICENSES/third-party-inventory.md`](LICENSES/third-party-inventory.md) | Pinned engine commits, SPDX ids, adopt/wrap/reject decisions |
| [`docs/adr/`](docs/adr/README.md) | Architecture decision records, threat model, ERD/RLS, state machines |

## Architecture

```text
Browser -> Cloud Wai Web -> Cloud Wai API/BFF -> Control-plane Supabase PostgreSQL
                                      -> durable Orchestrator/Workers
                                      -> Coolify Hosting Adapter
                                      -> Database/Storage Adapters
                                      -> Security Edge Adapter
                                      -> Domain Reseller Adapter
```

The control-plane database is permanent and stores identity, organizations,
memberships, projects, deployments, data resources, domains, security policies,
API keys, billing, jobs and audit events. Customer tenant databases are a
**separate data plane** and are never conflated with the control plane.

## Repository layout

```text
apps/web                  React dashboard, URL-driven routes
apps/api                  tRPC/BFF — auth, validation, policy checks
apps/orchestrator         durable command execution and reconciliation
apps/security-control     policy compiler, rules, incidents
apps/worker               idempotent queue consumers
packages/contracts        status vocabulary, DTOs, event names
packages/auth             Supabase session -> Cloud Wai principal
packages/authorization    org/project/resource permission matrix
packages/database         control-plane repositories and migrations
packages/adapters         Hosting, Database, Storage, Edge, Domain interfaces
packages/security         policy model, risk levels, edge config
packages/observability    redaction and telemetry contracts
packages/ui               accessible Cloud Wai design system
infra/edge                Envoy/HAProxy, Coraza, CRS
infra/runtime             container/network hardening
infra/deployment          manifests, backups, runbooks
supabase/migrations       control-plane schema only
docs/adr                  architecture decisions
tests                     contract, isolation, integration, load
LICENSES                  SPDX inventory and third-party notices
```

## Working in this repository

```bash
pnpm install
pnpm verify        # build + typecheck + test
```

`pnpm verify` must be green after every change. `engines-src/` holds git-ignored,
read-only engine clones used for source inspection; no engine source is ever
committed into this tree.

## Rules this repository enforces

- Supabase Auth is the only browser identity source.
- Organization scope is resolved from the authenticated principal, never from
  client input; RLS is enabled on every table.
- The browser talks only to Cloud Wai APIs — never to Coolify, Docker,
  PostgreSQL, MinIO, Envoy admin, CrowdSec or a host firewall.
- Every adapter operation is idempotent, timeout-bounded, retryable with backoff
  and auditable.
- An unconfigured or unreachable engine reports `not_configured` / `pending` /
  `failed` / `degraded`. Success is never fabricated.
- Each engine stays an independent, version-pinned service with its license and
  upgrade boundary preserved.

## Status

Phases 0 and 1 are implemented and verified (engine inspection + ADRs + license
inventory; monorepo skeleton with a green `pnpm verify`). Phases 2–5 are in
progress; see [`docs/adr/0006`](docs/adr/0006-phased-plan-and-acceptance-tests.md)
for exactly what is verified today and what still requires a configured engine.

Cloud Wai is the product. Coolify, Supabase, Coraza, OWASP CRS, CrowdSec,
Envoy/HAProxy, PostgreSQL, MinIO and container runtimes are replaceable engines.
