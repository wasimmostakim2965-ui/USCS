# Master plan — closing the gap to a world-class deploy platform

This is the planning document the brief asks for. It answers the owner's
questions directly — how the backend works, how a website gets deployed, how a
GitHub change flows through to a live update, and how the edge can stop an
attacker without stopping Googlebot, a scraper-budget problem, or a normal user —
and then lays out the work in phases, each ending green and reported.

Status source: `docs/audit/source-audit-2026-09.md` (findings) and
`docs/competitive/vercel-feature-matrix.md` (rows).

---

## Part 1 — How Cloud Wai actually works today (traced from code)

### The control plane vs the data plane

Cloud Wai is a **control plane**. It owns identity, orgs, projects, deployments,
domains, data resources, security policy, API keys, billing, jobs, audit. The
things that actually run a customer's code are **engines** (Coolify, Postgres,
MinIO, Envoy/Coraza), reached only through `packages/adapters/*`. There is no
path from the browser to an engine (`AGENTS.md`; `apps/api/src/procedures/*`).

### What happens when a customer clicks "Deploy"

1. **Browser → API.** The dashboard posts `deployments.create` with a project id,
   a repo URL and a branch (`apps/web/src/view-model.ts`). The browser never talks
   to Coolify.
2. **Auth.** The API verifies the Supabase session and builds the principal
   (`apps/api/src/server.ts`, `packages/auth`).
3. **Authorization.** `requireCapability(ctx, orgId, "deployment:create")` —
   scope comes from server-side membership, never the request body
   (`apps/api/src/guard.ts`, `packages/authorization`).
4. **Record before act.** A `deployments` row is written `pending` *before* the
   engine is called (`deployments.ts:requestDeployment`). A crash mid-flight
   leaves a record, not an invisible half-deploy.
5. **Idempotency.** A repeated `idempotencyKey` returns the original row and does
   **not** call the engine again; a key reused across projects is a `conflict`.
6. **Durable job.** The request enqueues an `orchestration_jobs` row
   (`packages/database/src/sql-queue.ts`). The API returns immediately; the row
   stays `pending` — its honest state.
