# Source-code audit — Cloud Wai, 2026-09

This is the audit the brief asked for before any design work: a file-by-file read
of the whole product, a traced request flow, and a per-finding classification.
It is deliberately *findings*, not a status report. Every row carries a status
and, where it matters, a file and line so a reviewer can check it.

## Status vocabulary (used everywhere in this record)

| Status | Meaning |
|---|---|
| **Implemented** | A real procedure reaches a store or adapter; the UI shows that answer. |
| **Partially implemented** | The path works end to end but a documented part is absent (one branch, one caller, one column). |
| **Contract-only** | The adapter interface and its tests exist; no procedure or page reaches it. |
| **Mocked / faked** | A test-only in-memory implementation. Correct only off the production path. |
| **Not-configured** | The procedure is real; the engine has no credentials, so the adapter returns `not_configured` and the UI says so. Never a green badge. |
| **Missing** | No route, page, procedure, store method or adapter operation. |

## How a request flows, end to end

Traced from the code, not from prose:

1. **Browser** holds the Supabase anon key + the user's JWT and calls the
   dashboard's own origin (`apps/web/src/api-client.ts`). It only ever talks to
   `/rpc`; it never reaches Coolify, Postgres, MinIO or the edge.
2. **Reverse proxy** (the web container's nginx) forwards `/rpc` and `/healthz`
   to the API (`infra/deployment/docker-compose.yml`, `web` service), so the
   browser has one origin and CORS stays empty.
3. **API** (`apps/api/src/server.ts`) verifies the session
   (`packages/auth/src/supabase-verifier.ts`), builds a `RequestContext` with a
   verified principal, and routes to a procedure (`apps/api/src/router.ts`).
4. **Procedure** (`apps/api/src/procedures/*.ts`) resolves scope from
   server-side membership (`requireCapability`, `apps/api/src/guard.ts` +
   `packages/authorization`), writes its row through the store, and only then
   calls an engine — through `packages/adapters/*` and never directly.
5. **Store** (`packages/database/src/supabase-store.ts`) talks PostgREST with
   the service-role key; RLS is the second, independent enforcement layer
   (`supabase/migrations/0002_rls.sql` + column guards `0006`/`0007`/`0009`).
6. **Durable path**: deploy, rollback, backup and policy distribution enqueue an
   `orchestration_jobs` row (`packages/database/src/sql-queue.ts`); the
   **worker** (`apps/worker`) claims it, calls the adapter, and mirrors the
   engine's own answer onto the customer-facing row. A non-success is never
   written as success (`apps/worker/src/processor.ts`).
7. **Engine** = Coolify (`packages/adapters/src/coolify.ts`), Coolify's database
   API (`postgres.ts`), MinIO (`minio.ts`), Envoy/Coraza (`security-edge.ts`) —
   each pinned, timeout-bounded, and checked against the engine's real route
   table (`tests/fixtures/coolify-routes.json`, gate 14).

## Findings

### Architecture

| # | Finding | Where | Status |
|---|---|---|---|
| A1 | Boundaries are clean: routers import procedures, procedures import the store and the `Engines` bag, only `packages/adapters/*` imports an engine SDK/URL. No router imports an engine. | `apps/api/src/procedures/index.ts:1-100`; `packages/adapters/src/engines.ts:1-40` | Implemented |
| A2 | Tenant isolation is enforced twice — server-side membership in the guard, then RLS in Postgres — because the browser can reach PostgREST directly. | `apps/api/src/guard.ts`; `supabase/migrations/0002_rls.sql`; `tests/isolation/rls/10_isolation_probe.sql` | Implemented |
| A3 | Engine-observed columns (`deployments.status/url/provider*`, `domains.verified`, `data_resources.state/provider`, `security_policies.state`, `projects.provider*`) are frozen against client writes on INSERT and UPDATE. | `supabase/migrations/0006_…sql`, `0009_…sql`; probes `12_`, `15_` | Implemented |
| A4 | `apps/orchestrator` is a descriptor only (`describe()`); it has no runtime loop and nothing imports it. The orchestration *code* lives in `apps/worker` instead. | `apps/orchestrator/src/index.ts:1-24` vs `apps/worker/src/*` | Partially implemented (documentation-only boundary) |
| A5 | `apps/worker/src/handlers.ts` (`buildHandlers`, `JOB_KINDS`) is **dead in production**: `runtime.ts` builds a different handler table (`buildDeploymentJobHandler`/`buildBackupJobHandler`/`buildPolicyJobHandler`). `buildHandlers` is referenced only from `tests/integration/worker-processing.test.ts`. Two handler tables for the same job kinds can drift. | `apps/worker/src/handlers.ts:12,61`; `apps/worker/src/runtime.ts:100-140`; `apps/worker/src/index.ts:9` | Dead code (test-only) |
| A6 | The deployment algorithm exists twice — inline in the API's synchronous branch and in the worker's `executeDeployment`. This is *documented* as a deliberate apps-may-not-import-apps choice, but it is a duplication a reviewer must keep in step. | `apps/api/src/procedures/deployments.ts:388-420`; `apps/worker/src/deployment-executor.ts:1-20` | Partially implemented (documented duplication) |
| A7 | The security edge adapter is real but not reachable in production: `buildEngines` only accepts a *pre-built* edge via `EngineConfig.securityEdge`, and no production caller constructs one (`createEnvoySecurityEdge` needs route/policy resolvers the API owns). So the edge is always the honest `not_configured` adapter in a real deployment. | **Fixed.** `buildDeploymentEngines` (`packages/database/src/edge-loaders.ts`) builds the real adapter over the control-plane store when `SECURITY_EDGE_URL`, a *private* `SECURITY_EDGE_ORIGIN` and a per-org `SECURITY_EDGE_TOKEN__<orgId>` are set, and both the API and the worker now call it. Without that configuration the honest `not_configured` edge is still built — never a stub. Covered by `tests/engines/edge-wiring.test.ts`. | Wired in production |

### Coding / behaviour

| # | Finding | Where | Status |
|---|---|---|---|
| C1 | ~~`cancelDeployment` unreachable~~ **Fixed.** `deployments.cancel` (`apps/api/src/procedures/index.ts:319`, `deployments.ts:cancelDeployment`) reaches the adapter's `cancelDeployment`, and the Deployments page's cancel action calls it (`CancelDeploymentModal`, `apps/web/src/pages/pages.tsx:1178-1210`). `deployment:cancel` now has a consumer. | `packages/adapters/src/coolify.ts:326`; `apps/api/src/procedures/deployments.ts:321`; `apps/web/src/pages/pages.tsx:1204` | Implemented |
| C2 | `DomainResellerAdapter` (`search`, `register`) exists as an interface but has **no implementation, no fake, and no wiring**. The landing domain-search box is pure UI that states registrar lookup is not configured. | `packages/adapters/src/index.ts:131-134`; `apps/web/src/pages/landing.tsx:120-160` | Contract-only |
| C3 | `environments` is a real table (`0001_control_plane.sql:133`) but **no procedure, store method or page reads or writes it**. Per-environment behaviour (Vercel's Preview/Production) has no surface. | `supabase/migrations/0001_control_plane.sql:133` | Missing |
| C4 | `deployments` and `audit_logs` have no pagination/cursor anywhere; the pages load every row for the org. Fine now, unbounded later. | `apps/web/src/view-model.ts` (`loadDeployments`, `loadAudit`); `packages/database/src/supabase-store.ts` | Partially implemented |
| C5 | The billing roll-up is real and org-scoped, and the worker now **writes** usage: one `deployments` unit when a production build settles as succeeded (`apps/worker/src/deployment-job.ts`) and one `backups` unit when a backup succeeds (`apps/worker/src/backup-job.ts`). A failed or unconfigured attempt writes none, so the figure counts only consumed work. The API remains read-only over `usage_records` (no client can assert a metric). | `apps/api/src/procedures/billing.ts`; `apps/worker/src/deployment-job.ts:155`; `apps/worker/src/backup-job.ts:140` | Implemented |
| C6 | `deployments.logs` reads the engine's own log lines with no redaction pass. The customer's own app logs are returned verbatim (correct); worth stating that any secret a customer's build echoes is the customer's, not scrubbed. | `apps/api/src/procedures/deployments.ts:180-230` | Implemented (by design) |
| C7 | Idempotency is correct and cross-project collisions are refused, but the *worker's* re-execution of a `running` job relies on the engine being idempotent for the same application ref; a crash between `deploy` and `getDeployment` leaves a job `running` until reap, then re-deploys. Reconcile (`reconcile`) is never called by the worker. | `apps/worker/src/processor.ts:110-160`; `packages/adapters/src/coolify.ts:430` | Partially implemented |
| C8 | No dead buttons or fake success found in the wired pages. The unwired Database sub-pages render `NotYetBuilt` prose, not disabled controls. | `apps/web/src/pages/database.tsx:87-105` | Implemented (honest) |
| C9 | The landing page is honest (no uptime badge, no green dot) and the search box is a clean search UI with a not-configured note. | `apps/web/src/pages/landing.tsx:1-40,120-160` | Implemented |
| C10 | `projects.update` can change `slug`, which is the Coolify application name used on the *next* create; renaming a slug after the application exists does not rename the engine application — the two can diverge silently. | `apps/api/src/procedures/organizations.ts:updateProject`; `apps/worker/src/deployment-executor.ts` (`name: input.projectSlug`) | Partially implemented |

### Security (the second differentiator)

| # | Finding | Where | Status |
|---|---|---|---|
| S1 | The policy model, risk levels (`low/medium/high/critical`) and enforcement actions (`allow/log/challenge/block/quarantine`) exist, compile deterministically to Coraza/Envoy, and refuse hostile host/path/origin input rather than escaping it. | `packages/security/src/index.ts`; `packages/adapters/src/security-edge.ts:78-140` | Implemented (compiler) |
| S2 | Policy never rolls backwards; a stale distribution is refused before the network call and the engine independently rejects it. | `packages/security/src/index.ts:mayDistribute`; `apps/api/src/procedures/security.ts` | Implemented |
| S3 | The origin must be a **private** address; a public origin is refused, and the generated Envoy config carries no direct-to-origin listener. | `packages/adapters/src/security-edge.ts:55-58,100-110` | Implemented (config) |
| S4 | Gates 6–9 (deny direct origin, block CRS fixtures, runtime tenant isolation, verified backup restore) are **open** — they need a live edge/engine. Correctly marked open, not passing. | `docs/release-gates.md` | Not-configured (blocks the claim) |
| S5 | ~~No allow-list / bot-pass logic~~ **Fixed.** `compileEdge` emits a deterministic ladder whose first steps are `allow-verified-bot` (UA substring **and** forward-confirmed rDNS, so a spoofed UA does not pass), `allow-internal` and `allow-trusted-ip`, *before* the deny list and the attack-mode challenge. `VERIFIED_BOTS` is the curated search-engine/uptime directory; `botAllowList` is the operator overlay for webhook senders. | `packages/adapters/src/security-edge.ts` (`VERIFIED_BOTS`, `compileEdge`); `apps/api/src/procedures/security.ts` (`security.bots.list`) | Implemented |
| S6 | ~~No "under attack" posture~~ **Fixed.** `protectionMode` (`normal`/`attack`) with an optional `protectionExpiresAt` lives on `security_policies` (`supabase/migrations/0010_security_protection_and_events.sql`), is saved through `security.policy.save`, and compiles to the ladder's `challenge` step (`challengeBrowsers`) that challenges browsers while the allow-list steps still pass bots. Expiry is enforced by `protectionIsActive`. | `packages/security/src/index.ts`; `packages/adapters/src/security-edge.ts:318`; `apps/api/src/procedures/security.ts` | Implemented (compile) |
| S7 | **Partly fixed.** The edge **decided-traffic** view is wired: `security_events` (org RLS, migration `0010`) → `security.events.list` (`apps/api/src/procedures/index.ts:490`) → the Security page's "Edge decisions" table, which shows denied/challenged/allowed per request. Still open: the *incident lifecycle* in `apps/security-control` (`IncidentTracker`) is not wired into the API, so a grouped incident is not surfaced yet — only the raw decisions are. | `apps/api/src/procedures/index.ts:490`; `apps/web/src/pages/pages.tsx:2822`; `apps/security-control/src/index.ts:85-160` | Wired (decisions); Contract-only (incidents) |
| S8 | No per-project firewall rules (rate limiting, IP allow/block, custom rules). The enforcement vocabulary is a single org-level policy. | absent | Missing |

### Deploy flow (the brief's core)

| # | Finding | Where | Status |
|---|---|---|---|
| D1 | Deploy = create-application-if-needed, then `POST /api/v1/deploy`, then read state back. The row is written before the engine call, and a repeated idempotency key replays. | `apps/api/src/procedures/deployments.ts:requestDeployment`; `apps/worker/src/deployment-executor.ts` | Implemented |
| D2 | Rollback requires a commit (Coolify refuses otherwise), is recorded as its own deployment row, and reads the engine's state back. | `apps/api/src/procedures/deployments.ts:rollbackDeployment`; `packages/adapters/src/coolify.ts:353` | Implemented |
| D3 | Build-vs-runtime logs are distinguished by `source`, preferring the engine's *deployment* handle so a failed build is explainable. | `apps/api/src/procedures/deployments.ts:deploymentsLogs` | Implemented |
| D4 | Git integration is wired end to end: a repository is connected (`git.connect`, secret shown once, AES-256-GCM at rest) through the routed **Git page** (`GitPage`, `apps/web/src/App.tsx:207` ↔ `apps/web/src/pages/pages.tsx:1648`), and a push/PR delivered to `POST /hooks/git/{org}/{link}` is HMAC-verified and enqueues the **same** `deployments.execute` job the button does. A non-production branch (or a PR) is a preview with a recorded target; the production branch is a production build. | `apps/api/src/procedures/git-links.ts`; `apps/api/src/git-hook.ts`; `apps/api/src/server.ts`; `apps/web/src/pages/pages.tsx:1648`; `supabase/migrations/0011_project_git_links.sql` | Implemented |
| D5 | **Closed.** Environment variables are wired end to end: `project_env_vars` (migration `0015`, org RLS, `value_encrypted` outside the client SELECT grant, `engine_ref`/`provider`/`provider_resource_id` frozen against client writes), `env.list/set/remove` (`apps/api/src/procedures/env-vars.ts`) over Coolify `/applications/{uuid}/envs` through the adapter, worker reconciliation before each build (`apps/worker/src/env-sync.ts`), and `EnvVarsPage`. A build-time change is expressed as a redeploy, not a silent edit. Value AES-256-GCM encrypted, never returned. Probe `21_env_var_probe.sql`, isolation `tests/isolation/env-vars.test.ts`, adapter `tests/engines/coolify.test.ts`, sync `tests/integration/env-sync.test.ts`. | Implemented |
| D6 | ~~No promote~~ **Fixed.** `deployments.promote` (`apps/api/src/procedures/index.ts:309`, `promoteDeployment`) plus the `organization_production_deployment` pointer (migration `0014`, probe `20`) let a non-production (preview) build be promoted to the production pointer; the Deployments page calls it (`apps/web/src/pages/pages.tsx:806`). | `apps/api/src/procedures/deployments.ts`; `supabase/migrations/0014_deployment_production_pointer.sql`; `apps/web/src/pages/pages.tsx:806` | Implemented |
| D7 | No deployment protection (auth to view a preview URL), no password/IP gate. | absent | Missing |
| D8 | No cron jobs, functions, edge config, analytics, speed insights, feature flags or notifications. | absent | Missing |

### Database section (the first differentiator)

| # | Finding | Where | Status |
|---|---|---|---|
| B1 | Tenant Postgres and buckets are provisioned through the engine; backup and backup-history are real; a bucket backup is correctly refused rather than faked. | `apps/api/src/procedures/data.ts`; `packages/adapters/src/postgres.ts`, `minio.ts` | Implemented |
| B2 | Seven sub-pages (Table Editor, SQL Editor, Authentication, API, Roles & Extensions, Logs, Settings) are honest placeholders. They are blocked by ADR-0011 ("Cloud Wai never opens a data-plane connection to a tenant database"), which is in direct tension with the brief's "full Supabase surface". | `apps/web/src/pages/database.tsx:70-105,600-646`; `docs/adr/0011-…md` | Missing (blocked on an ADR decision) |
| B3 | `restore` is now reachable: `data.restore` / `data.restores.list` (`apps/api/src/procedures/data.ts`), the `data_restores` table with RLS and engine-column guards (`supabase/migrations/0012_data_restores.sql`), the worker's `buildRestoreJobHandler`/`buildRestoreApplier`, and the Dashboard `RestoreResourceModal`. The restore refuses a bucket, a resource with no engine handle, an incomplete backup, a backup of another resource, and a name mismatch — and records the engine's own status. Gate 9 stays open only because a *verified* restore against a real PostgreSQL/MinIO pair is not configured here. | `apps/api/src/procedures/index.ts`; `apps/worker/src/restore-job.ts`; `apps/web/src/pages/database.tsx` | Implemented (gate 9 still needs a live engine) |
| B4 | Credential rotation is now reachable: `data.rotateCredentials` (`apps/api/src/procedures/data.ts`) gathers the resource's own name as confirmation, refuses a bucket, a resource with no engine handle, a non-member, and returns no credential (the engine holds it; the control plane keeps no copy). The Dashboard exposes a per-database `Rotate credentials` action and `RotateCredentialsModal`. Audit events `data.credentials_rotated` / `data.credentials_rotation_failed` are recorded. | `apps/api/src/procedures/index.ts`; `apps/web/src/pages/database.tsx`; `packages/authorization/src/index.ts` (`data:rotate`) | Implemented |
| B5 | **Integration bug (fixed this session).** The Postgres adapter called routes Coolify does not expose: `POST /databases/{uuid}/rotate-credentials` and `POST /databases/{uuid}/backups/{id}/executions`. Neither exists in the pinned upstream `routes/api.php`. Rotation is now `PATCH /databases/{uuid}` with `postgres_password` (the engine persists it and never returns it, so the control plane mints a pattern-compliant password and keeps no copy); restore is now `POST /databases/{uuid}/imports` with `source: 'server'` and the backup file the engine recorded in the config's newest execution. `provision` also omitted the mandatory `project_uuid`/`server_uuid`/`environment_name` (Coolify answers 422 without them); it now sends them from the credential record and reports `not_configured` when they are absent. | `packages/adapters/src/postgres.ts`; `tests/engines/coolify-routes.test.ts`; `tests/engines/data-engines.test.ts` | Implemented |
| B6 | **Test-integrity gap (fixed this session).** `tests/fixtures/coolify-routes.json` held only application routes, so the database adapter's routes could not be conformance-checked even in principle — which is why B5 survived. The fixture is now the *whole* pinned `routes/api.php` (307 routes, `/api/v1` prefix applied) and `tests/engines/coolify-routes.test.ts` drives both adapters across their lifecycles against it. | `tests/fixtures/coolify-routes.json`; `tests/engines/coolify-routes.test.ts` | Implemented |

### Honesty / test integrity

| # | Finding | Where | Status |
|---|---|---|---|
| H1 | `pnpm verify` is green: 507 tests / 30 files. `pnpm verify:rls` runs a real PostgreSQL 17 probe. | reproduced this session | Implemented |
| H2 | No `TODO`/`FIXME`/`@ts-ignore`/`as any` in `apps`/`packages`. | grep, this session | Implemented |
| H3 | Fakes are refused in production (`buildEngines` throws when `useFakes` and `NODE_ENV=production`). | `packages/adapters/src/engines.ts:150-170` | Implemented |

## The five things that most hold the product back

Ordered by impact on the brief's goal ("better than Vercel, provably"):

1. **No git integration / preview deployments (D4).** Vercel's defining feature.
   Without it, "deploy" is a manual button and the product cannot be called
   Vercel-grade. This needs a webhook receiver that enqueues the existing
   `deployment.create` job — the durable path already exists, so the work is the
   receiver + a project↔repo link + a preview deployment kind.
2. **No allow-list / known-bot pass, and no attack mode (S5, S6).** This is the
   owner's own question, and it is a real gap: the edge can block, but it cannot
   yet *distinguish* a crawler from an attacker. This is squarely in the
   Security differentiator and is the highest-leverage security work.
3. **Environment variables (D5).** The most-used project setting in the category,
   and Coolify already exposes the routes.
4. **The Database sub-pages (B2).** The first differentiator is two-ninths
   built; the blocker is a genuine ADR decision, recorded and not papered over.
5. **Edge traffic view (X16 ✅, S7).** The "built but unreachable" class keeps
   shrinking: cancel, restore and the edge decided-traffic view are now wired end
   to end with tests. X16 was previously **missing** — the `security_events` table
   existed (migration `0010`) with org-scoped, append-only RLS, but had no read
   path. It is now reachable: `security.events.list`
   (`apps/api/src/procedures/security.ts`) reads it membership-scoped, the store
   method is `listSecurityEvents` (`packages/database/src/supabase-store.ts`), and
   the Dashboard "Edge decisions" table (`apps/web/src/pages/pages.tsx`) shows
   each decision, stage and client. A deployment whose store predates the read
   answers with the honest `engine_unavailable`, surfaced as degraded rather than
   empty. What remains is not code: rows appear only when a **live edge** writes
   them, so the view is honest n/c until the edge host exists (gate 6–8
   territory). The incident lifecycle (`IncidentTracker`, X15) is still
   contract-only and stays that way.

## What was *not* found

No fabricated success on the production path; no router importing an engine; no
client-writable engine-owned column; no secret in a response or audit row; no
dead button that claims to act. The honesty rule holds across the wired surface.

## Method

Every row was read in the file it cites. The findings closed in later sessions
(A7, C1, C5, D4, D6, S5, S6, S7) carry the commit that closed them and the test
that pins them; a row moves to **Implemented** only with a procedure, a page and
a test. `pnpm verify` and `pnpm verify:rls` are green on `main`. Where a finding
is a *new* one (S5, S6, S7, C1, C3, D4–D8) it is marked, because the existing
`docs/audit/dashboard-inventory.md` and ADR-0016 did not record it.
