# Cloud Wai — Dev Agent Implementation Blueprint

## Mission

Build Cloud Wai as a production-grade web SaaS control plane for self-operated hosting and data services. This is not a static website and not a thin wrapper around a competitor SaaS. Cloud Wai owns identity, organizations, projects, billing, policies, audit, orchestration contracts and security policy. Open-source systems are execution engines connected through explicit adapters.

Do not copy third-party repositories wholesale into one uncontrolled source tree. Preserve each upstream license, attribution, version and upgrade boundary. Use a monorepo with separately deployable services and adapter packages.

## Architecture

```text
Browser -> Cloud Wai Web -> Cloud Wai API/BFF -> Control-plane Supabase PostgreSQL
                                      -> durable Orchestrator/Workers
                                      -> Coolify Hosting Adapter
                                      -> Database/Storage Adapters
                                      -> Security Edge Adapter
                                      -> Domain Reseller Adapter
```

The control-plane database is permanent and stores users, organizations, memberships, projects, deployments, data resources, domains, security policies, API keys, billing, jobs and audit events. Customer tenant databases are a separate data-plane product and must never be conflated with the control-plane database.

## Repository layout

```text
cloud-wai/
├── apps/web/                  # React dashboard, URL-driven routes
├── apps/api/                  # tRPC/BFF, auth, validation, policy checks
├── apps/orchestrator/         # durable command execution and reconciliation
├── apps/security-control/     # policy compiler, rules, incidents
├── apps/worker/               # idempotent queue consumers
├── packages/contracts/        # Zod schemas, DTOs, event names
├── packages/auth/             # Supabase identity/session mapping
├── packages/authorization/    # org/project/resource permission matrix
├── packages/database/         # control-plane repositories and migrations
├── packages/adapters/         # Hosting, Database, Storage, Edge interfaces
├── packages/security/         # policy model, risk levels, edge config
├── packages/observability/    # logs, metrics, traces
├── packages/ui/               # accessible Cloud Wai design system
├── infra/edge/                # Envoy/HAProxy, Coraza, CRS
├── infra/runtime/             # container/network hardening
├── infra/deployment/          # manifests, backups, runbooks
├── supabase/migrations/       # control-plane schema only
├── docs/adr/                  # architecture decisions
├── tests/                     # contract, isolation, integration, load
└── LICENSES/                  # SPDX inventory and third-party notices
```

## Identity and tenant isolation

Supabase Auth is the only browser identity source. Every API request resolves to a Cloud Wai principal. Never use a hosting engine user as customer identity.

Required entities: profiles, organizations, organization_members, projects, environments, deployments, data_resources, domains, security_policies, api_keys (hashed and scoped), orchestration_jobs, billing/usage, audit_logs.

Every list/get/update/delete/job/log/backup/secret operation must enforce organization scope server-side. Never trust organization_id from the browser. Resolve membership from the authenticated principal. Keep Supabase RLS enabled. Test two organizations against every procedure and API route.

## Provider contracts

Provider SDKs and API shapes must not leak into UI or generic API code.

```ts
interface HostingAdapter {
  createApplication(input): Promise<OperationRef>;
  deploy(input): Promise<OperationRef>;
  getDeployment(ref): Promise<DeploymentState>;
  cancelDeployment(ref): Promise<void>;
  rollback(input): Promise<OperationRef>;
  getLogs(ref, cursor?): Promise<LogPage>;
  deleteApplication(ref): Promise<void>;
  reconcile(ref): Promise<DeploymentState>;
}
interface DatabaseAdapter {
  provision(input): Promise<DataResourceRef>;
  rotateCredentials(ref): Promise<void>;
  backup(ref): Promise<BackupRef>;
  restore(input): Promise<OperationRef>;
  destroy(ref): Promise<void>;
}
interface SecurityEdgeAdapter {
  publishRoute(input): Promise<OperationRef>;
  removeRoute(input): Promise<void>;
  applyPolicy(input): Promise<PolicyVersion>;
  quarantine(input): Promise<void>;
  inspectHealth(input): Promise<EdgeHealth>;
}
```

All operations must be idempotent, timeout-bounded, retryable with backoff and auditable. Provider failure must show honest pending/failed/degraded/not-configured state; never fake success.

## Coolify hosting integration

Use Coolify as a version-pinned deployment provider through a HostingAdapter. Do not embed its entire application by default. Maintain a compatibility suite against the selected upstream commit and preserve Apache-2.0 notices.

Mapping: Cloud Wai organization -> provider team; project -> provider project; environment -> provider environment; application -> provider resource; deployment -> provider operation reference; domain -> edge route plus provider configuration.

