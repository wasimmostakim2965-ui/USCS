# Data engines and the security edge: where policy becomes engine syntax

- Status: accepted
- Date: 2026-09-22

## Context

ADR-0009 wired the hosting engine (Coolify). Phase 4 also calls for tenant
databases, tenant object storage and an edge that blocks CRS fixtures while the
origin stays unreachable except through it. This ADR records how the remaining
three are built, and the one schema correction that only appeared once the job
queue was implemented for real.

## Decisions

### 1. Tenant databases are provisioned through Coolify, not a separate engine

ADR-0001 already made Coolify the runtime. Coolify owns a database API
(`/databases/postgresql`, `/backups`, `/backups/{id}/executions`), so tenant
databases are managed through it rather than by a second provisioner. Two
consequences:

- There is no `DATABASE_ENGINE_URL`. Tenant databases share the organization's
  Coolify credentials, because they run inside Coolify's team boundary.
- Cloud Wai never opens a PostgreSQL connection to a tenant database. It holds no
  tenant data-plane credentials and has no reason to issue SQL. A rotated
  password is handed to the engine and is deliberately not returned to the
  caller, so a tenant credential never reaches an API response or a log line.

### 2. Object storage signs its own S3 requests

MinIO speaks the S3 API, so the adapter signs with SigV4 against the documented
bucket endpoints (`PUT`/`DELETE`/`HEAD /{bucket}`). SigV4 is implemented directly
(~60 lines of HMAC-SHA256 with a documented canonical-request layout) rather than
pulled in as a dependency, because a signing library would sit on the path of
every storage call and every credential.

Bucket names are namespaced by a hash of the organization id
(`cw-<sha256(org)[0:12]>-<slug>`), so a bucket name is never global, and
`deleteBucket` refuses a name that does not carry the organization's own prefix
before any request is sent.

### 3. The edge is a compiler, and hostile input is refused rather than escaped

`packages/adapters/src/security-edge.ts` is the only place Cloud Wai policy
becomes engine syntax. Coraza directives and the Envoy route fragment are
generated, never written by a caller. A route's host, path prefix and origin are
validated against a strict grammar; anything that does not match is rejected. The
origin must be a private address, because a public origin would be reachable
directly and the blueprint's rule is that it is not.

Policy distributions carry a monotonic version. When the edge rejects a
distribution as stale, the adapter reports `failed` — never `succeeded` — and the
generated config is deterministic, so the same policy always compiles to the same
bytes and a version is comparable.

### 4. The job queue's SQL constraint was wrong, and only a real database showed it

Implementing `packages/adapters/src/queue.ts` against the schema in
`0001_control_plane.sql` surfaced a divergence: the in-memory queue keys
idempotency on `(organizationId, kind, idempotencyKey)`, but the table's unique
constraint was `(organization_id, idempotency_key)`. The narrower constraint
rejects a job the in-memory queue accepts — two different operations sharing one
caller-supplied request id — so the two implementations would have disagreed in
production only.

Migration `0003_jobs_lease_and_idempotency.sql` widens the constraint to
`(organization_id, kind, idempotency_key)` and adds `worker_id`,
`lease_expires_at` and `max_attempts`, with partial indexes for claiming
(`state = 'queued'`) and lease reaping (`state = 'running'`).

## Evidence

Verified against a running PostgreSQL 17.11, with migrations `0001`–`0003`
applied in order:

- the existing isolation probe passes (7 scenarios, no cross-tenant access);
- `tests/isolation/rls/11_jobs_probe.sql` passes: the same key across two kinds
  is accepted, a duplicate `(org, kind, key)` is rejected, the key is independent
  across organizations, two workers never claim one job, a lapsed lease returns
  to `queued`, and no job is recorded `succeeded` without an engine result.

`pnpm verify` is green: 155 tests across 16 files, including 30 new engine tests
for Postgres, MinIO and the edge.

## Consequences

- The security edge adapter exists but no deployment points at a live Envoy and
  Coraza yet. Until one does, the engine report keeps saying `not_configured`,
  and the blueprint's CRS-fixture gate stays unverified — which is the honest
  state, not a completed one.
- Load, failure and disaster-recovery validation still need real engines.
