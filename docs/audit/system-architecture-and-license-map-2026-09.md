# USCS / Cloud Wai — System Architecture, Engine and License Map

**Date:** 2026-09-28  
**Repository ref:** `main` at `1904e40`  
**Purpose:** implementation-এর আগে USCS-এর কোন component কোথায় আছে, কী দায়িত্ব নেয়, কোন trust boundary-তে থাকে, এবং কোন engine সত্যিই runtime-এ wired—তার source-backed map।

## 1. Product boundary

Cloud Wai/USCS হলো Cloud provider নিজে নয়; এটি একটি **Cloud Wai-owned multi-tenant control plane**। Cloud Wai-এর স্থায়ী source of truth:

- identity and sessions
- organizations and memberships
- projects and environments
- deployments and durable jobs
- domains and verification state
- data resources and backups
- security policies and incidents
- API keys, usage/billing records and audit events

Open-source systems হলো replaceable execution engines। কোনো engine Cloud Wai-এর identity, billing বা audit truth নয়।

```text
Browser
  -> apps/web: React dashboard, URL-driven project/workspace navigation
  -> apps/api: authenticated HTTP JSON-RPC/BFF boundary
  -> Supabase: control-plane Auth + Postgres + RLS
  -> apps/worker: durable queue consumer and reconciliation
  -> adapter contracts
      -> Coolify: hosting and tenant database lifecycle
      -> MinIO/S3: object storage
      -> Envoy + Coraza + CRS: security edge/WAF
      -> optional security signals: CrowdSec/OPA
  -> observability contracts: telemetry/metrics/log pipeline
```

Browser কখনো Coolify, Docker, PostgreSQL, MinIO, Envoy admin API, CrowdSec বা host firewall-এ সরাসরি call করবে না।

## 2. Repository map

| Layer | Location | Responsibility | Runtime status |
|---|---|---|---|
| Web | `apps/web` | Dashboard, routes, view-models, loading/empty/error/not-configured states | **Wired** |
| API/BFF | `apps/api` | Session verification, authz, procedures, webhooks, audit, durable job creation | **Wired** |
| Worker | `apps/worker` | Queue claim/lease/reap, deployment/data/security execution, reconciliation | **Wired** |
| Orchestrator | `apps/orchestrator` | Orchestration-facing contracts/utilities | **Contract/support layer** |
| Security control | `apps/security-control` | Policy/security control process boundary | **Contract/support layer** |
| Contracts | `packages/contracts` | IDs, DTOs, operation states and provider vocabulary | **Wired** |
| Auth | `packages/auth` | Supabase session/JWT mapping, encrypted secrets | **Wired** |
| Authorization | `packages/authorization` | Organization/project/resource permission matrix | **Wired** |
| Database | `packages/database` | Control-plane repositories, Supabase client, SQL queue | **Wired** |
| Adapters | `packages/adapters` | Coolify, Postgres-via-Coolify, MinIO, security edge, build/serverless contracts | **Mixed: real + honest n/c** |
| Security model | `packages/security` | Policy model, risk levels and edge configuration | **Wired at model/compiler level** |
| Observability | `packages/observability` | Log/metric/trace contracts and redaction | **Contract layer; external collector not wired** |
| UI kit | `packages/ui` | Cloud Wai design tokens, icons and accessible React primitives | **Wired** |
| Migrations | `supabase/migrations` | Control-plane schema, RLS and engine-observed guards | **Wired** |
| Deployment | `infra/deployment`, `infra/aws` | Compose, Dockerfiles, host bootstrap and Terraform | **Shape exists; live validation pending** |
| Edge/runtime | `infra/edge`, `infra/runtime` | Intended edge and runtime hardening boundary | **Not a complete live data plane** |
| Evidence | `tests`, `docs/release-gates.md`, `docs/adr` | Contract, isolation, failure and release evidence | **Strong contract evidence; real-engine gates open** |

## 3. Engine inventory and actual usage

### Default execution engines

| Engine | License | Cloud Wai role | Integration decision | Actual code state |
|---|---|---|---|---|
| Supabase | Apache-2.0 root; component licenses must still be tracked | Auth, control-plane Postgres, RLS | Adopt | **Runtime dependency** |
| Coolify | Apache-2.0 | Hosting/deployment and tenant database lifecycle | Wrap through `HostingAdapter`/`DatabaseAdapter` | **Real adapter; credentials required** |
| PostgreSQL | PostgreSQL License | Relational engine | Adopt as service, separate from control plane where applicable | **Consumed through Coolify path; no tenant DB direct connection** |
| MinIO | AGPL-3.0 | S3-compatible object storage | Adopt as independent service behind `StorageAdapter` | **Real SigV4 adapter; endpoint/credentials required** |
| Envoy | Apache-2.0 | Primary edge data plane | Adopt behind `SecurityEdgeAdapter` | **Compiler/adapter exists; live edge required** |
| Coraza | Apache-2.0 | WAF library | Wrap behind security edge | **Policy compiler integration; live WAF required** |
| OWASP CRS | Apache-2.0 | WAF rules | Adopt pinned rule set | **Rules compiled/tested; live fixture gate open** |

### Additional security/operations engines

