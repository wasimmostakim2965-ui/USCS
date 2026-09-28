# Cloud Wai — the Vercel-technique roadmap

Status: **active plan.** Supersedes the phase ordering in ADR-0006 and the
"reverse/narrow ADR-0011" question that was blocking the Database section.

This document exists because the project had no single map from *layer* to
*component* to *port* to *status*. Without it every task looked isolated and the
same questions were re-argued each session. Everything below is grounded in
Vercel's own engineering writing, not in assumptions — sources at the end.

## 1. The technique we are copying

We copy Vercel's **technique and architecture**, never its code. This is not a
legal nicety: Vercel's control plane is closed source, so there is no code to
copy. What is public is the architecture, and architecture is not copyrightable.
What we may not do is use their name — "Vercel" is a trademark.

What we reuse is open source and industry-grade, which is the whole point: the
engines are already proven, so we never re-test them. We only build the plane
that drives them.

### 1.1 What Vercel actually is

Vercel describes itself as a **SaaS control plane on top of AWS**. It owns no
data centres. Wikipedia states plainly: *"Vercel's infrastructure uses Amazon Web
Services."* Their own AWS Marketplace listing reads *"Deployed on AWS."*

| Vercel component | Runs on |
|---|---|
| File uploads / static assets | Amazon S3 |
| Job queue | Amazon SQS |
| Build machines | **Hive** (their own platform, since Nov 2023) on Fargate/EC2 |
| Global routing | Amazon Global Accelerator + AWS Global Network |
| Cluster | Amazon EKS |
| Serverless functions | **AWS Lambda** |
| Edge functions | their own V8 isolate network |
| CDN + static serving | S3 + CDN |

The important honesty note: **Vercel built Hive itself.** Off-the-shelf build
systems did not give them the control they needed for untrusted, ephemeral,
multi-tenant builds. So "just wire up open source" is 70% true — the build
orchestration and tenant isolation are the 30% that must be ours.

### 1.2 The deployment lifecycle (three phases)

From Vercel's own documentation and blog:

1. **Upload.** The Git provider's code is fetched and the project files are
   pushed to object storage (S3).
2. **Build.** A deployment service pulls the source back, runs a **build
   container**, auto-detects the framework (35+ supported), runs the framework
   build, then **classifies the output** into three buckets:
   - static assets → CDN
   - serverless functions (SSR, API routes) → Lambda
   - edge functions (middleware) → V8 isolates
   A **deployment metadata document** is written and uploaded. This metadata is
   what the request phase routes by.
3. **Request.** The CDN gateway reads the deployment metadata and decides, per
   request path: serve the static file from storage, invoke a serverless
   function in its region, or run an edge function at the point of presence.

So the "run system" is: **metadata-driven routing + function invocation.** A
customer's app never runs inside the dashboard software. It runs on the
platform's managed compute — which for Vercel is AWS.

## 2. Our equivalent map

| Vercel | Cloud Wai | Port / file | Status |
|---|---|---|---|
| S3 (uploads, static, artifacts) | MinIO | `StorageAdapter` (`packages/adapters/src/minio.ts`) | Wired (honest n/c without creds) |
| SQS (job queue) | Postgres-backed queue | `packages/adapters/src/queue.ts`, worker | Wired |
| Fargate / EKS (containers) | Coolify | `HostingAdapter` (`packages/adapters/src/coolify.ts`) | Wired (honest n/c without creds) |
| Lambda (serverless) | Lambda / microVM | `ServerlessAdapter` (`packages/adapters/src/serverless.ts`), routed by `execution-router.ts` | Wired (honest n/c without AWS creds) |
| **Hive (build fleet)** | **Railpack / Cloud Native Buildpacks** | `BuildEngine` (`packages/adapters/src/build.ts`), **wired** through `build-run.ts` | **Wired** (Honest n/c without builder creds) |
| CDN + gateway routing | Envoy | edge fragment from `packages/adapters/src/security-edge.ts` | Compiler built; live edge absent |
| Edge functions / WAF | Coraza + CrowdSec | `SecurityEdgeAdapter` | Compiler built; live edge absent |
| Vercel Postgres | Supabase model | `DatabaseAdapter` (`packages/adapters/src/postgres.ts`) | Provisioning wired; introspection missing |
| Control plane (closed) | **Cloud Wai** | `apps/*`, `packages/*` | Ours — the actual product |

