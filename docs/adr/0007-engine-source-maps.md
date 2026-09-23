# Engine source-tree maps

- Status: initial
- Date: 2026-09-23
- Method: direct inspection of the pinned clones under `engines-src/`. Nothing
  here is inferred from README prose; every structure below was observed.

## Coolify — `7c86e53422ad`, Apache-2.0

```text
coolify/
├── artisan                 # Laravel console entry point
├── composer.json           # name coollabsio/coolify, type: project, php ^8.4, laravel ^12.65
├── openapi.json/.yaml      # 202 documented API operations (OpenAPI 3.1)
├── routes/
│   ├── api.php             # /api/v1/* — auth:sanctum + api.token.team + api.ability
│   ├── webhooks.php        # provider webhooks (Git/registry callbacks)
│   └── web.php, channels.php, console.php, ai.php
├── app/
│   ├── Http/Controllers/Api/   # Applications, Databases, Deploy, Projects, Servers, ...
│   ├── Http/Middleware/        # ApiAllowed, ApiAbility, EnsureTokenBelongsToCurrentTeamMember
│   ├── Models/                 # Eloquent models (Application, Project, Server, Team, ...)
│   ├── Jobs/, Actions/, Services/, Policies/, Livewire/, Mcp/, Contracts/
├── database/               # Coolify's OWN operational migrations (not ours)
├── docker/ docker-compose*.yml   # its own deployment topology
├── tests/                  # PHPUnit + Dusk (phpunit.xml, phpunit.dusk.xml)
└── templates/, lang/, config/, bootstrap/
```

**Nature:** complete application (Laravel). **Trust boundary:** the process with
`api.token.team` handles provider credentials, Docker/SSH operations and tenant
metadata; it can reach servers and containers. **Contract we use:** `openapi.json`
plus the team/ability middleware semantics. **Tests:** `tests/`, PHPUnit.

## Supabase — `4b365eb4ee07`, Apache-2.0

```text
supabase/
├── docker/
│   ├── docker-compose.yml         # self-host topology
│   ├── docker-compose.{envoy,kong,caddy,nginx,s3,rustfs,pg17,pgbouncer}.yml
│   ├── volumes/
│   │   ├── api/kong.yml           # gateway routes: /auth/v1/{signup,token,user,jwks,...}
│   │   └── db/{roles,jwt,_supabase,realtime,webhooks,pooler,logs}.sql
│   ├── dev/data.sql               # canonical auth.uid() RLS example
│   └── tests/test-self-hosted.sh  # live auth flow test
├── apps/studio/                   # Next.js admin dashboard (complete app)
├── apps/{docs,www,learn,kb,lite-studio}/   # content/other apps
├── packages/{pg-meta,ui,common,api-types,config,shared-data}/  # libraries (MIT)
├── examples/realtime/flutter-figma-clone/supabase/migrations/20240808072352_auth.sql
│                                  # project_members + security definer is_project_member()
├── e2e/studio/                    # Playwright suites incl. rls-policies.spec.ts
└── supabase/                      # a hosted-project scaffold (config.toml + migrations)
```

**Self-host services (pinned):** `supabase/studio:2026.09.07-sha-7996410`,
`envoyproxy/envoy:v1.39.1` (default gateway), `supabase/gotrue:v2.196.0`,
`postgrest/postgrest:v14.17`, `supabase/realtime:v2.134.10`,
`supabase/storage-api:v1.74.0`, `supabase/postgres-meta:v0.99.0`,
`supabase/edge-runtime:v1.76.2`, `supabase/postgres:17.6.1.136`,
`supabase/supavisor:2.9.12`.

**Nature:** deployment topology + dashboard app + libraries. The auth server
source is **not** here — GoTrue ships as an image, so we depend on its HTTP/JWT
contract. **Identity mechanism:** GoTrue issues a JWT; `auth.uid()` reads
`request.jwt.claim.sub`, set at the start of each REST request. **Contract we
use:** the `/auth/v1/*` endpoints and `auth.uid()`/`auth.jwt()` SQL helpers.

## Edge and security engines

| Engine | What it is | Integration surface observed | Tests |
|---|---|---|---|
| Envoy `86ef39f7b7c9` | C++ data-plane binary (`source/exe/main.cc`) | `api/envoy/extensions/filters/http/ext_authz/v3/ext_authz.proto`; `api/envoy/service/auth/v3/external_auth.proto` (`Check`); `api/envoy/service/ratelimit/v3/rls.proto` (`ShouldRateLimit`); `transport_sockets/tls/v3/tls.proto`; HCM `access_log` | `test/extensions/filters/http/ext_authz/`, `.../ratelimit/` |
| HAProxy `e6f616af97c9` | C data-plane binary (`src/haproxy.c`) | SPOE filter (`doc/configuration.txt` §9.3, `send-spoe-group`), stick-table counters `sc-inc-gpc0`, `http-request deny` | `reg-tests/*.vtc` |
| Coraza `db9850b2dd89` | Go **library** `github.com/corazawaf/coraza/v3` | `waf.go` `NewWAF`; `types/transaction.go` `ProcessRequestHeaders/Body`, `ProcessResponse*`; `http/middleware.go` `WrapHandler`; CRS loaded via `WithRootFS`/`WithDirectives` | `testing/`, `http/*_test.go` |
| OWASP CRS `bbbd006907f0` | Rule data (CRS 4.30.0-dev) | `rules/REQUEST-9xx-*.conf`, `crs-setup.conf.example`, plugins `*-config/before/after.conf` | `tests/regression/` (325 YAML cases) |
| CrowdSec `a8dbeb94efb6` | Daemon + CLI | LAPI `/v1`: `POST /watchers`, `/alerts`, `GET /decisions` (bouncer), `/decisions/stream`, `/allowlists`, `/heartbeat` | `pkg/**/*_test.go`, `test/bats/` |
| Valkey `77b00b2ddaf1` | Server daemon (BSD-3-Clause) | ACL commands, `eval`/`FUNCTION` scripting, `maxmemory`; **no server-side rate-limit primitive** | `tests/unit/*.tcl` |

## Tooling engines (adopted, not yet wired)

`postgres` (PostgreSQL License) — `configure`/`meson`/`Makefile` builds;
`opa` (Apache-2.0) — Go, Makefile; `trivy` (Apache-2.0) — Go; `syft`
(Apache-2.0) — Go; `cosign` (Apache-2.0) — Go; `otelcol` (Apache-2.0) — Go;
`prometheus` (Apache-2.0) — Go; `grafana` (**AGPL-3.0**) — Go + Node.

`containerd`, `runc` and `cni` are recorded as **rejected for direct
dependency**: container lifecycle is owned by the hosting engine, and the runtime
is consumed transitively. This is revisited only if we run containers ourselves.

## Security path and latency budget

```text
Internet
  -> upstream/edge DDoS capacity
  -> Envoy (TLS, routing)                       ~0.3 ms budget
  -> Coraza + OWASP CRS (deep path only)        ~1.5 ms budget
  -> Valkey-backed rate/risk cache              ~0.3 ms budget
  -> Cloud Wai policy decision (cached)         ~0.2 ms budget
  -> private origin tunnel/mTLS                 ~0.5 ms budget
  -> isolated tenant runtime
```

Static, safe and cacheable requests take a fast path that skips deep inspection.
Login, upload, admin, mutation and suspicious requests take the deep path. The
edge never queries the control-plane database per request; policy is compiled and
cached with a monotonic version.
