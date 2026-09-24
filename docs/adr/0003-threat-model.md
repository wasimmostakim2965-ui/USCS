# Threat model — Cloud Wai control plane

- Status: living document (initial version)
- Date: 2026-09-23
- Scope: Cloud Wai control plane, control-plane database, orchestration, engine
  adapters and the security edge.

This is an engineering threat model, not a claim of being unhackable. It must be
revisited whenever a trust boundary moves.

## Trust boundaries

```text
[1] Browser (untrusted)
    |  HTTPS, Supabase session (JWT) -- two routes, not one
    |
    |-- (a) Cloud Wai API/BFF  <-- the server the product UI calls
    |       |  server-side authz, no client-supplied org scope
    |       v
    |-- (b) PostgREST, straight to [3] with the anon key + the user's JWT
    |       |  this path is reachable from the browser and is guarded by RLS
    |       |  and the engine-column guards, NOT by the API's procedure layer
    v
[3] Control-plane Supabase PostgreSQL  (RLS enabled on every table)
```

Route (b) is easy to forget and expensive to forget: the browser ships with the
anon key by design, so a member can PATCH a table directly without the API ever
seeing the request. Anything the API enforces in TypeScript must therefore also
be enforced in the database, or a client can walk around it.

```text
[3] Control-plane Supabase PostgreSQL
    |
    v
[4] Orchestrator -> queue -> Worker
    |
    +--> HostingAdapter   -> [5] Coolify instance        (private network)
    +--> DatabaseAdapter  -> [6] tenant PostgreSQL       (separate instance/creds)
    +--> StorageAdapter   -> [7] MinIO/S3                (separate creds/prefixes)
    +--> SecurityEdgeAdapter -> [8] edge (Envoy/HAProxy + Coraza/CRS)
    +--> DomainResellerAdapter -> [9] registrar (credentials + legal approval)
    |
    v
[10] Telemetry: OTel Collector -> Prometheus/Grafana (redacted)
```

Assets worth protecting: control-plane credentials, tenant credentials, provider
API tokens, API keys (hashed), audit integrity, origin addresses, customer data
in tenant databases and buckets, and the policy that governs the edge.

## Attack paths and mitigations

| # | Attack path | Mitigation | Verified by |
|---|---|---|---|
| A1 | Client supplies another tenant's `organization_id` | Scope is resolved from the principal's membership server-side; client input is never trusted | two-org isolation test on every procedure |
| A2 | API key exceeds its owner's scopes or membership | Keys are hashed, scoped, and intersected with the member's live capabilities | API-key scope tests |
| A3 | Retry duplicates a deployment or a charge | Idempotency key recorded before dispatch; jobs keyed by it | replay tests |
| A4 | Secrets leak through logs or API responses | Redaction layer (`@cloud-wai/observability`); secrets never returned by list endpoints | redaction tests |
| A5 | Origin reached directly, bypassing the WAF | No public origin ports; edge-to-origin via private tunnel/mTLS; origin-leak detection | origin-denied test |
| A6 | Tenant reaches another tenant's network/filesystem | Isolated networks, non-root containers, seccomp/AppArmor, resource limits, no Docker socket | tenant-to-tenant test |
| A7 | Customer input becomes a shell/Docker/firewall command | Input is validated and never interpolated into commands; nftables rules are generated, atomic and narrow | injection fixtures |
| A8 | WAF rule drift or false positives break real traffic | CRS is pinned; exclusions and regression fixtures are versioned; safe traffic uses a fast path | CRS fixtures |
| A9 | Provider compromise becomes control-plane compromise | Provider credentials are scoped, encrypted, rotated and excluded from logs; provider is never identity | credential-scope review |
| A10 | Policy rolls back to a weaker version at the edge | Policy version is monotonic; the edge rejects stale versions | policy version tests |
| A11 | Credential theft from the control-plane DB | RLS on every table, least-privilege roles, tenant credentials cannot query control-plane tables | RLS matrix |
| A12 | DDoS saturates the origin | Upstream/edge DDoS capacity, rate limiting with a fast cache, separate deep-inspection path | load tests |
| A13 | A member forges a fact only an engine may assert — self-certifying a domain, marking a resource ready, activating a policy, or recording their own engine — to bypass verification or billing | RLS alone is not enough: it is a *row* rule, so a blanket UPDATE policy lets a member set any column. Engine-observed columns are guarded at the column level (`0006_engine_column_guards.sql`); they change only in a session that bypasses RLS | engine-column guard probe |

## Explicit non-goals and non-claims

- We do not claim the platform is "unhackable". The goal is defense in depth with
  a hidden origin.
- CrowdSec is an additional signal, not a substitute for the WAF or isolation.
- CRS detects generic web attacks, not business-logic vulnerabilities.
- The control-plane DB and tenant DBs are separate planes and are never
  conflated; a breach of one must not grant the other.

## Open items requiring investigation, not assumption

1. Which edge implementation ships first — Envoy or HAProxy — pending a
   benchmark. HAProxy's GPL-2.0 obligations make Envoy the default meanwhile.
2. The exact Coolify status strings that map to `degraded` versus `failed`.
3. GoTrue's concrete token/session failure modes, since its source is not in the
   Supabase repo and only its HTTP/JWT contract is available.
4. MinIO's license terms for the specific deployment model chosen (AGPL service
   use is acceptable; redistribution is not planned).
5. Whether tenant databases run on the same host as the control plane in the
   first deployment, or on a separate host from day one.
