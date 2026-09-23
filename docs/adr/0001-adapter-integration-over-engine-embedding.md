# ADR-0001 — Adopt Cloud Wai-owned adapters over engine embedding

- Status: accepted
- Date: 2026-09-23
- Deciders: Cloud Wai engineering
- Supersedes: none

## Context

Cloud Wai is a multi-tenant cloud control plane that must own identity,
organizations, projects, billing, policy, audit and orchestration. The blueprint
and repository map direct us to use real open-source systems (Coolify, Supabase,
PostgreSQL, Envoy/HAProxy, Coraza, OWASP CRS, CrowdSec, Valkey, MinIO, …) as
execution engines, without pasting their source into one uncontrolled tree.

The repository was reset to a clean Cloud Wai foundation in `9eed894`, and
`37f7dda` added the engine inventory map, leaving `main` with only
`DEV_AGENT_BLUEPRINT.md` and `DEV_AGENT_REPOSITORY_MAP.md`. Everything below was
re-derived by inspecting the real cloned source under the git-ignored
`engines-src/`, not from README text.

## Verified engine facts (evidence)

| Engine | Pinned commit | License | What it actually is |
|---|---|---|---|
| Coolify | `7c86e53422ad` | Apache-2.0 | Complete PHP/Laravel 12 application (`composer.json` `type: project`), 202 API endpoints in `openapi.json` |
| Supabase | `4b365eb4ee07` | Apache-2.0 | Self-hosting via `docker/docker-compose.yml`; GoTrue/PostgREST/Realtime/Storage are prebuilt images, their source is **not** in the repo |
| Envoy | `86ef39f7b7c9` | Apache-2.0 | C++ data-plane binary; `ext_authz` and rate-limit gRPC protos are the integration surface |
| Coraza | `db9850b2dd89` | Apache-2.0 | Go **library** (`github.com/corazawaf/coraza/v3`, `NewWAF`), not a daemon |
| OWASP CRS | `bbbd006907f0` | Apache-2.0 | Rule data (`rules/*.conf`), CRS 4.30.0-dev |
| CrowdSec | `a8dbeb94efb6` | MIT | Daemon + CLI; LAPI `/v1` decisions stream |
| Valkey | `77b00b2ddaf1` | BSD-3-Clause | Redis-compatible server daemon |
| PostgreSQL | `74b89f8f968d` | PostgreSQL License (`COPYRIGHT`) | Relational engine |
| MinIO | `7aac2a2c5b7c` | **AGPL-3.0** | Object-storage daemon |
| HAProxy | `e6f616af97c9` | **GPL-2.0-only** (+LGPL includes, OpenSSL exemption) | C data-plane binary; SPOE is the WAF hook |
| Grafana | `a8cd63a1d87c` | **AGPL-3.0** | Operator dashboard app |

Full inventory with decision rationale: `LICENSES/third-party-inventory.md`.

Key negative findings from source inspection:

- **Supabase's auth server (GoTrue) is not in the Supabase repository.** It is
  consumed as `supabase/gotrue:v2.196.0`. We therefore depend on its published
  HTTP/JWT contract, not on its source.
- **Supabase has no `organization_members` concept for RLS.** The repo's own
  tenant-scoping example (`examples/realtime/flutter-figma-clone/.../auth.sql`)
  uses a `project_members` junction table plus a `security definer` predicate
  calling `auth.uid()`. Cloud Wai's `organization_members` model is therefore
  ours to define, not something to import.
- **Coolify's tenant boundary is a team**, enforced in
  `app/Http/Middleware/ApiAbility.php` and
  `app/Http/Middleware/EnsureTokenBelongsToCurrentTeamMember.php`: a token
  carries `team_id`, and abilities `root`/`write`/`write:sensitive`/`deploy`/
  `read:sensitive` require an `admin`/`owner` role. Members are read-only.

## Decision

We adopt **Cloud Wai-owned adapter interfaces** (`packages/adapters`) as the only
seam between the control plane and every engine. Each engine is deployed as an
independent, version-pinned service. We will NOT:

- vendor, copy or fork engine source into this repository;
- let a provider SDK type appear in UI or generic API code;
- treat any provider identifier as a tenant boundary;
- let the browser reach an engine directly.

Every adapter operation is idempotent, timeout-bounded, retryable with backoff,
auditable, and returns an honest `not_configured` / `failed` / `degraded` state
when the engine behind it cannot act.

### Consequences

Positive:

- Licenses stay clean: AGPL services (MinIO, Grafana) and GPL HAProxy are used
  as separate services, never linked into Cloud Wai code.
- Engines stay replaceable; the compatibility surface is one adapter per engine.
- The control plane keeps a single, auditable identity and policy model.

Negative / accepted costs:

- Extra network hop and an adapter translation layer per operation.
- We own the mapping from Cloud Wai entities to each provider's model
  (organization→team, project→project, environment→environment,
  application→resource, deployment→operation, domain→edge route).
- We must maintain a compatibility test suite per pinned engine version.

## Mapping to provider models

| Cloud Wai | Coolify | Supabase (control plane) |
|---|---|---|
| organization | team | `organizations` row |
| project | project | `projects` row |
| environment | environment | `environments` row |
| application | application resource | `projects` + provider ref |
| deployment | deployment operation | `deployments` row |
| domain | edge route + provider config | `domains` row |
| data resource | (Postgres/MinIO service) | `data_resources` row |

## Alternatives considered

1. **Fork Coolify and embed it.** Rejected: Apache-2.0 makes this legal but it
   would make Coolify the de-facto identity source, duplicate the dashboard, and
   couple our release cycle to upstream. Recorded in ADR-0002.
2. **Build every engine ourselves.** Rejected: out of scope and worse in security
   terms than using mature engines.
3. **Call Coolify's API directly from the UI.** Rejected: violates the rule that
   the browser talks only to Cloud Wai APIs, and would leak provider credentials
   and tenants to the client.