Before production, test cross-organization isolation for applications, secrets, logs, backups, destinations, webhooks, API tokens and deletion. Prefer a dedicated provider instance or dedicated destination per trust boundary. Never pass unvalidated customer input to Docker, SSH, shell or provider APIs.

## Database and storage

Keep two separate planes:

1. Control-plane Supabase PostgreSQL: identity, orgs, projects, policies, billing, audit.
2. Customer tenant data services: provisioned by DatabaseAdapter on self-operated PostgreSQL/MinIO or a reviewed provider.

Use separate credentials, networks, encryption keys, backup destinations and lifecycle workflows. Tenant credentials must not query control-plane tables. Secrets are encrypted at rest and never returned by list endpoints.

## Security edge

```text
Internet
  -> upstream/edge DDoS capacity
  -> Envoy or HAProxy
  -> Coraza WAF + OWASP CRS
  -> fast Redis-backed rate/risk cache
  -> Cloud Wai policy engine
  -> private origin tunnel/mTLS
  -> isolated tenant runtime
```

Requirements: no public origin by default; only edge ingress reaches application ingress; management SSH is private/key-only; edge-origin uses mTLS and short-lived credentials; Coraza/CRS is tuned and observable; static safe requests use a fast path while login, mutation, upload, admin and suspicious requests use deep inspection; CrowdSec may provide behavioral detection but is not a substitute for WAF or isolation.

Runtime hardening: nftables, non-root containers, network policies, seccomp/AppArmor, CPU/memory/PID limits, read-only filesystems where possible, egress restrictions, secret isolation and no Docker socket exposure. A compromised tenant must not reach another tenant, the host, control-plane credentials or metadata services. Add DNS/certificate/header/open-port origin-leak detection and automatic incident workflows.

Never claim “unhackable”. Track origin exposure, cross-tenant denial rate, WAF false positives, p95/p99 edge latency, detection time, quarantine time, recovery time and DDoS assumptions.

## UI and API

Use deep-linkable URL routes:

```text
/dashboard
/dashboard/projects
/dashboard/projects/:projectId
/dashboard/projects/:projectId/deployments
/dashboard/projects/:projectId/domains
/dashboard/projects/:projectId/data
/dashboard/projects/:projectId/security
/dashboard/settings/organization
/dashboard/settings/api-keys
/dashboard/settings/audit-logs
```

Each route calls a typed tRPC procedure and displays loading, empty, success, degraded and error states. No mock deployments, fake metrics or placeholder connected badges.

Required flows: create org/project/environment; connect Git; configure target; deploy/log/cancel/rollback; add and verify domain; provision database/storage; configure security and rate limits; inspect incidents and audit; create scoped API key shown only once; display provider health.

Never expose secrets, origin IPs, provider credentials, raw Docker commands or cross-tenant identifiers.

## Implementation sequence

1. Repository skeleton, package boundaries, lint/typecheck/build/test.
2. Control-plane schema, RLS, identity and authorization.
3. Durable job model and adapter contracts.
4. Coolify adapter with fake provider and contract tests.
5. Database/storage lifecycle state machines.
6. Edge configuration compiler and Envoy/Coraza harness.
7. Domain search/register/renew adapter contracts; no purchase integration without credentials/legal approval.
8. UI routes and real state wiring.
9. Observability, backup/restore, DR and runbooks.
10. Load, failure, security and isolation validation.

## Required tests and release gates

- Two organizations cannot read or mutate each other.
- API keys cannot exceed scopes or membership.
- Retries cannot duplicate deployments or charges.
- Provider timeout is recoverable.
- Secrets are absent from logs and API responses.
- Direct origin access is denied.
- CRS attack fixtures are blocked while approved traffic passes.
- Tenant cannot reach another tenant network/filesystem.
- Backup restore is verified.
- Deployment and policy changes are audited.
- Load tests report p50/p95/p99 latency and throughput.
- License inventory includes SPDX identifiers, notices and pinned upstream versions.
- Threat model, ERD, RLS matrix, API contracts, state machines, SLOs, incident response and disaster recovery runbooks exist.

## First Dev-agent deliverables

Before feature implementation, produce:

1. Repository tree and service-boundary proposal.
2. ADR: Coolify adapter versus embedded fork.
3. Threat model with trust boundaries and attack paths.
4. Control-plane ERD and RLS/authorization matrix.
5. API contract list and operation state machines.
6. SPDX/license inventory plan.
7. Phased implementation plan with acceptance tests.

Cloud Wai is the product. Coolify, Supabase, Coraza, OWASP CRS, CrowdSec, Envoy/HAProxy, PostgreSQL, MinIO and container runtimes are replaceable engines. The control plane, policy model, orchestration contracts, tenant isolation, billing, audit and user experience remain Cloud Wai-owned.

This blueprint is an engineering plan, not an absolute security claim. Production release requires authorized security review and operational validation.