### 2.1 The layers

```
Layer 6  CONTROL PLANE   Cloud Wai            ours — the product
Layer 5  EDGE            Envoy + Coraza + CrowdSec
Layer 4  RUNTIME         Coolify (container) | Lambda/Knative (serverless)
Layer 3  ARTIFACT+METADATA  MinIO + deployment records
Layer 2  BUILD           BuildEngine -> Railpack / CNB          <-- WIRED (build.ts, build-run.ts)
Layer 1  FRAMEWORK ADAPTER  OpenNext / Build Output API
Layer 0  IDENTITY+DATA   Postgres + RLS + Supabase-shaped plane
```

## 3. What is rebuilt, what is kept — the honest answer

The owner's instruction is to follow Vercel's structure and technique. That does
**not** mean throwing away the connection layer, because the connection layer is
exactly the part Vercel-equivalent systems must own and the part that is already
proven here.

**Kept (the connection layer — tested, industry-grade, no reason to rewrite):**

- the six adapter **ports** and their boundaries (ADR-0001)
- the engine adapters themselves (Coolify, Postgres, MinIO, security edge,
  serverless) — these are the "machines" in the factory
- the job queue and worker (Vercel's SQS equivalent)
- the RLS schema and isolation probes (gate 1 — a brand-new user sees zero rows)
- the AWS Terraform + compose hosting shape (ADR-0015)

**Rebuilt along Vercel's structure (the parts that were wrong or absent):**

- the **dashboard** — reorganised around the deployment lifecycle (upload →
  build → deploy → route), not around labels
- the **deployment pipeline** — a real build step between Git and runtime,
  delivered by the `BuildEngine` port (`build.ts`, `build-run.ts`), wired into
  both deploy paths
- the **Database section** — resolved by the ADR-0011 Option A decision, no
  longer blocked; the seven sub-pages are engine-console handoffs
- the **navigation** — kept as the drill-in model, but every route backed by a
  real action

**Not rebuilt at all:** any engine. Coolify, Envoy, Coraza, MinIO, Postgres and
Lambda are already production systems; re-testing them is waste. We test our
*wiring* to them, which is the only part we wrote.

## 4. Phase plan

Each phase ends with `pnpm verify` green and a summary. No phase is "done"
because a commit message says so.

### Phase A — Architecture map and ADR (this document)

Deliverable: this file plus ADR-0018 (build engine) and ADR-0019 (rewrite scope).
Acceptance: every layer names its component, port and status; no layer is
ambiguous.

### Phase B — `BuildEngine` port (the unlock) — **DONE**

The port exists and is wired end to end:

- `BuildEngine` port in `packages/adapters/src/build.ts` with `build(ctx, input)`
  returning an artifact reference, plus log streaming and cancel
- a **Railpack** adapter behind it (`packages/adapters/src/build-railpack.ts`)
- wired through the one `DeploymentEngine` port by the shared
  `runBuildStep` (`packages/adapters/src/build-run.ts`), called by **both** the
  API's synchronous path (`apps/api/src/procedures/deployments.ts`) and the
  worker's durable path (`apps/worker/src/deployment-executor.ts`), so a
  serverless project receives a real artifact and stops reporting
  `not_configured` for a missing build
- honest `not_configured` when no builder is configured — never a fake artifact;
  a build that produces nothing ends the deploy as a failure carrying the
  builder's reason

Acceptance met: a serverless project receives a real artifact; with no builder
configured a build reports `not_configured`; `tests/engines/build-engine.test.ts`
and `tests/engines/build-step.test.ts` cover each path.

**The service behind the port is now shipped (2026-09-28).** The adapter speaks
an HTTP contract, and `infra/deployment/builder-server.mjs` implements it,
running the pinned Nixpacks binary. It is deployable: `infra/deployment/
builder.Dockerfile`, the `builder` service in `docker-compose.yml` (profile
`build`, Docker socket mount, loopback only), `deploy.sh`'s `ensure_builder`,
Terraform inputs, and the AWS bootstrap all start it. It is bounded on every
axis untrusted source can exhaust (concurrency, timeout, log volume, retention).
See [`docs/runbooks/build-plane.md`](../runbooks/build-plane.md) and ADR-0018.

The port is named Railpack and a Railpack adapter would drop in unchanged, but
the builder that actually runs is **Nixpacks**, because Nixpacks ships a
standalone CLI and Railpack does not.

### Phase C — Deployment pipeline (upload → build → classify → deploy)

Follow Vercel's three phases exactly:

- upload: Git source → object storage, with a deployment record
- build: enqueue a build job, stream logs, write artifact + metadata
- classify: static vs serverless vs edge output
- deploy: hand the artifact to the right runtime via `execution-router.ts`
- request: edge routes by the deployment metadata

Acceptance: a deployment runs the full path; each stage is visible in the
dashboard; a failure at any stage is reported honestly.

### Phase D — Preview deployments per branch (our win condition)

Research is consistent: **this is where every open-source Vercel alternative
lags furthest.** Vercel creates a unique URL per branch automatically, wires it
to deployment checks, and comments the URL on the pull request. This is the
single highest-value feature we can ship, because the alternatives do not.

- a deployment per branch/commit with its own immutable URL
- promotion from preview to production
- environment model (Local / Preview / Production) — the `environments` table
  already exists and is unused
- deployment protection for preview URLs (the D7 gap in the feature matrix) — **shipped**: `security.protection.get/save` per project, compiled onto each Envoy route fragment ahead of the firewall (`0030`, probe 28)

Acceptance: pushing a branch yields a preview URL; promoting it moves production
traffic; both are reversible.

### Phase E — Database section, unblocked

With ADR-0018 the Database differentiator stops being blocked. The seven
sub-pages become real against the Supabase-shaped data plane, read-only where
tenant row data is concerned.

Acceptance: table editor, SQL, auth, API, roles, logs and settings each do a real
thing or state honestly which engine operation is absent.

### Phase F — Security edge depth

The edge topology is already frozen (hidden origin, private address). This phase
adds depth: WAF rules, bot management, rate limits, DDoS posture, incident
surfacing. Must keep search-engine bots, ordinary scrapers, general users and
webhooks working while blocking attackers.

### Phase G — AWS proof

Deploy the whole thing and close gates 6–9 with real evidence: deny direct
origin, block CRS attacks, tenant runtime isolation, verified backup restore.
Only after this may the word "ready" be used.

## 5. Non-negotiables carried over

These are not up for change by any rewrite:

- **Honesty.** An unconfigured engine returns `not_configured`. Never a fake
  success. This is the product's only real asset.
- **Adapter boundary.** Routers never import an engine. Engines are reached only
  through `packages/adapters/*` ports (ADR-0001).
- **Tenant isolation.** Every new table keeps organization-scoped RLS.
- **Hidden origin.** The origin is never public; the edge is the front door.
- **No engine forks.** Engines are connected and customised, never copied in
  wholesale (ADR-0002).

## 6. Sources

- Vercel, "Behind the scenes of Vercel's infrastructure" (vercel.com/blog)
- Vercel, "A deep dive into Vercel's build infrastructure" (Hive, Nov 2023)
- Vercel docs: Builds, Functions, CDN; AWS Marketplace listing ("Deployed on AWS")
- Wikipedia, "Vercel" — infrastructure uses Amazon Web Services
- OpenNext (opennext.js.org) — Next.js serverless adapter; Deployment Adapter API
  stable in Next.js 16.2
- Railpack (successor to Nixpacks); Cloud Native Buildpacks / Paketo; herokuish
- Coolify docs, build packs overview (Nixpacks / Railpack / Dockerfile / compose)
- Firecracker, Kata Containers, gVisor — microVM isolation for multi-tenant
  untrusted workloads