7. **Worker executes.** `apps/worker` claims the job (with a lease; `reapExpired`
   returns a dead worker's claim), and runs `executeDeployment`
   (`apps/worker/src/deployment-executor.ts`): create the Coolify application if
   the project has none, `POST /api/v1/deploy`, then **read the engine's state
   back**.
8. **Honest write-back.** The processor writes `succeeded` only if the adapter
   reported success; otherwise `failed`/`degraded`/`not_configured`. The applier
   mirrors the engine's own url and status onto the deployment row
   (`apps/worker/src/deployment-job.ts`).
9. **Audit.** Every step writes an `audit_logs` row with actor and target.

### How Coolify is given "a place" for the workload

A Cloud Wai org maps to **one Coolify team with its own token**
(`packages/adapters/src/coolify.ts:24-45`, `engines.ts:credentials`). Coolify
requires a project, server and environment to create an application, so those
live on the tenant's credential record, not per request. The adapter calls only
routes Coolify actually exposes — checked against `tests/fixtures/coolify-routes.json`
at the pinned commit (gate 14).

### How limits / "observability" work today

`observability.jobs` (`apps/api/src/procedures/observability.ts`) rolls up the
org's **own** `orchestration_jobs` rows — throughput, failures, retries, p50/p95
latency — with no synthetic metric. Time-series metrics and traces are stated as
absent until an engine is wired. There is **no rate limit or quota enforcement**
anywhere (a real gap; see Phase 4).

### How a GitHub change updates a site today

**It does not, automatically.** Today a deploy is a button that carries a repo URL
and branch (finding D4). The durable path below it is complete, so git integration
is "a receiver that enqueues the job we already have", not new execution
machinery.

---

## Part 2 — How Vercel does it, and exactly what we add

| Vercel mechanism | How it works | Our equivalent plan |
|---|---|---|
| Git integration | Vercel installs a GitHub App; a push hits a webhook; Vercel builds the affected project | **Phase 3:** a `/hooks/git` receiver verifies an HMAC signature, matches the repo+branch to a project, and enqueues `deployment.create` |
| Preview per PR | Every PR/branch gets its own URL | **Phase 3:** a preview deployment kind that names the branch/PR on the deployment row and gets its own hostname route at the edge |
| Instant rollback | Re-alias production to a previous build | **Already built** (matrix P6) |
| Env vars per env | Stored as config, injected at build/runtime | **Phase 4:** `env_vars` table + Coolify `/envs` through the adapter; a change that needs a rebuild becomes a deployment, never a silent edit |
| Promote / staged prod | Build without aliasing the domain, promote later | **Phase 4:** an explicit promote command over the same deployment rows |
| Attack mode + known bots | Challenge browsers, pass a verified-bot directory | **Phase 2** (below) |
| Spend Management | Soft alerts; users report they fail | **Phase 4:** a **hard** budget object the API enforces before it enqueues |

---

## Part 3 — The security logic the owner asked about

The question: *how can the edge stop an attacker without stopping a normal user,
a crawler, or a webhook?* This is the heart of the Security differentiator and it
is currently **missing** (findings S5, S6). The design:

### The decision must be a ladder, not a wall

A single "block" rule is wrong: it cannot tell a scraper from Googlebot. Cloud Wai
already has the right **vocabulary** — `allow | log | challenge | block |
quarantine` (`packages/security/src/index.ts:ENFORCEMENT_ACTIONS`) and four risk
levels. What is missing is the **classification step** the ladder acts on.

### Proposed compiled rule order (per route, deterministic)

```
1. ALLOW     — verified bot (crawler / monitor / webhook sender)         -> pass, nolog
2. ALLOW     — internal request (our own health checks, deploy probes)   -> pass
3. BLOCK     — explicit deny list (IP / ASN / UA)                        -> deny
4. CHALLENGE — browser-looking traffic when the route is in attack mode  -> challenge
5. WAF       — OWASP CRS anomaly score >= threshold                      -> deny (existing rule)
6. LOG       — everything else that matched an inspect rule              -> pass, log
7. PASS      — default                                                   -> pass
```

Two properties make this honest and safe:

- **Known-bot identity is data, verified not trusted.** We match on
  `User-Agent` **plus** a reverse-DNS / forward-confirmed check against a curated
  directory (e.g. Googlebot's published ranges), so a spoofed `Googlebot` UA from
  a scraper does not get the ALLOW. A UA match alone is a bypass, and Vercel's own
  docs let a customer *block* a known bot with a custom rule — proof UA-only is
  not the whole story.
- **Attack mode is scoped and expiring, and never touches the allow-list.** Like
  Vercel's `--duration 1h|6h|24h`: challenge browser traffic, pass verified bots,
  and do not count mitigated requests. Turning it on cannot break SEO because
  crawlers are step 1, before the challenge.

### Where each piece of state lives (no new trust)

| Piece | Table (org-scoped RLS) | Who writes it |
|---|---|---|
| A route's protection mode (normal / attack, + expiry) | `security_policies` extended, or a new `route_protection` row | the API, on the customer's save; expiry enforced from `expires_at` |
| Verified-bot directory | compiled constant + an operator-configurable overlay | the deployment config, not the customer |
| Deny list (IP / ASN / UA) | a new `security_rules` table, org-scoped | the API, capability `security:update` |
| Decided traffic / blocks | a new `security_events` table, org-scoped, append-only | the **edge adapter** reports; the API only reads |

Every one of those is a tenant table with RLS and the column-guard discipline:
the customer's inputs are writable, the engine-observed facts (`matched`,
`action_taken`, `rule_version`) are frozen against client writes exactly like
`domains.verified` today.

### Proven how

The compiler is pure and deterministic, so each ladder step is a unit test
(`packages/adapters/src/security-edge.ts` tests): a verified-bot UA compiles to
`pass` even in attack mode; a spoofed UA without the confirm check does not; a
CRS fixture still hits step 5. The live proof (that a real Envoy+Coraza blocks a
fixture and passes a crawler) is **gate 6/7** and stays open until an edge host
exists — we will not call it closed against a fake.

---

## Part 4 — The phased plan

Each phase ends with `pnpm verify:all` green, moved matrix rows, and a summary.
No phase claims a row **Wired** without a procedure, a page and a test.

### Phase 1 — Audit + matrix (DONE, this session)

- `docs/audit/source-audit-2026-09.md` — file-by-file findings, request flow.
- `docs/competitive/vercel-feature-matrix.md` — every Vercel row with our status.
- This plan.

### Phase 2 — Security: allow-list + attack mode (the owner's question first)

1. Add the classification ladder to `compileEdge` (pure, deterministic).
2. Add a curated verified-bot matcher + operator overlay (config, not customer).
3. Add `security_rules` (deny list) and route-protection (mode + expiry) with org
   RLS and column guards; a probe like `12_`.
4. Wire `security.policy.save/distribute` to carry the mode; expose
   `security.rules.*` procedures behind `security:update`.
5. Dashboard: a Security page that shows the ladder, the mode toggle with an
   expiry, and the deny list — every control calls a real procedure.
6. Tests: the ladder unit tests + an RLS probe. Gate 6/7 stay **open**.

### Phase 3 — Git integration + preview deployments (the biggest deploy gap)

1. A `/hooks/git` receiver: HMAC-verified, repo+branch → project, enqueues the
   **existing** `deployment.create` job. No new execution machinery.
2. A `project_git_links` table (org RLS); a connect/disconnect procedure.
3. A preview deployment kind: branch/PR named on the deployment row.
4. Dashboard: Project Settings → Git (connect a repo, branch rules); Deployments
   shows preview vs production with `source`.
5. Tests: signature rejects a forged payload; a push enqueues exactly one job.

### Phase 4 — Env vars, hard budget, cancel/restore, edge traffic view

1. Env vars: table + Coolify `/envs` via the adapter; a change that needs a
   rebuild is a deployment.
2. Usage recording + a **hard** budget object the API enforces before enqueue.
3. `deployments.cancel` (adapter already built), `data.restore` (adapter already
   built), and an edge **decided-traffic** view fed by a new `security_events`
   table.
4. Dashboard wiring for each; tests for each write path.

### Phase 5 — Database sub-pages (needs the owner's ADR-0011 decision)

The seven missing sub-pages cannot be honestly built without either reversing
ADR-0011 (give each tenant a Supabase-shaped data plane behind a new
`TenantDataPlane` adapter contract) or narrowing the section to what Coolify's
API can answer. **This is a product decision, and the plan asks for it rather
than guessing.** Recommended: reverse ADR-0011 for *introspection and auth only*
(read metadata, never tenant row data), which delivers the brief's surface while
keeping "Cloud Wai holds no tenant data-plane credentials for row data".

### Phase 6 — Observability, analytics, polish, AWS proof

Metrics/traces over `orchestration_jobs` + adapter health; then the mandatory
end-to-end proof on real Docker services, and only then the word "ready".

---

## Part 5 — The AWS / "Vercel-like environment" answer

The repo already has the shape: `infra/deployment/docker-compose.yml` (one host,
api+worker+web) and `infra/aws/terraform/` (VPC, private host, ALB+ACM, Route 53,
SSM, CloudWatch), with the same compose file in both, so they cannot drift
(ADR-0015). The dashboard container reverse-proxies `/rpc`, so the browser has
one origin and CORS stays empty.

What "Vercel-like" still needs, honestly:

- A public edge host running Envoy+Coraza so gates 6–8 can be *closed for real*
  (not faked). **Needs a VPS/EC2 + credentials.**
- A Coolify host with a team per tenant. **Needs a Coolify instance + token.**
- Multi-AZ and a second edge for the availability claims we are entitled to make
  only after we measure them.

## Part 6 — What we will never claim without proof

- Not "unhackable". The honest claim is **defence in depth + hidden origin + edge
  enforcement**, and it stays qualified until gates 6–9 are closed against real
  engines.
- Not "production-ready" while any gate is open.
- Not "better than Vercel" — the matrix is the claim, row by row, and the gaps in
  it are the work list.