| Engine | License | Intended use | Current status |
|---|---|---|---|
| CrowdSec | MIT | Behavioural detection/remediation signal | Adopted in design; no complete production runtime wiring found |
| Valkey | BSD-3-Clause | Rebuildable cache, rate/risk state and queue support | Adopted in design; current durable truth is SQL queue |
| OPA | Apache-2.0 | Compiled policy evaluation | Adopted in design; no complete runtime deployment path |
| HAProxy | GPL-2.0-only with documented exceptions | Optional edge alternative | Explicitly non-default due to obligations |
| Trivy | Apache-2.0 | Image/filesystem vulnerability scanning | Tool listed; CI/runtime invocation not yet a product path |
| Syft | Apache-2.0 | Per-release SBOM | Tool listed; SBOM publication pipeline not yet wired |
| Cosign | Apache-2.0 | Image signing and verification | Tool listed; trusted deploy verification not yet wired |
| OpenTelemetry Collector | Apache-2.0 | Async logs/metrics/traces pipeline | Contract/redaction model exists; collector deployment not wired |
| Prometheus | Apache-2.0 | Metrics and alerting | Listed and planned; production scrape/alert topology not wired |
| Grafana | AGPL-3.0 | Internal operator dashboards | Listed as independent service; dashboard deployment not wired |
| containerd/runc/CNI | Apache-2.0 | Underlying runtime/networking | Rejected as direct Cloud Wai dependencies while Coolify owns lifecycle |

## 4. Trust boundaries

### Control plane

Supabase Auth identifies the browser user. The API resolves the authenticated principal and organization membership. The URL's organization/project ID is never treated as authorization. RLS protects the control-plane database, while server-side authorization protects procedure behavior.

### Data plane

Customer Postgres and object storage are separate resources. Tenant credentials must not enter API responses, browser bundles or logs. The current ADR intentionally avoids direct Cloud Wai SQL access to customer databases; table editor, SQL editor, database auth/API/roles/log pages therefore remain honest gaps until a deliberate data-plane access model is approved.

### Provider boundary

The adapter receives Cloud Wai IDs plus a provider reference and per-organization credentials. Provider UUIDs never become tenant boundaries. Coolify is never the identity source and never the canonical billing/audit store.

### Edge boundary

The intended request path is:

```text
Internet -> upstream DDoS capacity -> Envoy -> Coraza/CRS -> rate/risk cache
         -> compiled Cloud Wai policy -> private origin/mTLS -> tenant runtime
```

The edge must not query the control-plane database per request. Policy is compiled, versioned and cached. Direct-origin denial and CRS fixture blocking remain open until a real edge is deployed.

## 5. License and attribution rules

- Cloud Wai workspaces are private `UNLICENSED`; third-party engine source is not vendored into the repository.
- Every engine is pinned by commit in `LICENSES/engines.json` and reproducible from `engines-src/`.
- Coolify, Envoy, Coraza, CRS, OPA, Trivy, Syft, Cosign, OpenTelemetry, Prometheus and Valkey are permissive-license components, but notices and dependency-level licenses still need to be preserved for any redistributed image.
- MinIO and Grafana are AGPL-3.0 and must remain independently deployed services unless a separate legal review approves another distribution model. No source is linked or copied into Cloud Wai.
- HAProxy remains optional and non-default because a modified/redistributed GPL build creates additional source and notice obligations.
- Supabase is a distribution containing multiple services and dependencies. The root Apache-2.0 entry is not a substitute for retaining the notices of every image/package actually redistributed.
- This is an engineering inventory, not legal advice. Before commercial redistribution, generate a complete dependency SBOM and have counsel verify the service/distribution boundary.

## 6. What “ultimate professional” means for this system

The required quality bar is not more mock pages. It is:

1. **One source of truth:** Cloud Wai owns identity, authorization, state and audit.
2. **Replaceable engines:** provider SDK shapes stop at adapters.
3. **Honest state:** no green status without an engine result.
4. **Durable operations:** idempotency, lease/retry/reconcile and rollback are persisted.
5. **Tenant isolation:** organization/project/resource scope is enforced in API and RLS.
6. **Secure runtime:** no public origin, no Docker socket in tenant workloads, non-root containers, restricted egress and tested metadata protection.
7. **Release integrity:** pinned source, reproducible build, SBOM, vulnerability scan, signed image and verified deployment.
8. **Operational evidence:** real Coolify, MinIO/Postgres, edge and restore drills—not only contract tests.
9. **Professional UI:** URL-driven navigation, project context, keyboard access, responsive layout, clear loading/empty/degraded/error states and no dead controls.
10. **Safe evolution:** every engine upgrade re-runs route conformance, isolation, failure and license checks.

## 7. Current implementation priorities

1. Make the AWS/Compose environment contract complete, especially secret encryption, public Supabase origin and per-organization engine credentials.
2. Choose one canonical real deployment path: Coolify-managed build/deploy or a separately deployed authenticated builder. Do not keep both half-wired.
3. Run one real disposable tenant end-to-end: connect Git, build, deploy, logs, redeploy, rollback and delete.
4. Deploy the real edge and verify direct-origin denial plus CRS regression fixtures.
5. Verify a real Postgres/MinIO backup and restore.
6. Wire SBOM, Trivy, Cosign, OpenTelemetry, Prometheus and operator Grafana only after the runtime topology is fixed; UI must report each one as unavailable until then.
7. Close product-level missing surfaces deliberately: env vars, observability, notifications, deployment protection and database introspection must each have a real adapter contract before UI claims support.

## References

- `DEV_AGENT_BLUEPRINT.md`
- `DEV_AGENT_REPOSITORY_MAP.md`
- `LICENSES/engines.json`
- `LICENSES/third-party-inventory.md`
- `docs/adr/0001-adapter-integration-over-engine-embedding.md`
- `docs/adr/0007-engine-source-maps.md`
- `docs/adr/0009-real-engine-adapters.md`
- `docs/adr/0011-data-engines-and-security-edge.md`
- `docs/adr/0016-vercel-feature-parity.md`
- `docs/release-gates.md`
